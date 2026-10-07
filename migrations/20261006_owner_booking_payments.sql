-- SmashPointOwner Phase 9.3: manual court-booking payments, per-payment receipts, receipt counters.
--
-- ADDITIVE ONLY: two new tables, three new functions/triggers. No existing table is altered (owner_bookings, owner_payments,
-- owner_payment_allocations, owner_monthly_fees, owner_receipt_counters and users are untouched).
--
-- Separate from Phase 6: booking money is a different obligation from monthly fees, so it lives in its own tables and its own
-- receipt book (SPB-YYYY-NNNNNN, Phase 6 uses SPO-YYYY-NNNNNN). No payment gateway: rows are MANUAL records only.
--
-- Accounting model
--   * owner_booking_payments  immutable money-received records; each row IS one receipt and carries its transaction-time snapshot
--   * booking paid / balance / payment status are DERIVED from these rows (nothing mutable is stored on owner_bookings)
--   * the guard trigger is authoritative: it locks the booking row, rejects CANCELLED bookings and overpayment, and OVERWRITES the
--     snapshot columns with values it computes itself, so no writer (service or otherwise) can store a wrong snapshot
--   * rows cannot be UPDATEd, and cannot be DELETEd (test/dev cleanup uses an explicit transaction-local switch that the app never sets)
BEGIN;

CREATE TABLE IF NOT EXISTS owner_booking_receipt_counters (
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  receipt_year integer NOT NULL CHECK (receipt_year BETWEEN 2000 AND 9999),
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (academy_id, receipt_year)
);

CREATE TABLE IF NOT EXISTS owner_booking_payments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  booking_id text NOT NULL REFERENCES owner_bookings(id) ON DELETE RESTRICT,
  receipt_number text NOT NULL,
  amount numeric(10, 2) NOT NULL CHECK (amount > 0),
  payment_mode text NOT NULL CHECK (payment_mode IN ('CASH', 'UPI', 'BANK_TRANSFER', 'OTHER')),
  payment_date date NOT NULL,
  reference_number text CHECK (reference_number IS NULL OR length(reference_number) <= 200),
  note text CHECK (note IS NULL OR length(note) <= 300),
  -- transaction-time receipt snapshot (computed by the guard trigger; the values passed on INSERT are ignored)
  booking_amount_snapshot numeric(10, 2) NOT NULL DEFAULT 0,
  total_paid_after numeric(10, 2) NOT NULL DEFAULT 0,
  balance_after numeric(10, 2) NOT NULL DEFAULT 0,
  payment_status_after text NOT NULL DEFAULT 'PENDING' CHECK (payment_status_after IN ('PARTIALLY_PAID', 'PAID', 'PENDING')),
  created_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_booking_payments_receipt_uidx UNIQUE (academy_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS owner_booking_payments_booking_idx ON owner_booking_payments(booking_id, created_at, id);
CREATE INDEX IF NOT EXISTS owner_booking_payments_academy_idx ON owner_booking_payments(academy_id, payment_date);

-- Immutability. DELETE only inside a transaction that sets smashpoint.owner_booking_payment_cleanup = 'on' (test cleanup only).
CREATE OR REPLACE FUNCTION owner_booking_payment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('smashpoint.owner_booking_payment_cleanup', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'owner booking payments are immutable (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = '23000';
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_booking_payments_immutable
  BEFORE UPDATE OR DELETE ON owner_booking_payments FOR EACH ROW EXECUTE FUNCTION owner_booking_payment_immutable();

-- Authoritative guard + snapshot. Lock order inside this trigger: booking row (FOR UPDATE) only. The service has already taken
-- the same row lock, so this is re-entrant for it and protective for any other writer.
CREATE OR REPLACE FUNCTION owner_booking_payment_guard() RETURNS trigger AS $$
DECLARE
  b_amount numeric(10, 2);
  b_status text;
  b_academy text;
  paid numeric(10, 2);
BEGIN
  SELECT COALESCE(booking_amount, 0), status, academy_id INTO b_amount, b_status, b_academy
    FROM owner_bookings WHERE id = NEW.booking_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking not found' USING ERRCODE = '23503';
  END IF;
  IF b_academy <> NEW.academy_id THEN
    RAISE EXCEPTION 'payment academy does not match the booking academy' USING ERRCODE = '23514';
  END IF;
  IF b_status = 'CANCELLED' THEN
    RAISE EXCEPTION 'cannot record a payment on a CANCELLED booking' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM owner_booking_payments WHERE booking_id = NEW.booking_id;
  IF paid + NEW.amount > b_amount THEN
    RAISE EXCEPTION 'payment exceeds the remaining balance of the booking' USING ERRCODE = '23514';
  END IF;
  NEW.booking_amount_snapshot := b_amount;
  NEW.total_paid_after := paid + NEW.amount;
  NEW.balance_after := b_amount - (paid + NEW.amount);
  NEW.payment_status_after := CASE WHEN paid + NEW.amount >= b_amount THEN 'PAID' ELSE 'PARTIALLY_PAID' END;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_booking_payments_guard
  BEFORE INSERT ON owner_booking_payments FOR EACH ROW EXECUTE FUNCTION owner_booking_payment_guard();

COMMIT;
