-- Adds structured registration-fee and prize (trophy/cash) metadata to tournaments.
-- All new columns are nullable or safely defaulted so existing tournament rows keep loading
-- unchanged; the legacy free-text `prizes` column is left untouched for backward compatibility.
ALTER TABLE tournaments
  ADD COLUMN IF NOT EXISTS registration_fee numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prize_type varchar NOT NULL DEFAULT 'NONE' CHECK (prize_type IN ('NONE','TROPHY','CASH','BOTH')),
  ADD COLUMN IF NOT EXISTS winner_trophy_name varchar,
  ADD COLUMN IF NOT EXISTS runner_up_trophy_name varchar,
  ADD COLUMN IF NOT EXISTS third_place_trophy_name varchar,
  ADD COLUMN IF NOT EXISTS winner_cash_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS runner_up_cash_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS third_place_cash_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS third_place_enabled boolean NOT NULL DEFAULT false;
