-- SmashPointOwner Phase 9.1: court booking foundation (Owner domain only, additive, non-destructive).
--
-- 1. owner_batches gains calendar applicability: days_of_week (ISO 1=Mon..7=Sun), effective_from, effective_to.
--    Legacy rows are backfilled by the column default to Monday-Sunday with NO date bounds (both NULL = unbounded),
--    which is exactly the behaviour they had before. No dates are inferred from memberships/fees/payments.
-- 2. owner_batch_exceptions: history-preserving one-day "RELEASED" exceptions for a recurring batch.
-- 3. owner_bookings: booking foundation for Phase 9.2 (no customer / pricing / payment data yet).
-- 4. owner_court_blocks: maintenance / owner blocks, cancelled rather than deleted.
--
-- Times are Postgres `time` within ONE calendar day. An interval END may be 24:00 (end of day, natively valid for
-- `time`); a START is always < 24:00 because start < end. No overnight intervals, no fixed slots.
-- Overlap everywhere: new_start < existing_end AND new_end > existing_start (touching boundaries allowed).
BEGIN;

-- strictly ascending => unique and deterministic ordering; values 1..7; at least one day.
CREATE OR REPLACE FUNCTION owner_valid_weekdays(d smallint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT d IS NOT NULL AND array_ndims(d) = 1 AND cardinality(d) BETWEEN 1 AND 7 AND NOT EXISTS (
    SELECT 1 FROM generate_subscripts(d, 1) i
    WHERE d[i] IS NULL OR d[i] NOT BETWEEN 1 AND 7 OR (i > 1 AND d[i] <= d[i - 1]))
$$;

ALTER TABLE owner_batches
  ADD COLUMN IF NOT EXISTS days_of_week smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::smallint[],
  ADD COLUMN IF NOT EXISTS effective_from date,
  ADD COLUMN IF NOT EXISTS effective_to date;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_batches_days_of_week_check') THEN
    ALTER TABLE owner_batches ADD CONSTRAINT owner_batches_days_of_week_check CHECK (owner_valid_weekdays(days_of_week));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_batches_effective_order') THEN
    ALTER TABLE owner_batches ADD CONSTRAINT owner_batches_effective_order
      CHECK (effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS owner_batch_exceptions (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  batch_id text NOT NULL REFERENCES owner_batches(id) ON DELETE RESTRICT,
  exception_date date NOT NULL,
  exception_type text NOT NULL DEFAULT 'RELEASED' CHECK (exception_type IN ('RELEASED')),
  -- ACTIVE = the release is in force; RESTORED = the Owner restored the occurrence (row kept as history).
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RESTORED')),
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  created_by text REFERENCES owner_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  restored_at timestamptz,
  CONSTRAINT owner_batch_exceptions_restore_consistent CHECK ((status = 'RESTORED') = (restored_at IS NOT NULL))
);
-- at most one LIVE release per batch + calendar date (history rows may repeat)
CREATE UNIQUE INDEX IF NOT EXISTS owner_batch_exceptions_live_uq
  ON owner_batch_exceptions(batch_id, exception_date) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS owner_batch_exceptions_academy_date_idx ON owner_batch_exceptions(academy_id, exception_date);

-- Booking foundation. Statuses: PENDING and CONFIRMED BLOCK availability (a pending hold must hold the court);
-- CANCELLED does not. Customer, amount and payment columns are intentionally deferred to Phase 9.2.
CREATE TABLE IF NOT EXISTS owner_bookings (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  court_id text NOT NULL REFERENCES owner_courts(id) ON DELETE RESTRICT,
  booking_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED')),
  created_by text REFERENCES owner_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_bookings_time_order CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS owner_bookings_court_date_idx ON owner_bookings(court_id, booking_date, start_time) WHERE status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS owner_bookings_academy_idx ON owner_bookings(academy_id);

CREATE TABLE IF NOT EXISTS owner_court_blocks (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  court_id text NOT NULL REFERENCES owner_courts(id) ON DELETE RESTRICT,
  block_date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  reason text CHECK (reason IS NULL OR length(reason) <= 200),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_by text REFERENCES owner_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  cancelled_at timestamptz,
  CONSTRAINT owner_court_blocks_time_order CHECK (start_time < end_time),
  CONSTRAINT owner_court_blocks_cancel_consistent CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS owner_court_blocks_court_date_idx ON owner_court_blocks(court_id, block_date, start_time) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS owner_court_blocks_academy_idx ON owner_court_blocks(academy_id);

COMMIT;
