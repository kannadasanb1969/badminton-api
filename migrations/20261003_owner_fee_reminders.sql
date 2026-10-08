-- SmashPointOwner Phase 8: fee reminder history and same-day duplicate protection.
-- ADDITIVE ONLY: one new table. No existing table is altered, no data is inserted or changed.
--
-- One row = one reminder DISPATCH ATTEMPT for one member (a consolidated message covering all of that member's outstanding items in
-- the reminder scope). Skips that happen before dispatch (paid, on leave, missing mobile, already reminded) are returned to the caller
-- and are not stored: history only holds attempts that were actually made.
--
-- Status is truthful: SENDING (claimed, provider not answered yet) -> SENT (provider accepted) | DRY_RUN (test adapter, nothing was
-- delivered) | FAILED. A dry run is never SENT.
--
-- Duplicate protection lives in the database: a partial unique index allows at most ONE live row (SENDING / SENT / DRY_RUN) per
-- (academy, member, local date, scope). FAILED rows do not hold the slot, so a failed attempt can be retried the same day.
-- scope_key examples: 'ALL_OUTSTANDING', 'MONTH:2026-10-01', 'MONTH:2026-10-01|court:<id>|type:COACHING'.
--
-- Audit: a row is immutable except for its single completion step (SENDING -> final status plus the provider outcome fields).
-- Rows cannot be deleted by the application; test cleanup uses an explicit transaction-local switch the application never sets.
BEGIN;

CREATE TABLE IF NOT EXISTS owner_fee_reminders (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  member_id text NOT NULL REFERENCES owner_members(id) ON DELETE RESTRICT,
  scope_key text NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 300),
  reminder_date date NOT NULL,
  sender_number text NOT NULL,
  recipient_number text NOT NULL,
  message_body text NOT NULL CHECK (length(message_body) > 0),
  total_outstanding numeric(10, 2) NOT NULL CHECK (total_outstanding > 0),
  item_count integer NOT NULL CHECK (item_count > 0),
  status text NOT NULL DEFAULT 'SENDING' CHECK (status IN ('SENDING', 'SENT', 'FAILED', 'DRY_RUN')),
  provider text NOT NULL,
  provider_message_id text,
  failure_code text,
  failure_message text CHECK (failure_message IS NULL OR length(failure_message) <= 300),
  sent_at timestamptz,
  completed_at timestamptz,
  created_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_fee_reminders_outcome_check CHECK (
    (status = 'SENDING' AND completed_at IS NULL AND sent_at IS NULL)
    OR (status = 'SENT' AND completed_at IS NOT NULL AND sent_at IS NOT NULL)
    OR (status = 'DRY_RUN' AND completed_at IS NOT NULL AND sent_at IS NULL)
    OR (status = 'FAILED' AND completed_at IS NOT NULL AND sent_at IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS owner_fee_reminders_one_live_per_day_uidx
  ON owner_fee_reminders(academy_id, member_id, reminder_date, scope_key) WHERE status IN ('SENDING', 'SENT', 'DRY_RUN');
CREATE INDEX IF NOT EXISTS owner_fee_reminders_academy_idx ON owner_fee_reminders(academy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS owner_fee_reminders_member_idx ON owner_fee_reminders(member_id, created_at DESC);

CREATE OR REPLACE FUNCTION owner_fee_reminders_audit() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('smashpoint.owner_reminder_cleanup', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'owner_fee_reminders rows cannot be deleted' USING ERRCODE = '23000';
  END IF;
  -- UPDATE: only the single completion step SENDING -> SENT / DRY_RUN / FAILED, and only the outcome columns may change.
  IF OLD.status <> 'SENDING' THEN
    RAISE EXCEPTION 'owner_fee_reminders history is immutable once completed' USING ERRCODE = '23000';
  END IF;
  IF NEW.status = 'SENDING' THEN
    RAISE EXCEPTION 'a reminder attempt must complete with a final status' USING ERRCODE = '23000';
  END IF;
  IF (NEW.id, NEW.academy_id, NEW.member_id, NEW.scope_key, NEW.reminder_date, NEW.sender_number, NEW.recipient_number,
      NEW.message_body, NEW.total_outstanding, NEW.item_count, NEW.provider, NEW.created_by_user_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.academy_id, OLD.member_id, OLD.scope_key, OLD.reminder_date, OLD.sender_number, OLD.recipient_number,
      OLD.message_body, OLD.total_outstanding, OLD.item_count, OLD.provider, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'owner_fee_reminders content is immutable' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_fee_reminders_audit_trg
  BEFORE UPDATE OR DELETE ON owner_fee_reminders FOR EACH ROW EXECUTE FUNCTION owner_fee_reminders_audit();

COMMIT;
