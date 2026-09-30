BEGIN;

-- Second entry path into the same friendly_match_participants domain (see
-- friendly_match_requests for the existing player-initiated path). An invitation is
-- creator-initiated instead of player-initiated, so it needs its own status lifecycle
-- and its own duplicate-prevention index rather than reusing friendly_match_requests.
CREATE TABLE IF NOT EXISTS friendly_match_invitations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  inviter_player_id text NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  invited_player_id text NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  responded_at timestamptz,
  CONSTRAINT friendly_match_invitations_no_self CHECK (inviter_player_id <> invited_player_id)
);

-- Mirrors friendly_active_request_uq's shape: only PENDING blocks a duplicate, so a
-- fresh invitation can always be sent after a DECLINED one (history is kept, not reused).
CREATE UNIQUE INDEX IF NOT EXISTS friendly_match_invitation_active_uq
  ON friendly_match_invitations(friendly_match_id, invited_player_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS friendly_match_invitations_match_idx ON friendly_match_invitations(friendly_match_id);
CREATE INDEX IF NOT EXISTS friendly_match_invitations_invited_idx ON friendly_match_invitations(invited_player_id);

COMMIT;
