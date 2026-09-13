-- Friendly Match domain is intentionally isolated from official tournaments/results/medals.
CREATE TABLE IF NOT EXISTS friendly_matches (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_code varchar NOT NULL UNIQUE,
  title varchar NOT NULL,
  description text,
  creator_player_id text NOT NULL REFERENCES player_profiles(id),
  event_type varchar NOT NULL CHECK (event_type IN ('SINGLES','DOUBLES')),
  format varchar NOT NULL CHECK (format IN ('LEAGUE','KNOCKOUT')),
  max_players integer NOT NULL CHECK (max_players BETWEEN 6 AND 16),
  status varchar NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','OPEN','ACTIVE','COMPLETED','CLEANUP_PENDING','DELETED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (event_type <> 'DOUBLES' OR (max_players >= 8 AND max_players % 2 = 0))
);

CREATE TABLE IF NOT EXISTS friendly_match_requests (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES player_profiles(id),
  status varchar NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS friendly_active_request_uq ON friendly_match_requests(friendly_match_id,player_id) WHERE status IN ('PENDING','APPROVED');

CREATE TABLE IF NOT EXISTS friendly_match_participants (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES player_profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(friendly_match_id,player_id)
);

CREATE TABLE IF NOT EXISTS friendly_match_teams (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  team_code varchar NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(friendly_match_id,team_code)
);
CREATE TABLE IF NOT EXISTS friendly_match_team_members (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id text NOT NULL REFERENCES friendly_match_teams(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES player_profiles(id), UNIQUE(team_id,player_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS friendly_player_one_team_uq ON friendly_match_team_members(player_id,team_id);

CREATE TABLE IF NOT EXISTS friendly_fixtures (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  fixture_code varchar NOT NULL UNIQUE, format varchar NOT NULL CHECK(format IN ('LEAGUE','KNOCKOUT')),
  status varchar NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PUBLISHED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS friendly_fixture_participants (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  fixture_id text NOT NULL REFERENCES friendly_fixtures(id) ON DELETE CASCADE,
  participant_id text NOT NULL, participant_type varchar NOT NULL CHECK(participant_type IN ('PLAYER','TEAM')),
  seed_number integer, display_name varchar, UNIQUE(fixture_id,participant_id,participant_type)
);
CREATE TABLE IF NOT EXISTS friendly_game_matches (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  fixture_id text NOT NULL REFERENCES friendly_fixtures(id) ON DELETE CASCADE,
  match_code varchar NOT NULL UNIQUE, round_number integer NOT NULL, match_number integer NOT NULL,
  status varchar NOT NULL DEFAULT 'SCHEDULED' CHECK(status IN ('SCHEDULED','LIVE','COMPLETED')),
  participant1_id text, participant1_type varchar CHECK(participant1_type IN ('PLAYER','TEAM')),
  participant2_id text, participant2_type varchar CHECK(participant2_type IN ('PLAYER','TEAM')),
  participant1_score integer NOT NULL DEFAULT 0 CHECK(participant1_score>=0), participant2_score integer NOT NULL DEFAULT 0 CHECK(participant2_score>=0),
  winning_points integer CHECK(winning_points IN (15,21,30)), winner_id text, winner_type varchar CHECK(winner_type IN ('PLAYER','TEAM')),
  source_match_1_id text REFERENCES friendly_game_matches(id) ON DELETE SET NULL, source_match_2_id text REFERENCES friendly_game_matches(id) ON DELETE SET NULL,
  next_match_id text REFERENCES friendly_game_matches(id) ON DELETE SET NULL, next_match_slot integer CHECK(next_match_slot IN (1,2)),
  started_at timestamptz, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(fixture_id,round_number,match_number)
);
CREATE TABLE IF NOT EXISTS friendly_match_score_history (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, match_id text NOT NULL REFERENCES friendly_game_matches(id) ON DELETE CASCADE,
  participant1_score integer NOT NULL, participant2_score integer NOT NULL, action varchar NOT NULL, actor_player_id text REFERENCES player_profiles(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS friendly_results (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text, friendly_match_id text NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  match_id text NOT NULL REFERENCES friendly_game_matches(id) ON DELETE CASCADE, winner_id text NOT NULL, winner_type varchar NOT NULL CHECK(winner_type IN ('PLAYER','TEAM')),
  runner_up_id text, runner_up_type varchar CHECK(runner_up_type IN ('PLAYER','TEAM')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(friendly_match_id)
);
CREATE INDEX IF NOT EXISTS friendly_matches_creator_idx ON friendly_matches(creator_player_id);
CREATE INDEX IF NOT EXISTS friendly_matches_status_idx ON friendly_matches(status);
CREATE INDEX IF NOT EXISTS friendly_requests_match_status_idx ON friendly_match_requests(friendly_match_id,status);
CREATE INDEX IF NOT EXISTS friendly_participants_player_idx ON friendly_match_participants(player_id);
CREATE INDEX IF NOT EXISTS friendly_games_fixture_idx ON friendly_game_matches(fixture_id);
CREATE INDEX IF NOT EXISTS friendly_games_source_idx ON friendly_game_matches(source_match_1_id,source_match_2_id);
