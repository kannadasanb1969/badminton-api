// Phase 9.3 DB tests against the LOCAL DEVELOPMENT database only (q2-friendly-test): manual booking payments, derived status,
// exact money, immutable receipts with transaction-time snapshots, cancellation policy and concurrency. No payment gateway.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { todayIST } from '../src/utils/owner-dates.js';

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
let admin; let ctx;

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(env, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, ...(await res.json()) };
}
const addDays = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const BASE = '2031-03-03';
let dayCounter = 0;

before(async () => {
  if (!enabled) return;
  admin = new pg.Pool({ connectionString: config.connectionString, max: 10, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  for (const [key, suffix] of [['a', '1'], ['b', '2']]) {
    users[key] = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,'PLAYER') RETURNING id, role", [`+91${tag}${suffix}`])).rows[0];
  }
  const { a, b } = users;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const acA = (await api(a, 'POST', '/academies', { name: 'Phase93 A' })).data;
  const acB = (await api(b, 'POST', '/academies', { name: 'Phase93 B' })).data;
  const courtA = (await api(a, 'POST', `/academies/${acA.id}/courts`, { name: 'P93-1' })).data;
  ctx = { acA, acB, courtA };
});
after(async () => {
  if (!enabled) return;
  const ids = Object.values(users).map((u) => u.id);
  const profiles = '(SELECT id FROM owner_profiles WHERE user_id = ANY($1))';
  const academies = `(SELECT id FROM owner_academies WHERE owner_profile_id IN ${profiles})`;
  const client = await admin.connect();
  try { // the cleanup switch is transaction-local and only ever set here; the application never sets it
    await client.query('BEGIN');
    await client.query("SELECT set_config('smashpoint.owner_booking_payment_cleanup', 'on', true)");
    await client.query(`DELETE FROM owner_booking_payments WHERE academy_id IN ${academies}`, [ids]);
    await client.query(`DELETE FROM owner_booking_receipt_counters WHERE academy_id IN ${academies}`, [ids]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  await admin.query(`DELETE FROM owner_bookings WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_courts WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_academies WHERE owner_profile_id IN ${profiles}`, [ids]);
  await admin.query('DELETE FROM owner_profiles WHERE user_id = ANY($1)', [ids]);
  await admin.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  await admin.end();
});

// each booking gets its own day so tests never collide on availability
const book = async (amount, over = {}) => {
  const r = await api(users.a, 'POST', '/bookings', { courtId: ctx.courtA.id, bookingDate: addDays(BASE, ++dayCounter), startTime: '09:00', endTime: '10:00',
    customerName: 'Phase93 Test Customer', customerMobile: '8939594019', bookingAmount: amount, ...over });
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.data;
};
const pay = (id, amount, over = {}, user = users.a) => api(user, 'POST', `/bookings/${id}/payments`, { amount, paymentMode: 'UPI', paymentDate: todayIST(), ...over });
const detail = async (id) => (await api(users.a, 'GET', `/bookings/${id}`)).data;
const rows = async (id) => (await admin.query('SELECT * FROM owner_booking_payments WHERE booking_id=$1 ORDER BY created_at', [id])).rows;

test('status flow: PENDING -> PARTIALLY_PAID -> PAID, balance, history and receipts', { skip }, async () => {
  const b = await book('1500.00');
  assert.deepEqual(b.paymentSummary, { bookingAmount: '1500.00', totalPaid: '0.00', balance: '1500.00', paymentStatus: 'PENDING' });
  const p1 = await pay(b.id, '500.00', { paymentMode: 'UPI', referenceNumber: ' UTR1 ', note: '' });
  assert.equal(p1.status, 201, JSON.stringify(p1));
  assert.deepEqual(p1.data.booking.paymentSummary, { bookingAmount: '1500.00', totalPaid: '500.00', balance: '1000.00', paymentStatus: 'PARTIALLY_PAID' });
  assert.match(p1.data.payment.receiptNumber, /^SPB-\d{4}-\d{6}$/);
  assert.equal(p1.data.payment.referenceNumber, 'UTR1'); assert.equal(p1.data.payment.note, null);
  assert.deepEqual(p1.data.payment.snapshot, { bookingAmount: '1500.00', paidNow: '500.00', totalPaidAfter: '500.00', balanceAfter: '1000.00', paymentStatus: 'PARTIALLY_PAID' });
  const p2 = await pay(b.id, '1000.00', { paymentMode: 'CASH' });
  assert.equal(p2.status, 201);
  assert.deepEqual(p2.data.booking.paymentSummary, { bookingAmount: '1500.00', totalPaid: '1500.00', balance: '0.00', paymentStatus: 'PAID' });
  assert.notEqual(p1.data.payment.receiptNumber, p2.data.payment.receiptNumber);
  // receipt 1 keeps its transaction-time snapshot after payment 2 (29/30)
  const r1 = (await api(users.a, 'GET', `/booking-payments/${p1.data.payment.id}/receipt`)).data;
  const r2 = (await api(users.a, 'GET', `/booking-payments/${p2.data.payment.id}/receipt`)).data;
  assert.deepEqual(r1.snapshot, { bookingAmount: '1500.00', paidNow: '500.00', totalPaidAfter: '500.00', balanceAfter: '1000.00', paymentStatus: 'PARTIALLY_PAID' });
  assert.deepEqual(r2.snapshot, { bookingAmount: '1500.00', paidNow: '1000.00', totalPaidAfter: '1500.00', balanceAfter: '0.00', paymentStatus: 'PAID' });
  assert.deepEqual([r1.customerName, r1.customerMobile, r1.academyName, r1.courtName, r1.bookingDate, r1.startTime, r1.endTime, r1.manuallyRecorded],
    ['Phase93 Test Customer', '8939594019', 'Phase93 A', 'P93-1', b.bookingDate, '09:00', '10:00', true]);
  // history: newest first, both visible, GET detail summary matches
  const hist = (await api(users.a, 'GET', `/bookings/${b.id}/payments`)).data;
  assert.deepEqual(hist.payments.map((p) => p.id), [p2.data.payment.id, p1.data.payment.id]);
  assert.equal(hist.paymentSummary.paymentStatus, 'PAID');
  assert.deepEqual((await detail(b.id)).paymentSummary, hist.paymentSummary);
  // fully paid -> further payment rejected
  assert.equal((await pay(b.id, '0.01')).status, 409);
});

test('complimentary 0.00 booking: PAID, no payment row, 0 payment rejected', { skip }, async () => {
  const b = await book('0');
  assert.deepEqual(b.paymentSummary, { bookingAmount: '0.00', totalPaid: '0.00', balance: '0.00', paymentStatus: 'PAID' });
  assert.equal((await pay(b.id, '0')).status, 400);
  assert.equal((await pay(b.id, '1.00')).status, 409);
  assert.equal((await rows(b.id)).length, 0);
});

test('validation over the API: nothing is stored for rejected payments', { skip }, async () => {
  const b = await book('100.00');
  for (const [amount, over] of [['0', {}], ['-1', {}], ['1.234', {}], ['1e1', {}], ['100.01', {}], ['10', { paymentMode: 'ONLINE_GATEWAY' }], ['10', { paymentDate: addDays(todayIST(), 1) }]]) {
    const r = await pay(b.id, amount, over);
    assert.ok([400, 409].includes(r.status), `${amount} ${JSON.stringify(over)} -> ${r.status}`);
  }
  assert.equal((await rows(b.id)).length, 0);
  assert.equal((await pay(b.id, '10', { paymentDate: '2026-01-01' })).status, 201); // earlier date accepted
  const blank = await pay(b.id, '10', { referenceNumber: '   ', note: '  ' });
  assert.deepEqual([blank.data.payment.referenceNumber, blank.data.payment.note], [null, null]);
  // client-supplied status / totals / receipt number are ignored
  const spoof = await pay(b.id, '10', { paymentStatus: 'PAID', totalPaid: '100', receiptNumber: 'SPB-2000-000001', balance_after: '0' });
  assert.equal(spoof.status, 201);
  assert.notEqual(spoof.data.payment.receiptNumber, 'SPB-2000-000001');
  assert.equal(spoof.data.payment.snapshot.paymentStatus, 'PARTIALLY_PAID');
  assert.equal(spoof.data.booking.paymentSummary.totalPaid, '30.00');
});

test('exact money: 0.10 + 0.20 on a 0.30 booking', { skip }, async () => {
  const b = await book('0.30');
  assert.equal((await pay(b.id, '0.10')).data.booking.paymentSummary.balance, '0.20');
  const last = await pay(b.id, '0.20');
  assert.deepEqual(last.data.booking.paymentSummary, { bookingAmount: '0.30', totalPaid: '0.30', balance: '0.00', paymentStatus: 'PAID' });
  assert.equal((await admin.query('SELECT SUM(amount)::text s FROM owner_booking_payments WHERE booking_id=$1', [b.id])).rows[0].s, '0.30');
  const c = await book('1250.50');
  assert.equal((await pay(c.id, '1250.50')).data.booking.paymentSummary.paymentStatus, 'PAID');
});

test('immutability: UPDATE and DELETE are refused by the database; snapshot columns cannot be forged on insert', { skip }, async () => {
  const b = await book('300.00');
  const p = (await pay(b.id, '100.00')).data.payment;
  await assert.rejects(() => admin.query('UPDATE owner_booking_payments SET amount = 1 WHERE id=$1', [p.id]), /immutable/);
  await assert.rejects(() => admin.query('UPDATE owner_booking_payments SET receipt_number = \'X\' WHERE id=$1', [p.id]), /immutable/);
  await assert.rejects(() => admin.query('DELETE FROM owner_booking_payments WHERE id=$1', [p.id]), /immutable/);
  // a raw insert (bypassing the service) cannot overpay, cannot forge the snapshot, cannot use a 0 amount
  const acId = ctx.acA.id;
  await assert.rejects(() => admin.query(`INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date) VALUES ($1,$2,'RAW-1',250,'CASH',CURRENT_DATE)`, [acId, b.id]), /exceeds/);
  await assert.rejects(() => admin.query(`INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date) VALUES ($1,$2,'RAW-2',0,'CASH',CURRENT_DATE)`, [acId, b.id]), /check/);
  await assert.rejects(() => admin.query(`INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date) VALUES ($1,$2,'RAW-3',10,'ONLINE_GATEWAY',CURRENT_DATE)`, [acId, b.id]), /check/);
  const forged = (await admin.query(`INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date, total_paid_after, balance_after, payment_status_after)
    VALUES ($1,$2,'RAW-4',50,'CASH',CURRENT_DATE,9999,0,'PAID') RETURNING total_paid_after::text t, balance_after::text bal, payment_status_after s`, [acId, b.id])).rows[0];
  assert.deepEqual([forged.t, forged.bal, forged.s], ['150.00', '150.00', 'PARTIALLY_PAID']);
  assert.equal((await rows(b.id)).length, 2);
  assert.equal((await detail(b.id)).paymentSummary.totalPaid, '150.00');
});

test('ownership: another Owner gets 404 for pay / list / receipt and nothing is written', { skip }, async () => {
  const b = await book('200.00');
  const p = (await pay(b.id, '50.00')).data.payment;
  assert.equal((await pay(b.id, '10', {}, users.b)).status, 404);
  assert.equal((await api(users.b, 'GET', `/bookings/${b.id}/payments`)).status, 404);
  assert.equal((await api(users.b, 'GET', `/booking-payments/${p.id}/receipt`)).status, 404);
  assert.equal((await api(users.a, 'GET', '/booking-payments/does-not-exist/receipt')).status, 404);
  assert.equal((await pay('does-not-exist', '10')).status, 404);
  assert.equal((await rows(b.id)).length, 1);
});

test('cancel with payment: history kept, no new payment, no refund, availability freed', { skip }, async () => {
  const b = await book('1500.00');
  const p = (await pay(b.id, '1000.00')).data.payment;
  const c = await api(users.a, 'POST', `/bookings/${b.id}/cancel`, { cancellationReason: 'Customer cancelled' });
  assert.equal(c.status, 200); assert.equal(c.data.status, 'CANCELLED');
  assert.deepEqual(c.data.paymentSummary, { bookingAmount: '1500.00', totalPaid: '1000.00', balance: '500.00', paymentStatus: 'PARTIALLY_PAID' });
  assert.equal((await rows(b.id)).length, 1);
  const receipt = (await api(users.a, 'GET', `/booking-payments/${p.id}/receipt`)).data;
  assert.equal(receipt.snapshot.totalPaidAfter, '1000.00'); assert.equal(receipt.bookingStatus, 'CANCELLED');
  assert.equal((await pay(b.id, '100.00')).status, 409); // rejected after cancellation
  assert.equal((await rows(b.id)).length, 1);
  const av = (await api(users.a, 'GET', `/courts/${ctx.courtA.id}/availability?date=${b.bookingDate}`)).data;
  assert.ok(av.available.some((x) => x.startTime === '00:00' && x.endTime === '24:00'), 'whole day available again');
  // raw insert on a cancelled booking is refused by the database too
  await assert.rejects(() => admin.query(`INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date) VALUES ($1,$2,'RAW-C',1,'CASH',CURRENT_DATE)`, [ctx.acA.id, b.id]), /CANCELLED/);
  // no refund concept exists: no table/column named refund in the booking-payment domain
  const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'owner_booking_payments'")).rows.map((r) => r.column_name);
  assert.ok(!cols.some((n) => /refund|revers/i.test(n)));
  // a booking cancelled with no payments is unaffected
  const free = await book('100.00');
  assert.equal((await api(users.a, 'POST', `/bookings/${free.id}/cancel`, {})).status, 200);
  assert.equal((await pay(free.id, '10')).status, 409);
});

test('concurrency: six simultaneous 400 payments on a 1000 booking never exceed 1000', { skip }, async () => {
  const b = await book('1000.00');
  const results = await Promise.all(Array.from({ length: 6 }, () => pay(b.id, '400.00')));
  const ok = results.filter((r) => r.status === 201);
  assert.equal(ok.length, 2, results.map((r) => r.status).join());
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409));
  const total = (await admin.query('SELECT SUM(amount)::text s, COUNT(*)::int n FROM owner_booking_payments WHERE booking_id=$1', [b.id])).rows[0];
  assert.deepEqual([total.s, total.n], ['800.00', 2]);
  // remaining 200: exactly one of several concurrent final-balance payments wins
  const last = await Promise.all(Array.from({ length: 5 }, () => pay(b.id, '200.00')));
  assert.equal(last.filter((r) => r.status === 201).length, 1);
  const d = await detail(b.id);
  assert.deepEqual(d.paymentSummary, { bookingAmount: '1000.00', totalPaid: '1000.00', balance: '0.00', paymentStatus: 'PAID' });
  // snapshots are a consistent running total in receipt order
  const snaps = (await admin.query('SELECT receipt_number, total_paid_after::text t, balance_after::text bal FROM owner_booking_payments WHERE booking_id=$1 ORDER BY receipt_number', [b.id])).rows;
  assert.deepEqual(snaps.map((s) => s.t), ['400.00', '800.00', '1000.00']);
});

test('concurrency: receipt numbers are unique and gapless across bookings of one academy', { skip }, async () => {
  const bookings = [];
  for (let i = 0; i < 4; i++) bookings.push(await book('100.00'));
  const results = await Promise.all(bookings.flatMap((b) => [pay(b.id, '10'), pay(b.id, '20')]));
  assert.ok(results.every((r) => r.status === 201), results.map((r) => r.status).join());
  const numbers = results.map((r) => r.data.payment.receiptNumber);
  assert.equal(new Set(numbers).size, numbers.length);
  const seq = numbers.map((n) => Number(n.split('-')[2])).sort((x, y) => x - y);
  assert.deepEqual(seq, seq.map((_, i) => seq[0] + i)); // consecutive
  const phase6 = (await admin.query("SELECT count(*)::int n FROM owner_payments WHERE academy_id=$1", [ctx.acA.id])).rows[0].n;
  assert.equal(phase6, 0); // Phase 6 tables untouched
});

test('failed transaction leaves no orphan payment and releases the receipt number', { skip }, async () => {
  const b = await book('100.00');
  const before = (await admin.query('SELECT COALESCE(max(last_number),0)::int n FROM owner_booking_receipt_counters WHERE academy_id=$1', [ctx.acA.id])).rows[0].n;
  const bad = await pay(b.id, '150.00'); // exceeds balance: rejected before any insert
  assert.equal(bad.status, 409);
  assert.equal((await rows(b.id)).length, 0);
  const afterBad = (await admin.query('SELECT COALESCE(max(last_number),0)::int n FROM owner_booking_receipt_counters WHERE academy_id=$1', [ctx.acA.id])).rows[0].n;
  assert.equal(afterBad, before);
  // a raw failing insert inside a transaction rolls the counter back with it
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO owner_booking_receipt_counters (academy_id, receipt_year, last_number) VALUES ($1, 2031, 1) ON CONFLICT (academy_id, receipt_year) DO UPDATE SET last_number = owner_booking_receipt_counters.last_number + 1`, [ctx.acA.id]);
    await assert.rejects(() => client.query(`INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date) VALUES ($1,$2,'RAW-F',500,'CASH',CURRENT_DATE)`, [ctx.acA.id, b.id]));
    await client.query('ROLLBACK');
  } finally { client.release(); }
  assert.equal((await rows(b.id)).length, 0);
  const ok = await pay(b.id, '10');
  assert.equal(ok.status, 201);
});

test('race: payment vs cancellation ends in a deterministic safe state', { skip }, async () => {
  for (let i = 0; i < 6; i++) {
    const b = await book('100.00');
    const [p, c] = await Promise.all([pay(b.id, '60.00'), api(users.a, 'POST', `/bookings/${b.id}/cancel`, {})]);
    assert.equal(c.status, 200);
    assert.ok([201, 409].includes(p.status), `payment status ${p.status}`);
    const n = (await rows(b.id)).length;
    assert.equal(n, p.status === 201 ? 1 : 0); // never a payment that the API said failed, never a lost successful one
    const d = await detail(b.id);
    assert.equal(d.status, 'CANCELLED');
    assert.equal(d.paymentSummary.totalPaid, p.status === 201 ? '60.00' : '0.00');
    assert.equal((await pay(b.id, '10')).status, 409);
  }
});

test('Phase 6 member-fee tables and users/roles are untouched by booking payments', { skip }, async () => {
  const b = await book('50.00');
  const q = async () => (await admin.query(`SELECT (SELECT count(*) FROM owner_payments)::int p, (SELECT count(*) FROM owner_payment_allocations)::int a,
    (SELECT count(*) FROM owner_monthly_fees)::int f, (SELECT count(*) FROM owner_receipt_counters)::int c, (SELECT count(*) FROM users WHERE role <> 'PLAYER')::int u`)).rows[0];
  const before = await q();
  await pay(b.id, '50.00');
  assert.deepEqual(await q(), before);
  assert.equal((await admin.query('SELECT role FROM users WHERE id=$1', [users.a.id])).rows[0].role, 'PLAYER');
});
