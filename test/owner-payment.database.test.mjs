// Phase 6 payment / allocation / credit / locking tests (A-AJ) against the LOCAL DEVELOPMENT database only (q2-friendly-test).
// All dates derive from "today", so the suite is valid in any month. Throwaway rows are removed by the cleanup hook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { currentMonthIST, todayIST } from '../src/utils/owner-dates.js';
import { fromCents, toCents } from '../src/utils/owner-money.js';

const REQUIRED_ENDPOINT = 'ep-weathered-meadow-b3ot536q';
let enabled = true;
let config;
try { config = getSafeDatabaseConfig(); } catch { enabled = false; }
if (enabled && !new URL(config.connectionString).hostname.startsWith(REQUIRED_ENDPOINT)) throw new Error('Refusing: database endpoint is not the verified q2-friendly-test endpoint');
const skip = !enabled && 'set DB_ENV, ALLOW_DB_INTEGRATION_TESTS and DATABASE_URL_DEV';
const env = enabled ? {
  AUTH_TOKEN_SECRET: 'integration-secret',
  HYPERDRIVE: { connectionString: config.connectionString },
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.connectionString,
} : {};
const tag = String(Math.floor(Math.random() * 9e7) + 1e7);
const users = {};
let admin;

const M0 = currentMonthIST();
const shift = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10); };
const M1 = shift(M0, -1);
const M2 = shift(M0, -2);
const M3 = shift(M0, -3);
const YEAR = todayIST().slice(0, 4);

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(env, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, ...(await res.json()) };
}

before(async () => {
  if (!enabled) return;
  // A pool, not one long-lived client: Neon closes idle connections and this suite runs for minutes.
  admin = new pg.Pool({ connectionString: config.connectionString, max: 4, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  for (const [key, suffix] of [['a', '1'], ['b', '2']]) {
    users[key] = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,'PLAYER') RETURNING id, role", [`+91${tag}${suffix}`])).rows[0];
  }
});
after(async () => {
  if (!enabled) return;
  const ids = Object.values(users).map((u) => u.id);
  const academies = "(SELECT id FROM owner_academies WHERE owner_profile_id IN (SELECT id FROM owner_profiles WHERE user_id = ANY($1)))";
  const members = `(SELECT id FROM owner_members WHERE academy_id IN ${academies})`;
  const memberships = `(SELECT id FROM owner_memberships WHERE member_id IN ${members})`;
  const batches = `(SELECT id FROM owner_batches WHERE academy_id IN ${academies})`;
  const fees = `(SELECT id FROM owner_monthly_fees WHERE membership_id IN ${memberships})`;
  const tx = await admin.connect();
  try {
    await tx.query('BEGIN');
    // payments and allocations are immutable; test cleanup uses the explicit, transaction-local switch (the app never sets it)
    await tx.query("SET LOCAL smashpoint.owner_payment_cleanup = 'on'");
    for (const sql of [
      `DELETE FROM owner_payment_allocations WHERE monthly_fee_id IN ${fees}`,
      `DELETE FROM owner_payments WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_receipt_counters WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_monthly_fees WHERE membership_id IN ${memberships}`,
      `DELETE FROM owner_monthly_leaves WHERE membership_id IN ${memberships}`,
      `DELETE FROM owner_memberships WHERE member_id IN ${members}`,
      `DELETE FROM owner_members WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_fee_rates WHERE batch_id IN ${batches}`,
      `DELETE FROM owner_batches WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_courts WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_academies WHERE owner_profile_id IN (SELECT id FROM owner_profiles WHERE user_id = ANY($1))`,
      'DELETE FROM owner_profiles WHERE user_id = ANY($1)', 'DELETE FROM users WHERE id = ANY($1)']) await tx.query(sql, [ids]);
    await tx.query('COMMIT');
  } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }
  await admin.end();
});

const sum = (xs) => xs.reduce((s, x) => s + toCents(x), 0n);

test('payments, allocation, credit, locking, concurrency, reporting', { skip }, async () => {
  const { a, b } = users;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const academy = (await api(a, 'POST', '/academies', { name: 'Pay academy' })).data;
  const bAcademy = (await api(b, 'POST', '/academies', { name: 'B pay academy' })).data;
  const court = async (n) => (await api(a, 'POST', `/academies/${academy.id}/courts`, { name: n })).data;
  const [c1, c2, c3] = [await court('P1'), await court('P2'), await court('P3')];
  const mkBatch = async (c, name, fee, s, e) => (await api(a, 'POST', '/batches', { academyId: academy.id, courtId: c.id, type: 'REGULAR', name, startTime: s, endTime: e, feePerPerson: fee })).data;
  const bReg = await mkBatch(c1, 'Pay Regular', '1000', '06:00', '07:00');   // M0 = 1000.00
  const bReg2 = await mkBatch(c2, 'Pay Regular 2', '600', '08:00', '09:00'); // M0 = 600.00
  const bTiny = await mkBatch(c3, 'Pay Tiny', '0.30', '10:00', '11:00');     // M0 = 0.30
  assert.equal((await api(a, 'POST', `/batches/${bReg.id}/fee-rates`, { feeAmount: '800.50', effectiveFrom: M3 })).status, 201); // M-3..M-1 = 800.50

  const day = (m, n) => `${m.slice(0, 8)}${String(n).padStart(2, '0')}`;
  const member = async (name) => (await api(a, 'POST', '/members', { academyId: academy.id, name })).data;
  const join = async (m, batch, startDate) => { const r = await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: batch.id, startDate }); assert.equal(r.status, 201, JSON.stringify(r)); return r.data; };
  const early = day(M3, 5);
  const [m1, m2, m3, m9] = [await member('Early One'), await member('Early Two'), await member('Early Three'), await member('Early Nine')];
  const [ms1, , , ms9] = [await join(m1, bReg, early), await join(m2, bReg, early), await join(m3, bReg, early), await join(m9, bReg, early)];
  const [m4, m5, m6, m7, mt] = [await member('Leave Four'), await member('Credit Five'), await member('Advance Six'), await member('Race Seven'), await member('Tiny')];
  const [m10a, m10b, m10c, m11] = [await member('Race Ten A'), await member('Race Ten B'), await member('Race Ten C'), await member('Empty Eleven')];
  const ms4 = await join(m4, bReg, M0);
  const ms5a = await join(m5, bReg, M0); await join(m5, bReg2, M0);
  await join(m6, bReg, M0); await join(m7, bReg, M0); await join(mt, bTiny, M0);
  const ms10 = [await join(m10a, bReg, M0), await join(m10b, bReg, M0), await join(m10c, bReg, M0)];

  const pay = (user, memberId, amount, extra = {}) => api(user, 'POST', '/payments', { memberId, amount, paymentMode: 'CASH', paymentDate: todayIST(), ...extra });
  const feeOf = async (memberId, month) => (await api(a, 'GET', `/monthly-fees?memberId=${memberId}&feeMonth=${month}`)).data.items.find((x) => x);
  const gen = (month) => api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: month });

  // AH, AI, AG: invalid payment requests create nothing
  const countPayments = async () => (await admin.query("SELECT count(*)::int n FROM owner_payments WHERE academy_id=$1", [academy.id])).rows[0].n;
  assert.equal(await countPayments(), 0);
  for (const bad of [{ amount: '0' }, { amount: '-5' }, { paymentMode: 'CHEQUE' }, { paymentDate: '2999-01-01' }, { paymentDate: '2020-02-31' }, { allocationMode: 'X' }])
    assert.equal((await pay(a, m1.id, '100', bad)).status, 400, JSON.stringify(bad));
  assert.equal(await countPayments(), 0, 'rejected requests left no payment');

  // K: a payment with NO dues is valid advance money (m5/m6 have no fees generated yet)
  const adv5 = await pay(a, m5.id, '1750.75', { paymentMode: 'UPI', reference: 'UPI-REF-1' });
  assert.equal(adv5.status, 201);
  assert.deepEqual([adv5.data.amount, adv5.data.allocatedAmount, adv5.data.creditRemaining, adv5.data.allocations.length, adv5.data.reference], ['1750.75', '0.00', '1750.75', 0, 'UPI-REF-1']);
  assert.equal(adv5.data.receiptNumber, `SPO-${YEAR}-000001`, 'first receipt of the academy');
  const adv6 = await pay(a, m6.id, '500.00');
  assert.equal(adv6.data.creditRemaining, '500.00');
  assert.equal((await api(a, 'GET', `/members/${m5.id}/credit`)).data.availableCredit, '1750.75'); // L

  // dues: M-2, M-1, M0 (early members), M0 for the rest; ms4 is on leave this month
  assert.equal((await api(a, 'POST', `/memberships/${ms4.id}/leaves`, { feeMonth: M0 })).status, 201);
  for (const m of [M2, M1, M0]) assert.equal((await gen(m)).status, 200);

  // A, B: full payment -> PAID
  const full = await pay(a, m1.id, '800.50');
  assert.equal(full.status, 201);
  assert.deepEqual([full.data.allocatedAmount, full.data.creditRemaining], ['800.50', '0.00']);
  assert.deepEqual(full.data.allocations.map((x) => [x.feeMonth, x.allocatedAmount, x.monthlyFeeStatus, x.remainingBalance]), [[M2, '800.50', 'PAID', '0.00']]);
  const f1m2 = await feeOf(m1.id, M2);
  assert.deepEqual([f1m2.status, f1m2.paidAmount, f1m2.balance], ['PAID', '800.50', '0.00']);

  // C, D, E: partial -> PARTIALLY_PAID; second payment completes -> PAID (one fee, two payments)
  const part = await pay(a, m2.id, '300.25');
  assert.deepEqual([part.data.allocations[0].monthlyFeeStatus, part.data.allocations[0].remainingBalance, part.data.creditRemaining], ['PARTIALLY_PAID', '500.25', '0.00']);
  const rest = await pay(a, m2.id, '500.25', { paymentMode: 'BANK_TRANSFER' });
  assert.equal(rest.data.allocations[0].monthlyFeeStatus, 'PAID');
  const feeDetail = (await api(a, 'GET', `/monthly-fees/${part.data.allocations[0].monthlyFeeId}`)).data;
  assert.deepEqual([feeDetail.status, feeDetail.paidAmount, feeDetail.balance, feeDetail.payments.map((x) => x.amount)], ['PAID', '800.50', '0.00', ['300.25', '500.25']]);
  assert.deepEqual(feeDetail.payments.map((x) => x.receiptNumber), [part.data.receiptNumber, rest.data.receiptNumber]);

  // F, G: one payment across several months, oldest first (m3: 2000.00 -> M-2 full, M-1 full, M0 399.00)
  const multi = await pay(a, m3.id, '2000.00');
  assert.deepEqual(multi.data.allocations.map((x) => [x.feeMonth, x.allocatedAmount, x.monthlyFeeStatus, x.remainingBalance]),
    [[M2, '800.50', 'PAID', '0.00'], [M1, '800.50', 'PAID', '0.00'], [M0, '399.00', 'PARTIALLY_PAID', '601.00']]);
  assert.equal(multi.data.creditRemaining, '0.00');

  // H: manual allocation to chosen dues (m1: pay 500 -> M0 200.00 + M-1 300.00), and a payment bigger than its allocation -> credit
  const f1m1 = await feeOf(m1.id, M1); const f1m0 = await feeOf(m1.id, M0);
  const man = await pay(a, m1.id, '500', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f1m0.id, amount: '200' }, { monthlyFeeId: f1m1.id, amount: '300.00' }] });
  assert.equal(man.status, 201);
  assert.deepEqual(man.data.allocations.map((x) => [x.feeMonth, x.allocatedAmount, x.monthlyFeeStatus]).sort(), [[M0, '200.00', 'PARTIALLY_PAID'], [M1, '300.00', 'PARTIALLY_PAID']].sort());
  const man2 = await pay(a, m1.id, '150', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f1m1.id, amount: '100' }] });
  assert.deepEqual([man2.data.allocatedAmount, man2.data.creditRemaining], ['100.00', '50.00']);
  assert.equal((await api(a, 'GET', `/members/${m1.id}/credit`)).data.availableCredit, '50.00');

  // I: over-allocation rejected (409), nothing recorded; allocation above the payment rejected (400)
  const before = await countPayments();
  assert.equal((await pay(a, m1.id, '5000', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f1m1.id, amount: '999' }] })).status, 409);
  assert.equal((await pay(a, m1.id, '10', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f1m1.id, amount: '10.01' }] })).status, 400);
  assert.equal(await countPayments(), before, 'AJ: failed allocation leaves no orphan payment');

  // J: ON_LEAVE fee: manual allocation rejected, AUTO skips it (whole amount becomes credit)
  const f4 = await feeOf(m4.id, M0);
  assert.deepEqual([f4.status, f4.applicableFee], ['ON_LEAVE', '0.00']);
  assert.equal((await pay(a, m4.id, '100', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f4.id, amount: '50' }] })).status, 409);
  const skipLeave = await pay(a, m4.id, '100');
  assert.deepEqual([skipLeave.data.allocatedAmount, skipLeave.data.creditRemaining], ['0.00', '100.00']);

  // M, N, O: apply existing credit (m5: 1750.75 advance) across two dues; no new payment; rows point at the ORIGINAL payment
  const paymentsBefore = await countPayments();
  const applied = await api(a, 'POST', `/members/${m5.id}/apply-credit`, { mode: 'AUTO' });
  assert.equal(applied.status, 200);
  assert.deepEqual([applied.data.applied, applied.data.creditRemaining], ['1600.00', '150.75']);
  assert.ok(applied.data.allocations.every((x) => x.paymentId === adv5.data.id && x.receiptNumber === adv5.data.receiptNumber && x.monthlyFeeStatus === 'PAID'));
  assert.equal(applied.data.allocations.length, 2);
  assert.equal(await countPayments(), paymentsBefore, 'apply credit created no payment transaction');
  assert.deepEqual([(await api(a, 'GET', `/members/${m5.id}/credit`)).data.availableCredit, (await api(a, 'GET', `/payments/${adv5.data.id}`)).data.creditRemaining], ['150.75', '150.75']);
  assert.equal((await api(a, 'POST', `/members/${m5.id}/apply-credit`, {})).status, 409, 'nothing left to apply to');

  // P: concurrent Apply Credit cannot double-spend (m6: 500.00 credit, one 1000.00 due)
  const race6 = await Promise.all(Array.from({ length: 6 }, () => api(a, 'POST', `/members/${m6.id}/apply-credit`, { mode: 'AUTO' })));
  assert.equal(race6.filter((r) => r.status === 200).length, 1);
  assert.ok(race6.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.equal((await admin.query("SELECT COALESCE(SUM(amount),0)::text s FROM owner_payment_allocations WHERE payment_id=$1", [adv6.data.id])).rows[0].s, '500.00');
  assert.equal((await api(a, 'GET', `/members/${m6.id}/credit`)).data.availableCredit, '0.00');

  // Q, R: concurrent payments cannot overpay a fee; every receipt number is unique (m7 owes 1000.00)
  const race7 = await Promise.all(Array.from({ length: 6 }, () => pay(a, m7.id, '400')));
  assert.ok(race7.every((r) => r.status === 201), JSON.stringify(race7.map((r) => r.status)));
  const f7 = await feeOf(m7.id, M0);
  assert.deepEqual([f7.status, f7.paidAmount, f7.balance], ['PAID', '1000.00', '0.00']);
  assert.equal(fromCents(race7.reduce((s, r) => s + toCents(r.data.allocatedAmount), 0n)), '1000.00');
  assert.equal(fromCents(race7.reduce((s, r) => s + toCents(r.data.creditRemaining), 0n)), '1400.00');
  const receipts = (await admin.query("SELECT receipt_number FROM owner_payments WHERE academy_id=$1 ORDER BY receipt_number", [academy.id])).rows.map((r) => r.receipt_number);
  assert.equal(new Set(receipts).size, receipts.length, 'receipt numbers are unique');
  assert.deepEqual(receipts, receipts.map((_, i) => `SPO-${YEAR}-${String(i + 1).padStart(6, '0')}`), 'gapless per-academy receipt book');
  assert.equal((await api(a, 'GET', `/members/${m7.id}/credit`)).data.availableCredit, '1400.00');

  // S: payments are immutable (the database refuses UPDATE / DELETE)
  const target = full.data.id;
  await assert.rejects(admin.query("UPDATE owner_payments SET amount = 1 WHERE id=$1", [target]), (e) => e.code === '23000');
  await assert.rejects(admin.query("UPDATE owner_payments SET payment_mode='OTHER', payment_date=payment_date - 1, receipt_number='X' WHERE id=$1", [target]), (e) => e.code === '23000');
  await assert.rejects(admin.query("DELETE FROM owner_payments WHERE id=$1", [target]), (e) => e.code === '23000');
  await assert.rejects(admin.query("UPDATE owner_payment_allocations SET amount = 1 WHERE payment_id=$1", [target]), (e) => e.code === '23000');
  await assert.rejects(admin.query("DELETE FROM owner_payment_allocations WHERE payment_id=$1", [target]), (e) => e.code === '23000');
  assert.equal((await api(a, 'GET', `/payments/${target}`)).data.amount, '800.50');

  // V, W: leave vs payments. A fee with an allocation can no longer be rewritten by leave.
  const lockedLeave = await api(a, 'POST', `/memberships/${ms1.id}/leaves`, { feeMonth: M0 });
  assert.equal(lockedLeave.status, 409);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_monthly_leaves WHERE membership_id=$1", [ms1.id])).rows[0].n, 0, 'rejected leave was not recorded');
  assert.equal((await feeOf(m1.id, M0)).status, 'PARTIALLY_PAID');
  // an untouched PENDING fee can still be reconciled by leave, and restored (Phase-5 behaviour before any payment)
  assert.equal((await api(a, 'POST', `/memberships/${ms9.id}/leaves`, { feeMonth: M1 })).status, 201);
  assert.deepEqual([(await feeOf(m9.id, M1)).status, (await feeOf(m9.id, M1)).applicableFee], ['ON_LEAVE', '0.00']);
  assert.equal((await api(a, 'DELETE', `/memberships/${ms9.id}/leaves/${M1}`)).status, 200);
  assert.deepEqual([(await feeOf(m9.id, M1)).status, (await feeOf(m9.id, M1)).applicableFee], ['PENDING', '800.50']);

  // U: payment vs leave race on the same fee; never "ON_LEAVE with allocations"
  const mids = [m10a, m10b, m10c];
  await gen(M0);
  await Promise.all(mids.map((m, i) => Promise.allSettled([pay(a, m.id, '1000'), api(a, 'POST', `/memberships/${ms10[i].id}/leaves`, { feeMonth: M0 })])));
  const bad = await admin.query(`SELECT count(*)::int n FROM owner_monthly_fees f WHERE f.status='ON_LEAVE' AND EXISTS (SELECT 1 FROM owner_payment_allocations al WHERE al.monthly_fee_id=f.id)`);
  assert.equal(bad.rows[0].n, 0);
  for (let i = 0; i < 3; i += 1) {
    const f = await feeOf(mids[i].id, M0);
    const leave = (await admin.query("SELECT count(*)::int n FROM owner_monthly_leaves WHERE membership_id=$1 AND fee_month=$2", [ms10[i].id, M0])).rows[0].n;
    assert.ok((leave === 0 && f.status === 'PAID') || (leave === 1 && f.status === 'ON_LEAVE' && f.paidAmount === '0.00'), `consistent final state: leave=${leave} status=${f.status}`);
  }

  // X: regeneration and a later fee-rate change never rewrite paid / partly-paid fees
  const snap = async () => (await admin.query("SELECT id, applicable_fee::text a, status, fee_rate_id FROM owner_monthly_fees WHERE membership_id IN (SELECT id FROM owner_memberships WHERE member_id = ANY($1)) ORDER BY id", [[m1.id, m2.id, m3.id, m7.id]])).rows;
  const snapBefore = await snap();
  assert.equal((await api(a, 'POST', `/batches/${bReg.id}/fee-rates`, { feeAmount: '1234.56', effectiveFrom: shift(M0, 1) })).status, 201);
  for (const m of [M2, M1, M0]) { const g = await gen(m); assert.equal(g.data.generated, 0); }
  assert.deepEqual(await snap(), snapBefore);

  // AF: exact decimals: 0.10 + 0.20 settles a 0.30 fee exactly
  await gen(M0);
  await pay(a, mt.id, '0.10'); const tiny = await pay(a, mt.id, '0.20');
  assert.deepEqual([tiny.data.allocations[0].monthlyFeeStatus, tiny.data.allocations[0].remainingBalance], ['PAID', '0.00']);
  assert.deepEqual([(await feeOf(mt.id, M0)).paidAmount, (await feeOf(mt.id, M0)).applicableFee], ['0.30', '0.30']);

  // Y, Z, AA: Expected / Collected / Outstanding for the month come from allocations, not gross payments
  const rep = (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}`)).data;
  const dbRep = (await admin.query(`
    SELECT COALESCE(SUM(f.applicable_fee),0)::text e,
      COALESCE((SELECT SUM(al.amount) FROM owner_payment_allocations al WHERE al.monthly_fee_id IN (SELECT f2.id FROM owner_monthly_fees f2 JOIN owner_memberships ms2 ON ms2.id=f2.membership_id JOIN owner_members m2 ON m2.id=ms2.member_id WHERE m2.academy_id=$1 AND f2.fee_month=$2)),0)::text c
    FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id WHERE m.academy_id=$1 AND f.fee_month=$2`, [academy.id, M0])).rows[0];
  assert.equal(rep.summary.expectedCollection, dbRep.e);
  assert.equal(rep.summary.collected, dbRep.c);
  assert.equal(fromCents(toCents(dbRep.e) - toCents(dbRep.c)), rep.summary.outstanding);
  const gross = (await admin.query("SELECT COALESCE(SUM(amount),0)::text s FROM owner_payments WHERE academy_id=$1", [academy.id])).rows[0].s;
  assert.ok(toCents(gross) > toCents(rep.summary.collected), 'gross payments include unused credit that is NOT counted as collected');
  assert.equal(sum(rep.items.filter((i) => i.status === 'ON_LEAVE').map((i) => i.applicableFee)), 0n, 'ON_LEAVE contributes nothing to Expected');
  assert.equal(rep.summary.totalCount, rep.items.length);
  assert.equal(rep.summary.pendingCount + rep.summary.partiallyPaidCount + rep.summary.paidCount + rep.summary.onLeaveCount, rep.items.length);
  assert.equal(rep.summary.paidCount, rep.items.filter((i) => i.status === 'PAID').length);
  const outstandingOnly = (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}&outstanding=true`)).data.items;
  assert.ok(outstandingOnly.every((i) => ['PENDING', 'PARTIALLY_PAID'].includes(i.status) && toCents(i.balance) > 0n));

  // member payment summary: outstanding + credit, newest payment first
  const sm = (await api(a, 'GET', `/members/${m1.id}/payments`)).data;
  assert.equal(sm.summary.availableCredit, '50.00');
  assert.equal(fromCents(sum((await api(a, 'GET', `/monthly-fees?memberId=${m1.id}&outstanding=true`)).data.items.map((i) => i.balance))), sm.summary.outstanding);
  assert.equal(sm.payments.length, 3);

  // T: payments survive membership end and member deactivation (m1 has 50.00 credit)
  const m1Payments = (await api(a, 'GET', `/members/${m1.id}/payments`)).data.payments.map((p) => p.id);
  const ended = await api(a, 'POST', `/memberships/${ms1.id}/end`, { effectiveDate: todayIST() });
  assert.equal(ended.status, 200);
  assert.equal((await api(a, 'PATCH', `/members/${m1.id}`, { status: 'INACTIVE' })).data.status, 'INACTIVE');
  assert.deepEqual((await api(a, 'GET', `/members/${m1.id}/payments`)).data.payments.map((p) => p.id), m1Payments);
  assert.equal((await api(a, 'GET', `/members/${m1.id}/credit`)).data.availableCredit, '50.00');
  assert.equal((await feeOf(m1.id, M2)).status, 'PAID');

  // AJ (database level): allocation failures roll back the whole transaction; the DB refuses bad allocations by itself
  const rollbackId = crypto.randomUUID();
  const f9 = await feeOf(m9.id, M2);
  const f1again = await feeOf(m1.id, M1);
  // Each case inserts a payment and then a bad allocation inside one transaction, and rolls the whole thing back.
  const dbRejects = async (receipt, memberId, paymentAmount, feeId, allocAmount) => {
    const tx = await admin.connect();
    try {
      await tx.query('BEGIN');
      await tx.query("INSERT INTO owner_payments (id, academy_id, member_id, receipt_number, amount, payment_mode, payment_date) VALUES ($1,$2,$3,$4,$5,'CASH',$6)", [rollbackId, academy.id, memberId, receipt, paymentAmount, todayIST()]);
      await assert.rejects(tx.query("INSERT INTO owner_payment_allocations (payment_id, monthly_fee_id, amount) VALUES ($1,$2,$3)", [rollbackId, feeId, allocAmount]), (e) => e.code === '23514');
    } finally { await tx.query('ROLLBACK'); tx.release(); }
  };
  await dbRejects('SPO-ROLLBACK-1', m9.id, 10, f9.id, '10.01');          // above the payment's amount
  await dbRejects('SPO-ROLLBACK-2', m9.id, 9999, f1again.id, '1');       // another member's fee
  await dbRejects('SPO-ROLLBACK-3', m9.id, 9999, f9.id, '9999');         // above the fee's balance
  await dbRejects('SPO-ROLLBACK-4', m4.id, 50, f4.id, '1');              // an ON_LEAVE fee
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_payments WHERE id=$1", [rollbackId])).rows[0].n, 0, 'every rolled-back payment left nothing behind');
  assert.equal(await countPayments(), (await admin.query("SELECT count(*)::int n FROM owner_payments WHERE academy_id=$1", [academy.id])).rows[0].n);

  // AB, AC: Owner B cannot see or touch Owner A's money
  const bMember = (await api(b, 'POST', '/members', { academyId: bAcademy.id, name: 'B Member' })).data;
  assert.deepEqual((await api(b, 'GET', '/payments')).data, []);
  assert.equal((await api(b, 'GET', `/payments/${full.data.id}`)).status, 404);
  assert.equal((await pay(b, m2.id, '10')).status, 404, "B paying A's member");
  assert.equal((await pay(b, bMember.id, '10', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f1m1.id, amount: '5' }] })).status, 404, "B allocating to A's fee");
  assert.equal((await api(b, 'POST', `/members/${m5.id}/apply-credit`, {})).status, 404);
  assert.equal((await api(b, 'GET', `/members/${m1.id}/payments`)).status, 404);
  assert.equal((await api(b, 'GET', `/members/${m1.id}/credit`)).status, 404);
  assert.equal((await api(b, 'GET', `/monthly-fees/${f1m1.id}`)).status, 404);
  assert.deepEqual((await api(b, 'GET', `/payments?memberId=${m1.id}`)).data, []);
  // same-owner, different-member fee: refused, not silently re-assigned
  assert.equal((await pay(a, m2.id, '10', { allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: f1m1.id, amount: '5' }] })).status, 409);

  // AE: global roles untouched; no users created by any payment operation
  assert.deepEqual((await admin.query("SELECT role FROM users WHERE id = ANY($1)", [[a.id, b.id]])).rows.map((r) => r.role), ['PLAYER', 'PLAYER']);
  assert.equal((await admin.query("SELECT count(*)::int n FROM users WHERE mobile LIKE $1", [`+91${tag}%`])).rows[0].n, 2);
  assert.ok(ms4.id && m11.id);
});

test('concurrent AUTO payments for one member are serialised and never double-allocate; two payments for one due', { skip }, async () => {
  const { a } = users;
  const academy = (await api(a, 'GET', '/academies')).data.find((x) => x.name === 'Pay academy');
  const [bReg] = (await api(a, 'GET', '/batches')).data.filter((x) => x.name === 'Pay Regular');
  const m = (await api(a, 'POST', '/members', { academyId: academy.id, name: 'Double Spend' })).data;
  assert.equal((await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: bReg.id, startDate: M0 })).status, 201);
  assert.equal((await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: M0 })).status, 200);
  const due = (await api(a, 'GET', `/monthly-fees?memberId=${m.id}&feeMonth=${M0}`)).data.items[0];
  // two payments that each want the whole remaining balance, started together
  const res = await Promise.all([700, 700].map((amt) => api(a, 'POST', '/payments', { memberId: m.id, amount: String(amt), paymentMode: 'UPI', paymentDate: todayIST() })));
  assert.deepEqual(res.map((r) => r.status), [201, 201]);
  const allocated = res.map((r) => toCents(r.data.allocatedAmount)).sort();
  assert.equal(fromCents(allocated[0] + allocated[1]), due.applicableFee, 'together the two payments cover the due exactly once');
  const fee = (await api(a, 'GET', `/monthly-fees/${due.id}`)).data;
  assert.deepEqual([fee.status, fee.paidAmount, fee.balance], ['PAID', due.applicableFee, '0.00']);
  assert.equal((await api(a, 'GET', `/members/${m.id}/credit`)).data.availableCredit, fromCents(1400n * 100n - toCents(due.applicableFee)));
});

test('payment vs monthly generation race, and ledger invariants across the whole academy', { skip }, async () => {
  const { a } = users;
  const academy = (await api(a, 'GET', '/academies')).data.find((x) => x.name === 'Pay academy');
  const [bReg] = (await api(a, 'GET', '/batches')).data.filter((x) => x.name === 'Pay Regular');
  const next = shift(M0, 1);
  const m = (await api(a, 'POST', '/members', { academyId: academy.id, name: 'Generation Race' })).data;
  assert.equal((await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: bReg.id, startDate: M0 })).status, 201);
  assert.equal((await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: M0 })).status, 200);
  // fire a payment and next month's generation together, several times over
  const rounds = await Promise.all([1, 2, 3].map(() => Promise.all([
    api(a, 'POST', '/payments', { memberId: m.id, amount: '300', paymentMode: 'CASH', paymentDate: todayIST() }),
    api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: next }),
  ])));
  for (const [p, g] of rounds) { assert.equal(p.status, 201); assert.equal(g.status, 200); }
  const fees = (await admin.query("SELECT to_char(f.fee_month,'YYYY-MM-DD') m, f.applicable_fee::text a, f.status FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id WHERE ms.member_id=$1 ORDER BY 1", [m.id])).rows;
  assert.deepEqual(fees.map((f) => f.m), [M0, next], 'exactly one obligation per month, no duplicates');

  // ---- ledger invariants over everything this suite created ----
  const q = async (sql) => (await admin.query(sql, [academy.id])).rows[0].n;
  const inAcademy = "m.academy_id = $1";
  assert.equal(await q(`SELECT count(*)::int n FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id
    LEFT JOIN (SELECT monthly_fee_id, SUM(amount) paid FROM owner_payment_allocations GROUP BY 1) t ON t.monthly_fee_id=f.id
    WHERE ${inAcademy} AND COALESCE(t.paid,0) > f.applicable_fee`), 0, 'no fee is over-paid');
  assert.equal(await q(`SELECT count(*)::int n FROM owner_payments p JOIN owner_members m ON m.id=p.member_id
    LEFT JOIN (SELECT payment_id, SUM(amount) used FROM owner_payment_allocations GROUP BY 1) t ON t.payment_id=p.id
    WHERE ${inAcademy} AND COALESCE(t.used,0) > p.amount`), 0, 'no payment is over-spent (credit never negative)');
  assert.equal(await q(`SELECT count(*)::int n FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id
    LEFT JOIN (SELECT monthly_fee_id, SUM(amount) paid FROM owner_payment_allocations GROUP BY 1) t ON t.monthly_fee_id=f.id
    WHERE ${inAcademy} AND f.status <> 'ON_LEAVE' AND f.status <> CASE
      WHEN COALESCE(t.paid,0) >= f.applicable_fee AND f.applicable_fee > 0 THEN 'PAID' WHEN COALESCE(t.paid,0) > 0 THEN 'PARTIALLY_PAID' ELSE 'PENDING' END`), 0, 'every status matches its allocations');
  assert.equal(await q(`SELECT count(*)::int n FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id
    WHERE ${inAcademy} AND f.status = 'ON_LEAVE' AND EXISTS (SELECT 1 FROM owner_payment_allocations al WHERE al.monthly_fee_id=f.id)`), 0, 'nothing is ever paid against ON_LEAVE');
  assert.equal(await q(`SELECT (count(*) - count(DISTINCT receipt_number))::int n FROM owner_payments WHERE academy_id = $1`), 0, 'receipt numbers unique');
  assert.equal(await q(`SELECT count(*)::int n FROM owner_payment_allocations al JOIN owner_payments p ON p.id=al.payment_id JOIN owner_monthly_fees f ON f.id=al.monthly_fee_id
    JOIN owner_memberships ms ON ms.id=f.membership_id WHERE p.academy_id = $1 AND ms.member_id <> p.member_id`), 0, 'allocations never cross members');
});
