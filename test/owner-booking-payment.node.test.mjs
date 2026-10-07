// Phase 9.3 pure/static tests: input validation, derived payment status, exact money, migration shape, route auth. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paymentInput, mapReceipt, PAYMENT_MODES } from '../src/services/owner-booking-payment.service.js';
import { paymentSummary } from '../src/services/owner-booking.service.js';
import { toCents, fromCents } from '../src/utils/owner-money.js';
import { todayIST, addDays } from '../src/utils/owner-dates.js';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';

const ok = { amount: '500.00', paymentMode: 'UPI', paymentDate: todayIST() };
const bad = (over, re) => assert.throws(() => paymentInput({ ...ok, ...over }), re);

test('payment status is derived: PENDING / PARTIALLY_PAID / PAID, and 0.00 booking is PAID', () => {
  assert.deepEqual(paymentSummary('1500.00', '0.00'), { bookingAmount: '1500.00', totalPaid: '0.00', balance: '1500.00', paymentStatus: 'PENDING' });
  assert.deepEqual(paymentSummary('1500.00', '500.00'), { bookingAmount: '1500.00', totalPaid: '500.00', balance: '1000.00', paymentStatus: 'PARTIALLY_PAID' });
  assert.deepEqual(paymentSummary('1500.00', '1500.00'), { bookingAmount: '1500.00', totalPaid: '1500.00', balance: '0.00', paymentStatus: 'PAID' });
  assert.equal(paymentSummary('0.00', '0.00').paymentStatus, 'PAID');
  assert.equal(paymentSummary(null, '0.00').paymentStatus, 'PAID'); // legacy Phase 9.1 booking without an amount: nothing owed
});

test('exact money: 0.10 + 0.20 is exactly 0.30, no float drift', () => {
  const sum = toCents('0.10') + toCents('0.20');
  assert.equal(fromCents(sum), '0.30');
  assert.equal(paymentSummary('0.30', fromCents(sum)).paymentStatus, 'PAID');
  assert.equal(paymentSummary('0.30', '0.10').balance, '0.20');
  assert.equal(paymentSummary('1250.50', '0.10').balance, '1250.40');
  assert.equal(paymentInput({ ...ok, amount: '1250.50' }).amountCents, 125050n);
  assert.equal(paymentInput({ ...ok, amount: 0.1 }).amountCents, 10n);
});

test('validation: amount', () => {
  bad({ amount: '0' }, /greater than zero/);
  bad({ amount: '0.00' }, /greater than zero/);
  bad({ amount: '-5' }, /negative/);
  bad({ amount: '1.234' }, /2 decimals/);
  bad({ amount: '1e3' }, /amount/);
  bad({ amount: '1E2' }, /amount/);
  bad({ amount: '' }, /required/);
  bad({ amount: undefined }, /required/);
  bad({ amount: true }, /required/);
  bad({ amount: 'abc' }, /amount/);
});

test('validation: mode, date, optional text', () => {
  bad({ paymentMode: 'ONLINE_GATEWAY' }, /paymentMode/);
  bad({ paymentMode: 'cash' }, /paymentMode/);
  bad({ paymentMode: undefined }, /paymentMode/);
  assert.deepEqual(PAYMENT_MODES, ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER']);
  bad({ paymentDate: addDays(todayIST(), 1) }, /future/);
  bad({ paymentDate: '2026-02-30' }, /valid date/);
  assert.equal(paymentInput({ ...ok, paymentDate: '2026-01-02' }).paymentDate, '2026-01-02'); // earlier date allowed
  assert.equal(paymentInput({ ...ok, paymentDate: todayIST() }).paymentDate, todayIST());
  const v = paymentInput({ ...ok, referenceNumber: '   ', note: '' });
  assert.deepEqual([v.referenceNumber, v.note], [null, null]);
  assert.equal(paymentInput({ ...ok, referenceNumber: '  UTR  123 ' }).referenceNumber, 'UTR 123');
  bad({ referenceNumber: 'x'.repeat(201) }, /at most 200/);
  bad({ note: 'x'.repeat(301) }, /at most 300/);
  bad({ note: 5 }, /must be text/);
  assert.throws(() => paymentInput(null), /JSON object/);
  assert.throws(() => paymentInput([]), /JSON object/);
});

test('client cannot supply status, totals or receipt number: unknown fields are ignored', () => {
  const v = paymentInput({ ...ok, paymentStatus: 'PAID', totalPaid: '9999', receiptNumber: 'SPB-2000-000001', balance: '0' });
  assert.deepEqual(Object.keys(v).sort(), ['amountCents', 'note', 'paymentDate', 'paymentMode', 'referenceNumber']);
});

test('receipt mapping carries the stored snapshot and is labelled manual', () => {
  const r = mapReceipt({ id: 'p', booking_id: 'b', receipt_number: 'SPB-2031-000001', amount: '500.00', payment_mode: 'UPI', payment_date: '2031-01-01',
    reference_number: null, note: null, created_at: new Date(0), booking_amount: '1500.00', total_paid_after: '500.00', balance_after: '1000.00',
    payment_status_after: 'PARTIALLY_PAID', academy_name: 'A', court_name: 'C', customer_name: 'N', customer_mobile: '8939594019', booking_date: '2031-02-01', s: '09:00', e: '10:00', booking_status: 'CONFIRMED' });
  assert.deepEqual(r.snapshot, { bookingAmount: '1500.00', paidNow: '500.00', totalPaidAfter: '500.00', balanceAfter: '1000.00', paymentStatus: 'PARTIALLY_PAID' });
  assert.equal(r.manuallyRecorded, true);
});

test('migration is additive, owner-domain only, immutable, no gateway', () => {
  const sql = readFileSync(new URL('../migrations/20261006_owner_booking_payments.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /DROP\s+(TABLE|COLUMN|CONSTRAINT)|TRUNCATE|ALTER\s+TABLE/i);
  assert.doesNotMatch(code, /owner_payments|owner_payment_allocations|owner_monthly_fees|owner_receipt_counters/);
  assert.doesNotMatch(code, /(INSERT INTO|UPDATE|DELETE FROM|ALTER TABLE)\s+(users|owner_bookings)\b/i); // FK reference to users only
  assert.match(code, /BEFORE UPDATE OR DELETE ON owner_booking_payments/);
  assert.match(code, /BEFORE INSERT ON owner_booking_payments/);
  assert.match(code, /payment_mode IN \('CASH', 'UPI', 'BANK_TRANSFER', 'OTHER'\)/);
  assert.doesNotMatch(code, /GATEWAY|razorpay|stripe/i);
});

test('no payment gateway or provider is referenced by Phase 9.3 code', () => {
  for (const f of ['../src/services/owner-booking-payment.service.js', '../src/repositories/owner-booking-payment.repository.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, ''), /razorpay|stripe|phonepe|paytm|cashfree|webhook|fetch\(/i);
  }
});

test('routes require authentication; no PATCH/PUT/DELETE exist for payments', async () => {
  for (const [method, path] of [['POST', '/bookings/x/payments'], ['GET', '/bookings/x/payments'], ['GET', '/booking-payments/x/receipt']]) {
    const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method }), {});
    assert.equal(res.status, 401);
  }
  const src = readFileSync(new URL('../src/routes/owner.routes.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /parts\[2\] === "payments" && method === "(PATCH|PUT|DELETE)"/);
  assert.doesNotMatch(src, /booking-payments[^\n]*(PATCH|PUT|DELETE)/);
});
