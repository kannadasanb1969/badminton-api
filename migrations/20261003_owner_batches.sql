-- SmashPointOwner Phase 3: one common batch model (REGULAR and COACHING share this table).
-- ADDITIVE ONLY: creates owner_batches. No existing table is altered.
-- Batches reference the single shared owner_courts entity (no per-type court tables).
-- Times are plain "time of day" within one calendar day (no operational-day offset, no fixed slots).
-- fee_per_person is Owner-entered exact money (numeric, never float); there is intentionally no default.
-- Overlap between ACTIVE batches on one court is enforced server-side under a court-row lock
-- (see owner-batch.service.js); no exclusion constraint is used because it would need CREATE EXTENSION btree_gist.
BEGIN;

CREATE TABLE IF NOT EXISTS owner_batches (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  court_id text NOT NULL REFERENCES owner_courts(id) ON DELETE RESTRICT,
  batch_type text NOT NULL CHECK (batch_type IN ('REGULAR', 'COACHING')),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  start_time time NOT NULL,
  end_time time NOT NULL,
  fee_per_person numeric(10, 2) NOT NULL CHECK (fee_per_person >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_batches_time_order CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS owner_batches_academy_idx ON owner_batches(academy_id);
CREATE INDEX IF NOT EXISTS owner_batches_court_active_idx ON owner_batches(court_id, start_time) WHERE status = 'ACTIVE';

COMMIT;
