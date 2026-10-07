-- SmashPointOwner Phase 9.2: Owner-side court booking (customer, Owner-defined amount, cancellation metadata).
-- ADDITIVE ONLY: new nullable columns on owner_bookings + one lookup index. No data is rewritten.
-- Columns stay nullable at the DB level so Phase 9.1 fixture rows (which carry no customer) remain valid; the
-- service layer requires customer_name, customer_mobile and booking_amount on every booking it creates.
-- booking_amount is the AGREED amount only (Owner-entered, never calculated); it is NOT a payment (Phase 9.3).
BEGIN;

ALTER TABLE owner_bookings
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS customer_mobile text,
  ADD COLUMN IF NOT EXISTS booking_amount numeric(10, 2),
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text REFERENCES owner_profiles(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cancellation_reason text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_bookings_amount_check') THEN
    ALTER TABLE owner_bookings ADD CONSTRAINT owner_bookings_amount_check CHECK (booking_amount IS NULL OR booking_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_bookings_customer_name_check') THEN
    ALTER TABLE owner_bookings ADD CONSTRAINT owner_bookings_customer_name_check CHECK (customer_name IS NULL OR length(btrim(customer_name)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_bookings_mobile_check') THEN
    ALTER TABLE owner_bookings ADD CONSTRAINT owner_bookings_mobile_check CHECK (customer_mobile IS NULL OR customer_mobile ~ '^[0-9]{10}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'owner_bookings_cancel_meta_check') THEN
    -- cancellation metadata may only exist on a CANCELLED booking
    ALTER TABLE owner_bookings ADD CONSTRAINT owner_bookings_cancel_meta_check
      CHECK (status = 'CANCELLED' OR (cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS owner_bookings_academy_date_idx ON owner_bookings(academy_id, booking_date, start_time);

COMMIT;
