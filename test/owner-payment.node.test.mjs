import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { paymentInput, planAuto, planManual, manualAllocations } from '../src/services/owner-payment.service.js';
import { OwnerError } from '../src/services/owner.service.js';
import { fromCents, parseCents, toCents } from '../src/utils/owner-money.js';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };
const ok = { memberId: 'm', amount: '100', paymentMode: 'CASH' };

test('AD: unauthenticated payment routes are rejected', async () => {
  for (const [method, path] of [['POST', '/api/owner/payments'], ['GET', '/api/owner/payments'], ['GET', '/api/owner/payments/p'], ['GET', '/api/owner/members/m/payments'],
    ['GET', '/api/owner/members/m/credit'], ['POST', '/api/owner/members/m/apply-credit'], ['GET', '/api/owner/monthly-fees/f']]) {
    assert.equal((await handleOwnerRoutes(new Request(`http://x${path}`, { method }), env)).status, 401, `${method} ${path}`);
  }
});

test('S: there is no way to edit or delete a payment through the API', async () => {
  const token = await issueAccessToken(env, { id: 'u1', role: 'PLAYER' });
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    for (const path of ['/api/owner/payments/p', '/api/owner/payments']) {
      const res = await handleOwnerRoutes(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' }), env);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  }
});

test('AF: money is exact (integer cents), never floating point', () => {
  assert.equal(toCents('0.1') + toCents('0.2'), toCents('0.30'));
  assert.equal(fromCents(toCents('800.50') * 3n), '2401.50');
  assert.equal(fromCents(toCents('1000') - toCents('300.25')), '699.75');
  assert.equal(parseCents('1234.5'), 123450n);
  assert.equal(parseCents(100), 10000n);
  assert.equal(fromCents(5n), '0.05');
  for (const bad of ['', null, undefined, '-1', -5, '1.999', '1e3', 'abc', true, '123456789']) assert.throws(() => parseCents(bad), Error, String(bad));
  assert.throws(() => parseCents('0', { positive: true }));
  assert.equal(parseCents('0'), 0n);
});

test('AG/AH/AI: payment input validation (amount > 0, mode, date, allocation mode)', () => {
  assert.doesNotThrow(() => paymentInput(ok));
  assert.equal(paymentInput(ok).allocationMode, 'AUTO');
  for (const amount of [0, '0', '0.00', -1, '-5.00', '', null, undefined, '1.005', 'ten']) assert.throws(() => paymentInput({ ...ok, amount }), OwnerError, `amount ${amount}`);
  for (const paymentMode of ['CHEQUE', 'cash', '', null, undefined]) assert.throws(() => paymentInput({ ...ok, paymentMode }), OwnerError, `mode ${paymentMode}`);
  for (const m of ['CASH', 'UPI', 'BANK_TRANSFER', 'OTHER']) assert.equal(paymentInput({ ...ok, paymentMode: m }).paymentMode, m);
  assert.throws(() => paymentInput({ ...ok, paymentDate: '2999-01-01' }), OwnerError, 'future date');
  assert.throws(() => paymentInput({ ...ok, paymentDate: '2026-13-40' }), OwnerError, 'impossible date');
  assert.throws(() => paymentInput({ ...ok, allocationMode: 'MAGIC' }), OwnerError);
  assert.throws(() => paymentInput({ ...ok, reference: 'x'.repeat(201) }), OwnerError);
  assert.throws(() => paymentInput({}), OwnerError);
  // client-supplied authority fields are ignored
  const v = paymentInput({ ...ok, receiptNumber: 'HACK-1', status: 'PAID', paidAmount: '9999', balance: '0', ownerId: 'x' });
  assert.deepEqual(Object.keys(v).sort(), ['allocationMode', 'allocations', 'amountCents', 'memberId', 'note', 'paymentDate', 'paymentMode', 'reference'].sort());
  assert.equal(v.reference, null);
});

test('manual allocation input: required, unique fees, positive exact amounts, never above the payment', () => {
  assert.throws(() => paymentInput({ ...ok, allocationMode: 'MANUAL' }), OwnerError);
  assert.throws(() => paymentInput({ ...ok, allocationMode: 'MANUAL', allocations: [] }), OwnerError);
  assert.throws(() => manualAllocations([{ monthlyFeeId: 'a', amount: '1' }, { monthlyFeeId: 'a', amount: '2' }]), OwnerError, 'duplicate fee');
  assert.throws(() => manualAllocations([{ monthlyFeeId: 'a', amount: '0' }]), OwnerError);
  assert.throws(() => manualAllocations([{ monthlyFeeId: 'a', amount: '-3' }]), OwnerError);
  assert.throws(() => manualAllocations([{ amount: '3' }]), OwnerError);
  assert.throws(() => paymentInput({ ...ok, allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: 'a', amount: '60' }, { monthlyFeeId: 'b', amount: '60.01' }] }), OwnerError, 'sum > payment');
  const v = paymentInput({ ...ok, allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: 'a', amount: '60' }, { monthlyFeeId: 'b', amount: '40' }] });
  assert.equal(v.allocations.length, 2);
});

const fee = (id, month, applicable, paid, status = 'PENDING') => ({ id, fee_month: month, applicable_fee: applicable, paid, status });

test('G: AUTO allocation is oldest-month-first, skips PAID/ON_LEAVE, never exceeds a balance, remainder is credit', () => {
  const fees = [
    fee('c', '2026-12-01', '1000.00', '0.00'),
    fee('a', '2026-10-01', '800.50', '300.25', 'PARTIALLY_PAID'),
    fee('p', '2026-09-01', '500.00', '500.00', 'PAID'),
    fee('l', '2026-10-01', '0.00', '0.00', 'ON_LEAVE'),
    fee('b', '2026-11-01', '800.50', '0.00'),
  ];
  const { plan, leftCents } = planAuto(fees, toCents('2000'));
  assert.deepEqual(plan.map((p) => [p.feeId, fromCents(p.cents)]), [['a', '500.25'], ['b', '800.50'], ['c', '699.25']]);
  assert.equal(leftCents, 0n);
  const big = planAuto(fees, toCents('5000'));
  assert.deepEqual(big.plan.map((p) => fromCents(p.cents)), ['500.25', '800.50', '1000.00']);
  assert.equal(fromCents(big.leftCents), '2699.25', 'excess becomes credit');
  assert.deepEqual(planAuto(fees, toCents('100')).plan.map((p) => [p.feeId, fromCents(p.cents)]), [['a', '100.00']]);
  assert.equal(planAuto([], toCents('50')).plan.length, 0);
  assert.equal(fromCents(planAuto([], toCents('50')).leftCents), '50.00');
});

test('I/J: MANUAL planning rejects ON_LEAVE and over-allocation', () => {
  const byId = new Map([['a', fee('a', '2026-10-01', '100.00', '40.00', 'PARTIALLY_PAID')], ['l', fee('l', '2026-10-01', '0.00', '0.00', 'ON_LEAVE')]]);
  assert.deepEqual(planManual([{ feeId: 'a', cents: toCents('60') }], byId).map((p) => fromCents(p.cents)), ['60.00']);
  assert.throws(() => planManual([{ feeId: 'a', cents: toCents('60.01') }], byId), OwnerError);
  assert.throws(() => planManual([{ feeId: 'l', cents: toCents('1') }], byId), OwnerError);
});

test('migration: Owner-domain only; the sole ALTER is the owner_monthly_fees status CHECK; no TRUNCATE / table drops', async () => {
  const code = (await readFile(new URL('../migrations/20261003_owner_payments.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');
  assert.deepEqual([...code.matchAll(/ALTER TABLE (\w+)/g)].map((m) => m[1]), ['owner_monthly_fees', 'owner_monthly_fees']);
  assert.deepEqual([...code.matchAll(/DROP (\w+) (\w+)/g)].map((m) => `${m[1]} ${m[2]}`), ['CONSTRAINT owner_monthly_fees_status_check']);
  assert.doesNotMatch(code, /\bTRUNCATE\b|\bDROP TABLE\b|\bEXTENSION\b|\bINSERT\s+INTO\s+(?!owner_)|\bDELETE\s+FROM\b/i);
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['owner_receipt_counters', 'owner_payments', 'owner_payment_allocations']);
  assert.doesNotMatch(code, /REFERENCES (?!owner_|users\()/);
  assert.match(code, /status IN \('PENDING', 'PARTIALLY_PAID', 'PAID', 'ON_LEAVE'\)/);
  assert.match(code, /numeric\(10, 2\)/);
  assert.doesNotMatch(code, /\b(float|double precision|real)\b/i);
  assert.match(code, /owner_payments_immutable/);
  assert.match(code, /owner_allocation_guard/);
  assert.doesNotMatch(code, /credit\s+numeric|credit_balance|balance\s+numeric/i, 'credit is derived, never a mutable balance column');
});
