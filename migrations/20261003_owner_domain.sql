-- SmashPointOwner Phase 2: Owner profile, academy and dynamic courts.
-- ADDITIVE ONLY: creates three new tables. Does not alter users or any existing SmashPoint table.
-- Owner capability is a separate profile row; users.role is never touched.
BEGIN;

CREATE TABLE IF NOT EXISTS owner_profiles (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS owner_academies (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  owner_profile_id text NOT NULL REFERENCES owner_profiles(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  mobile text,
  address text,
  area text,
  city text,
  state text,
  pincode text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_academies_owner_idx ON owner_academies(owner_profile_id);

-- One shared Court entity: future batches, bookings and court blocks all reference owner_courts(id).
-- Courts are never hard-deleted by the app; status carries active/inactive.
CREATE TABLE IF NOT EXISTS owner_courts (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  display_order integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_courts_academy_idx ON owner_courts(academy_id);
-- No two ACTIVE courts in one academy may share a name (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS owner_courts_active_name_uidx
  ON owner_courts(academy_id, lower(btrim(name))) WHERE status = 'ACTIVE';

COMMIT;
