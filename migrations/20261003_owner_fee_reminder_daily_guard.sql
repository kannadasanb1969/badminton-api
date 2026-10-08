-- Phase 8.1: scope-independent daily dispatch guard. Phase-8 history stays immutable.
-- A stronger history index would reject existing same-day, different-scope DRY_RUN rows.
-- Instead, keep the original history index and reserve one Owner-only daily slot.
BEGIN;

-- Prevent dispatch/completion racing the backfill and trigger installation.
LOCK TABLE owner_fee_reminders IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS owner_fee_reminder_daily_claims (
  academy_id text NOT NULL,
  member_id text NOT NULL,
  reminder_date date NOT NULL,
  reminder_id text NOT NULL UNIQUE REFERENCES owner_fee_reminders(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (academy_id, member_id, reminder_date)
);

-- Completed successes take precedence over in-flight legacy attempts. Preserve every history row.
INSERT INTO owner_fee_reminder_daily_claims (academy_id, member_id, reminder_date, reminder_id, created_at)
SELECT DISTINCT ON (academy_id, member_id, reminder_date)
  academy_id, member_id, reminder_date, id, created_at
FROM owner_fee_reminders
WHERE status IN ('SENDING', 'SENT', 'DRY_RUN')
ORDER BY academy_id, member_id, reminder_date, (status = 'SENDING'), created_at, id
ON CONFLICT (academy_id, member_id, reminder_date) DO NOTHING;

-- Reserve before INSERT so a losing caller receives no history row, even on a different scope.
-- The deferred FK permits the claim and its history row to be inserted in this same statement.
CREATE OR REPLACE FUNCTION owner_fee_reminder_reserve_day() RETURNS trigger AS $$
DECLARE reserved text;
BEGIN
  IF NEW.status IN ('SENDING', 'SENT', 'DRY_RUN') THEN
    INSERT INTO owner_fee_reminder_daily_claims (academy_id, member_id, reminder_date, reminder_id, created_at)
    VALUES (NEW.academy_id, NEW.member_id, NEW.reminder_date, NEW.id, NEW.created_at)
    ON CONFLICT (academy_id, member_id, reminder_date) DO NOTHING
    RETURNING reminder_id INTO reserved;
    IF reserved IS NULL THEN RETURN NULL; END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_fee_reminder_reserve_day_trg
  BEFORE INSERT ON owner_fee_reminders FOR EACH ROW EXECUTE FUNCTION owner_fee_reminder_reserve_day();

-- Failure, including the existing ABANDONED recovery, frees only that attempt's slot.
-- A late completion cannot free a replacement attempt's slot.
CREATE OR REPLACE FUNCTION owner_fee_reminder_release_failed_day() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'FAILED' THEN
    DELETE FROM owner_fee_reminder_daily_claims WHERE reminder_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_fee_reminder_release_failed_day_trg
  AFTER UPDATE ON owner_fee_reminders FOR EACH ROW EXECUTE FUNCTION owner_fee_reminder_release_failed_day();

COMMIT;
