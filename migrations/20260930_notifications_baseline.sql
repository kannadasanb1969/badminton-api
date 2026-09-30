BEGIN;

-- Phase 2 built the Notification Centre against a `notifications` table that already existed in
-- both LOCAL and (per the original Phase 2 audit) production, applied directly against the DB
-- outside the tracked migrations/ folder — no migration file existed to reproduce it. This file
-- is that missing baseline, written from the LIVE LOCAL schema (columns/indexes/constraints
-- confirmed via information_schema + pg_indexes in the Phase 5 migration audit), using
-- IF NOT EXISTS throughout so it is a no-op wherever the table/indexes already exist (LOCAL and,
-- when eventually applied, production) and only creates them from scratch in a genuinely fresh
-- environment. It must never be run as a destructive create/drop — see the safety rule above.
--
-- OWNERSHIP — tested against LOCAL (Phase 5A), root cause pinpointed statement-by-statement:
--   FRESH DATABASE (table does not exist yet): this migration succeeds completely when run as the
--   app's normal role (badminton_api_user) — CREATE TABLE makes that role the owner, so the two
--   CREATE INDEX statements that follow succeed too. No special access needed.
--   EXISTING DATABASE UPGRADE (this is LOCAL's actual situation today, and — since notifications
--   was created the same out-of-band way — is presumed to be production's situation too):
--   `CREATE TABLE IF NOT EXISTS` succeeds as a harmless no-op regardless of who owns the existing
--   table. But `CREATE INDEX IF NOT EXISTS` unconditionally requires ownership of the target
--   table in Postgres — IF NOT EXISTS only suppresses the "index already exists" error, it does
--   NOT bypass the ownership check, which is evaluated first. Confirmed live: running the two
--   CREATE INDEX statements as badminton_api_user against LOCAL (table owned by neondb_owner)
--   fails with "must be owner of table notifications" for BOTH index statements, while the
--   CREATE TABLE statement alone succeeds. Since idx_notifications_recipient and
--   uq_notifications_dedupe already exist (created out-of-band alongside the table), no indexing
--   functionality is actually missing on an existing-upgrade target — this migration simply
--   cannot re-assert them under the app's own role. Running the full file (including the index
--   statements) against an existing, differently-owned database requires the table-owning role
--   (e.g. neondb_owner on this Neon project), not the app's normal migration path.
--   No data is at risk either way: this file never drops/alters/truncates notifications.
CREATE TABLE IF NOT EXISTS notifications (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipient_id   text NOT NULL,
  recipient_role varchar NOT NULL CHECK (recipient_role IN ('PLAYER', 'ORGANIZER', 'ADMIN')),
  type           varchar NOT NULL,
  title          varchar NOT NULL,
  message        text NOT NULL,
  is_read        boolean NOT NULL DEFAULT false,
  read_at        timestamptz,
  link           text,
  tournament_id  text REFERENCES tournaments(id) ON DELETE CASCADE,
  category_id    text REFERENCES tournament_categories(id) ON DELETE CASCADE,
  match_id       text REFERENCES matches(id) ON DELETE CASCADE,
  dedupe_key     varchar,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient
  ON notifications (recipient_id, is_read, created_at DESC);

-- Backs emit()'s idempotent "SELECT ... WHERE NOT EXISTS" insert (notification.events.js) — the
-- same duplicate-prevention guarantee relied on by Phase 2/3's dedupe tests.
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_dedupe
  ON notifications (recipient_id, dedupe_key) WHERE (dedupe_key IS NOT NULL);

COMMIT;
