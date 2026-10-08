-- Cross-app sign-in handoff (SmashPoint -> SmashPoint Owner). ADDITIVE ONLY: one new table, no existing table is altered.
-- A signed-in user asks for a short-lived, single-use code; the target app exchanges it (without any token) for its OWN
-- normal auth_sessions session. Only the SHA-256 hash of the code is stored, never the code itself.
-- The code lives 60 seconds and is consumed atomically (UPDATE ... WHERE consumed_at IS NULL), so it cannot be replayed.
-- No users.role is read or written here: "Owner" is a target application, not a global role.
BEGIN;

CREATE TABLE IF NOT EXISTS auth_app_handoffs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_app text NOT NULL CHECK (target_app IN ('OWNER')),
  code_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT auth_app_handoffs_expiry_after_create CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS auth_app_handoffs_user_open_idx ON auth_app_handoffs(user_id) WHERE consumed_at IS NULL;

COMMIT;
