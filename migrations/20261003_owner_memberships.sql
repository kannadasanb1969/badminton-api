-- SmashPointOwner Phase 4: Members and Memberships.
-- ADDITIVE ONLY: creates owner_members and owner_memberships. No existing table is altered.
--
-- Member -> Membership -> Batch (history is kept; a batch is never stored on the member).
-- linked_user_id is optional and is never required: a court member does not need a SmashPoint login.
-- It only REFERENCES users(id); nothing in users / player_profiles is touched, and no user row is created.
--
-- Concurrency / integrity enforced by the database itself:
--   * one ACTIVE member per normalized mobile per academy       (owner_members_active_mobile_uidx)
--   * one ACTIVE membership per member per batch                (owner_memberships_active_member_batch_uidx)
--   * ACTIVE <=> end_date IS NULL, ENDED <=> end_date >= start_date (owner_memberships_state_check)
-- "Member and batch belong to the same academy" is enforced in owner-member.service.js under row locks
-- (a composite FK would require altering owner_batches).
BEGIN;

CREATE TABLE IF NOT EXISTS owner_members (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  linked_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  mobile text CHECK (mobile IS NULL OR mobile ~ '^[0-9]{10}$'),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_members_academy_idx ON owner_members(academy_id);
CREATE INDEX IF NOT EXISTS owner_members_linked_user_idx ON owner_members(linked_user_id) WHERE linked_user_id IS NOT NULL;
-- Mobile is academy-scoped (never globally unique). Members without a mobile are never treated as duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS owner_members_active_mobile_uidx
  ON owner_members(academy_id, mobile) WHERE mobile IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS owner_memberships (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  member_id text NOT NULL REFERENCES owner_members(id) ON DELETE RESTRICT,
  batch_id text NOT NULL REFERENCES owner_batches(id) ON DELETE RESTRICT,
  start_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ENDED')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_memberships_state_check CHECK (
    (status = 'ACTIVE' AND end_date IS NULL) OR (status = 'ENDED' AND end_date IS NOT NULL AND end_date >= start_date)
  )
);
CREATE INDEX IF NOT EXISTS owner_memberships_member_idx ON owner_memberships(member_id);
CREATE INDEX IF NOT EXISTS owner_memberships_batch_active_idx ON owner_memberships(batch_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS owner_memberships_active_member_batch_uidx
  ON owner_memberships(member_id, batch_id) WHERE status = 'ACTIVE';

COMMIT;
