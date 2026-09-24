ALTER TABLE matches ADD COLUMN IF NOT EXISTS is_auto_advanced boolean NOT NULL DEFAULT false;
