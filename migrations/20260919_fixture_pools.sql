-- The app's DB role owns none of fixtures/tournaments/tournament_categories/matches/fixture_participants
-- (confirmed live: ALTER on any of them fails with "must be owner of table ..." / "permission denied for
-- table ..."), so this migration never touches those tables' schema. Everything new lives in tables this
-- role creates (and therefore owns), with plain text id columns instead of FKs into the tables it can't
-- reference, and application-level joins (see fixture.service.js) instead of a pool_id column on matches/
-- fixture_participants.
CREATE TABLE IF NOT EXISTS fixture_pools (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  fixture_id text NOT NULL,
  tournament_id text NOT NULL,
  category_id text NOT NULL,
  name text NOT NULL,
  pool_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_pools_fixture_idx ON fixture_pools(fixture_id);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_pools_fixture_name_idx ON fixture_pools(fixture_id, name);

-- Replaces a fixture_participants.pool_id column: which pool each participant belongs to.
CREATE TABLE IF NOT EXISTS fixture_pool_participants (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pool_id text NOT NULL REFERENCES fixture_pools(id) ON DELETE CASCADE,
  fixture_id text NOT NULL,
  participant_id text NOT NULL,
  participant_type text NOT NULL,
  seed_number integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_pool_participants_pool_idx ON fixture_pool_participants(pool_id);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_pool_participants_unique_idx ON fixture_pool_participants(fixture_id, participant_id);

-- Replaces a matches.pool_id column: which pool each match belongs to.
CREATE TABLE IF NOT EXISTS fixture_pool_matches (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pool_id text NOT NULL REFERENCES fixture_pools(id) ON DELETE CASCADE,
  fixture_id text NOT NULL,
  match_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixture_pool_matches_pool_idx ON fixture_pool_matches(pool_id);
CREATE UNIQUE INDEX IF NOT EXISTS fixture_pool_matches_unique_idx ON fixture_pool_matches(match_id);

-- League -> Knockout qualification/progression config + promotion linkage. Replaces what would otherwise be
-- qualifiers_per_pool/wildcard_count/best_third_place_count/target_knockout_bracket_size/promoted_to_fixture_id
-- columns on `fixtures` (not permitted — see above). One row per LEAGUE/ROUND_ROBIN fixture; promoted_to_fixture_id
-- makes promotion idempotent (re-promoting returns the existing knockout fixture instead of duplicating it).
CREATE TABLE IF NOT EXISTS fixture_qualification (
  fixture_id text PRIMARY KEY,
  qualifiers_per_pool integer NOT NULL DEFAULT 1,
  wildcard_count integer NOT NULL DEFAULT 0,
  best_third_place_count integer NOT NULL DEFAULT 0,
  target_knockout_bracket_size integer,
  promoted_to_fixture_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
