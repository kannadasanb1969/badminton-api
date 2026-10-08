-- SmashPointOwner Phase 5: effective-dated fee rates, monthly leave, monthly fee obligations.
-- ADDITIVE, SCHEMA ONLY: creates three new Owner tables plus one guard function/trigger that belongs to
-- owner_fee_rates. No existing table (users, owner_batches, ...) is altered and no data is inserted or changed.
-- Initial rates for pre-existing batches are created by scripts/bootstrap-owner-fee-rates.mjs, not here.
--
-- Money is numeric(10,2). The Owner always supplies every amount: there is no default fee anywhere.
-- Months are stored as the first day of the month (DATE); all fee periods are whole months.
--
-- Integrity enforced by the database itself:
--   * one rate per batch per effective_from, and at most one open-ended rate per batch
--   * NO overlapping rate periods for a batch (trigger owner_fee_rates_no_overlap; an exclusion constraint
--     would need CREATE EXTENSION btree_gist, which is deliberately not used)
--   * one leave per membership per month
--   * one monthly fee obligation per membership per month; ON_LEAVE <=> applicable_fee = 0
BEGIN;

CREATE TABLE IF NOT EXISTS owner_fee_rates (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  batch_id text NOT NULL REFERENCES owner_batches(id) ON DELETE RESTRICT,
  fee_amount numeric(10, 2) NOT NULL CHECK (fee_amount >= 0),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_fee_rates_from_first_of_month CHECK (EXTRACT(DAY FROM effective_from) = 1),
  -- inclusive end date: the last day of a month (the day after it is the 1st)
  CONSTRAINT owner_fee_rates_to_end_of_month CHECK (
    effective_to IS NULL OR (effective_to >= effective_from AND EXTRACT(DAY FROM effective_to + 1) = 1)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_fee_rates_batch_from_uidx ON owner_fee_rates(batch_id, effective_from);
CREATE UNIQUE INDEX IF NOT EXISTS owner_fee_rates_batch_open_uidx ON owner_fee_rates(batch_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS owner_fee_rates_batch_period_idx ON owner_fee_rates(batch_id, effective_from, effective_to);

-- Authoritative overlap guard, also for writers that bypass the service layer. It first locks the batch row so
-- concurrent writers for one batch are serialised, then rejects any overlapping period (SQLSTATE 23P01).
CREATE OR REPLACE FUNCTION owner_fee_rates_guard() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM owner_batches WHERE id = NEW.batch_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM owner_fee_rates r
    WHERE r.batch_id = NEW.batch_id AND r.id <> NEW.id
      AND r.effective_from <= COALESCE(NEW.effective_to, 'infinity'::date)
      AND COALESCE(r.effective_to, 'infinity'::date) >= NEW.effective_from
  ) THEN
    RAISE EXCEPTION 'owner_fee_rates: effective period overlaps an existing rate for this batch'
      USING ERRCODE = '23P01', CONSTRAINT = 'owner_fee_rates_no_overlap';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_fee_rates_no_overlap
  BEFORE INSERT OR UPDATE ON owner_fee_rates
  FOR EACH ROW EXECUTE FUNCTION owner_fee_rates_guard();

-- Leave belongs to ONE membership for ONE month (a person's Regular and Coaching memberships are independent).
CREATE TABLE IF NOT EXISTS owner_monthly_leaves (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  membership_id text NOT NULL REFERENCES owner_memberships(id) ON DELETE RESTRICT,
  fee_month date NOT NULL CHECK (EXTRACT(DAY FROM fee_month) = 1),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_monthly_leaves_membership_month_uidx ON owner_monthly_leaves(membership_id, fee_month);

-- One canonical obligation per membership per month. applicable_fee is a historical SNAPSHOT: later fee-rate
-- changes never rewrite it. Statuses are PENDING / ON_LEAVE only; payment-aware statuses arrive with Phase 6.
CREATE TABLE IF NOT EXISTS owner_monthly_fees (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  membership_id text NOT NULL REFERENCES owner_memberships(id) ON DELETE RESTRICT,
  fee_month date NOT NULL CHECK (EXTRACT(DAY FROM fee_month) = 1),
  applicable_fee numeric(10, 2) NOT NULL CHECK (applicable_fee >= 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'ON_LEAVE')),
  fee_rate_id text REFERENCES owner_fee_rates(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_monthly_fees_leave_is_zero CHECK (status <> 'ON_LEAVE' OR applicable_fee = 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS owner_monthly_fees_membership_month_uidx ON owner_monthly_fees(membership_id, fee_month);
CREATE INDEX IF NOT EXISTS owner_monthly_fees_month_idx ON owner_monthly_fees(fee_month);

COMMIT;
