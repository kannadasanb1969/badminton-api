BEGIN;

CREATE TABLE IF NOT EXISTS player_connections (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  requester_player_id text NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  recipient_player_id text NOT NULL REFERENCES player_profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED')),
  pair_low_player_id text GENERATED ALWAYS AS (LEAST(requester_player_id, recipient_player_id)) STORED,
  pair_high_player_id text GENERATED ALWAYS AS (GREATEST(requester_player_id, recipient_player_id)) STORED,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  accepted_at timestamptz,
  CONSTRAINT player_connections_no_self CHECK (requester_player_id <> recipient_player_id),
  CONSTRAINT player_connections_pair_unique UNIQUE (pair_low_player_id, pair_high_player_id)
);

CREATE INDEX IF NOT EXISTS player_connections_requester_idx ON player_connections(requester_player_id);
CREATE INDEX IF NOT EXISTS player_connections_recipient_idx ON player_connections(recipient_player_id);
CREATE INDEX IF NOT EXISTS player_connections_status_idx ON player_connections(status);

COMMIT;
