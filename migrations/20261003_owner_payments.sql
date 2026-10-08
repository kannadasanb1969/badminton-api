-- SmashPointOwner Phase 6: payments, payment allocations, receipt numbering, payment-aware monthly fee statuses.
--
-- Owner-domain only. The ONLY change to an existing table is the status CHECK on owner_monthly_fees (a Phase-5
-- Owner table) widened from (PENDING, ON_LEAVE) to (PENDING, PARTIALLY_PAID, PAID, ON_LEAVE). Existing rows stay valid.
--
-- Accounting model
--   * owner_payments            immutable money-received transactions (never edited, never deleted by the app)
--   * owner_payment_allocations immutable "this much of that payment was applied to that monthly fee" rows
--   * credit is NOT stored: available credit = payment.amount - SUM(its allocations)
--   * monthly fee paid/balance are derived from allocations; the fee status is maintained by a trigger in the
--     same transaction as the allocation insert
--
-- Integrity enforced by the database (so it also holds for writers that bypass the service layer):
--   * allocation amount > 0; never above the fee's remaining balance; never above the payment's unallocated amount;
--     never on an ON_LEAVE fee; fee and payment must belong to the same member
--   * payments and allocations cannot be UPDATEd, and cannot be DELETEd (test/dev cleanup uses an explicit
--     transaction-local switch that the application never sets)
--   * receipt numbers are unique per academy and come from a per-academy, per-year counter row
BEGIN;

ALTER TABLE owner_monthly_fees DROP CONSTRAINT owner_monthly_fees_status_check;
ALTER TABLE owner_monthly_fees ADD CONSTRAINT owner_monthly_fees_status_check
  CHECK (status IN ('PENDING', 'PARTIALLY_PAID', 'PAID', 'ON_LEAVE'));

-- Per-academy receipt book: one counter row per (academy, year), incremented inside the payment transaction, so numbers
-- are gapless (a rolled-back payment releases its number) and concurrency-safe (the row lock serialises issuers).
CREATE TABLE IF NOT EXISTS owner_receipt_counters (
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  receipt_year integer NOT NULL CHECK (receipt_year BETWEEN 2000 AND 9999),
  last_number integer NOT NULL CHECK (last_number >= 1),
  PRIMARY KEY (academy_id, receipt_year)
);

CREATE TABLE IF NOT EXISTS owner_payments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  academy_id text NOT NULL REFERENCES owner_academies(id) ON DELETE RESTRICT,
  member_id text NOT NULL REFERENCES owner_members(id) ON DELETE RESTRICT,
  receipt_number text NOT NULL,
  amount numeric(10, 2) NOT NULL CHECK (amount > 0),
  payment_mode text NOT NULL CHECK (payment_mode IN ('CASH', 'UPI', 'BANK_TRANSFER', 'OTHER')),
  payment_date date NOT NULL,
  reference text CHECK (reference IS NULL OR length(reference) <= 200),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by_user_id text REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_payments_receipt_uidx UNIQUE (academy_id, receipt_number)
);
CREATE INDEX IF NOT EXISTS owner_payments_member_idx ON owner_payments(member_id, payment_date, created_at);
CREATE INDEX IF NOT EXISTS owner_payments_academy_idx ON owner_payments(academy_id, payment_date);

CREATE TABLE IF NOT EXISTS owner_payment_allocations (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  payment_id text NOT NULL REFERENCES owner_payments(id) ON DELETE RESTRICT,
  monthly_fee_id text NOT NULL REFERENCES owner_monthly_fees(id) ON DELETE RESTRICT,
  amount numeric(10, 2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS owner_payment_allocations_payment_idx ON owner_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS owner_payment_allocations_fee_idx ON owner_payment_allocations(monthly_fee_id);

-- Immutability. DELETE is allowed only inside a transaction that explicitly sets smashpoint.owner_payment_cleanup = 'on'
-- (used by automated-test cleanup; the application never sets it). UPDATE is never allowed.
CREATE OR REPLACE FUNCTION owner_payment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('smashpoint.owner_payment_cleanup', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'owner payments and payment allocations are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '23000';
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_payments_immutable
  BEFORE UPDATE OR DELETE ON owner_payments FOR EACH ROW EXECUTE FUNCTION owner_payment_immutable();
CREATE OR REPLACE TRIGGER owner_payment_allocations_immutable
  BEFORE UPDATE OR DELETE ON owner_payment_allocations FOR EACH ROW EXECUTE FUNCTION owner_payment_immutable();

-- Authoritative allocation guard. Locks the monthly fee row, then the payment row, and validates against the live sums.
CREATE OR REPLACE FUNCTION owner_allocation_guard() RETURNS trigger AS $$
DECLARE
  fee_amount numeric(10, 2);
  fee_status text;
  fee_member text;
  paid numeric(10, 2);
  pay_amount numeric(10, 2);
  pay_member text;
  used numeric(10, 2);
BEGIN
  SELECT f.applicable_fee, f.status, ms.member_id INTO fee_amount, fee_status, fee_member
    FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id
    WHERE f.id = NEW.monthly_fee_id FOR UPDATE OF f;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation target monthly fee not found' USING ERRCODE = '23503';
  END IF;
  IF fee_status = 'ON_LEAVE' THEN
    RAISE EXCEPTION 'cannot allocate a payment to an ON_LEAVE monthly fee' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM owner_payment_allocations WHERE monthly_fee_id = NEW.monthly_fee_id;
  IF paid + NEW.amount > fee_amount THEN
    RAISE EXCEPTION 'allocation exceeds the remaining balance of the monthly fee' USING ERRCODE = '23514';
  END IF;
  SELECT amount, member_id INTO pay_amount, pay_member FROM owner_payments WHERE id = NEW.payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation source payment not found' USING ERRCODE = '23503';
  END IF;
  IF pay_member <> fee_member THEN
    RAISE EXCEPTION 'payment and monthly fee belong to different members' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(SUM(amount), 0) INTO used FROM owner_payment_allocations WHERE payment_id = NEW.payment_id;
  IF used + NEW.amount > pay_amount THEN
    RAISE EXCEPTION 'allocation exceeds the unallocated amount of the payment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_payment_allocations_guard
  BEFORE INSERT ON owner_payment_allocations FOR EACH ROW EXECUTE FUNCTION owner_allocation_guard();

-- Status derivation, in the same transaction as the allocation: 0 -> PENDING, partial -> PARTIALLY_PAID, full -> PAID.
CREATE OR REPLACE FUNCTION owner_allocation_status() RETURNS trigger AS $$
BEGIN
  UPDATE owner_monthly_fees f SET
    status = CASE
      WHEN t.paid >= f.applicable_fee AND f.applicable_fee > 0 THEN 'PAID'
      WHEN t.paid > 0 THEN 'PARTIALLY_PAID'
      ELSE 'PENDING' END,
    updated_at = NOW()
  FROM (SELECT COALESCE(SUM(amount), 0) AS paid FROM owner_payment_allocations WHERE monthly_fee_id = NEW.monthly_fee_id) t
  WHERE f.id = NEW.monthly_fee_id AND f.status <> 'ON_LEAVE';
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER owner_payment_allocations_status
  AFTER INSERT ON owner_payment_allocations FOR EACH ROW EXECUTE FUNCTION owner_allocation_status();

COMMIT;
