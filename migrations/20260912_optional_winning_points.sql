-- Existing matches retain their selected limit. New scheduled matches start unselected.
BEGIN;
ALTER TABLE matches ALTER COLUMN winning_points DROP NOT NULL;
ALTER TABLE matches ALTER COLUMN winning_points DROP DEFAULT;
COMMIT;
