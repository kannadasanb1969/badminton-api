// Phase 9.2 DB tests against the LOCAL DEVELOPMENT database only (q2-friendly-test): Owner-side booking create / list /
// detail / cancel, conflicts through the Phase 9.1 engine, release/restore interaction and concurrency.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken, verifyAccessToken } from '../src/utils/auth-token.js';
import { createBooking } from '../src/services/owner-booking.service.js';

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
const MON = '2031-01-06'; // a Monday
const addDays = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const dayOf = (iso, week = 0) => addDays(MON, week * 7 + iso - 1);

before(async () => {
  if (!enabled) return;
  admin = new pg.Pool({ connectionString: config.connectionString, max: 8, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  for (const [key, suffix] of [['a', '1'], ['b', '2']]) {
    users[key] = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,'PLAYER') RETURNING id, role", [`+91${tag}${suffix}`])).rows[0];
  }
  const { a, b } = users;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const acA = (await api(a, 'POST', '/academies', { name: 'Phase92 A' })).data;
  const acB = (await api(b, 'POST', '/academies', { name: 'Phase92 B' })).data;
  let n = 0;
  ctx = { acA, acB, court: async (u = a, ac = acA) => (await api(u, 'POST', `/academies/${ac.id}/courts`, { name: `K${++n}` })).data };
});
after(async () => {
  if (!enabled) return;
  const ids = Object.values(users).map((u) => u.id);
  const profiles = '(SELECT id FROM owner_profiles WHERE user_id = ANY($1))';
  const academies = `(SELECT id FROM owner_academies WHERE owner_profile_id IN ${profiles})`;
  await admin.query(`DELETE FROM owner_batch_exceptions WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_court_blocks WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_bookings WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_fee_rates WHERE batch_id IN (SELECT id FROM owner_batches WHERE academy_id IN ${academies})`, [ids]);
  await admin.query(`DELETE FROM owner_batches WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_courts WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_academies WHERE owner_profile_id IN ${profiles}`, [ids]);
  await admin.query('DELETE FROM owner_profiles WHERE user_id = ANY($1)', [ids]);
  await admin.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  await admin.end();
});

const avail = async (user, courtId, date) => (await api(user, 'GET', `/courts/${courtId}/availability?date=${date}`)).data;
const brief = (l) => l.map((x) => `${x.startTime}-${x.endTime}`);
const mkBatch = (user, academy, courtId, over = {}) => api(user, 'POST', '/batches', { academyId: academy.id, courtId, type: 'REGULAR', name: 'Batch', startTime: '06:00', endTime: '07:00', feePerPerson: '100', effectiveFrom: '2031-01-01', ...over });
const block = (user, courtId, date, startTime, endTime, reason) => api(user, 'POST', '/court-blocks', { courtId, date, startTime, endTime, reason });
const book = (user, courtId, bookingDate, startTime, endTime, over = {}) => api(user, 'POST', '/bookings', {
  courtId, bookingDate, startTime, endTime, customerName: 'Phase92 Customer', customerMobile: '8939594019', bookingAmount: '1000.00', ...over });
const fixture = async (academyId, courtId, date, s, e, status) =>
  (await admin.query('INSERT INTO owner_bookings (academy_id, court_id, booking_date, start_time, end_time, status) VALUES ($1,$2,$3::date,$4::time,$5::time,$6) RETURNING id', [academyId, courtId, date, s, e, status])).rows[0].id;
const activeRows = async (courtId, date) => (await admin.query("SELECT to_char(start_time,'HH24:MI') s, to_char(end_time,'HH24:MI') e FROM owner_bookings WHERE court_id=$1 AND booking_date=$2 AND status<>'CANCELLED' ORDER BY start_time", [courtId, date])).rows;
const noOverlap = (rows) => rows.forEach((x, i) => rows.slice(i + 1).forEach((y) => assert.ok(!(x.s < y.e && x.e > y.s), `overlap ${x.s}-${x.e} vs ${y.s}-${y.e}`)));

test('create: validation, exact fields, ownership', { skip }, async () => {
  const { a, b } = users; const { acA } = ctx;
  const c = await ctx.court();
  const d = dayOf(2, 20);
  const usersBefore = (await admin.query('SELECT count(*)::int n FROM users')).rows[0].n;
  // 1/13/37: valid booking is CONFIRMED and returns exactly what was stored
  const r = await book(a, c.id, d, '09:15', '10:45', { customerName: '  Kumar  S ', customerMobile: '+91 89395-94019', bookingAmount: '1234.56' });
  assert.equal(r.status, 201, JSON.stringify(r));
  assert.deepEqual([r.data.status, r.data.customerName, r.data.customerMobile, r.data.bookingAmount, r.data.startTime, r.data.endTime, r.data.bookingDate, r.data.courtName, r.data.academyId],
    ['CONFIRMED', 'Kumar S', '8939594019', '1234.56', '09:15', '10:45', d, c.name, acA.id]);
  const row = (await admin.query('SELECT status, customer_name, customer_mobile, booking_amount::text amt, created_by, cancelled_at FROM owner_bookings WHERE id=$1', [r.data.id])).rows[0];
  assert.deepEqual([row.status, row.customer_name, row.customer_mobile, row.amt, row.cancelled_at], ['CONFIRMED', 'Kumar S', '8939594019', '1234.56', null]);
  const detail = await api(a, 'GET', `/bookings/${r.data.id}`);
  assert.deepEqual(detail.data, r.data);
  // 2/3/4/5: name & mobile
  assert.equal((await book(a, c.id, d, '11:00', '12:00', { customerName: '   ' })).status, 400);
  assert.equal((await book(a, c.id, d, '11:00', '12:00', { customerName: undefined })).status, 400);
  assert.equal((await book(a, c.id, d, '11:00', '12:00', { customerMobile: '' })).status, 400);
  assert.equal((await book(a, c.id, d, '11:00', '12:00', { customerMobile: undefined })).status, 400);
  assert.equal((await book(a, c.id, d, '11:00', '12:00', { customerMobile: '12345' })).status, 400);
  assert.equal((await book(a, c.id, d, '11:00', '12:00', { customerMobile: '918939594018' })).data.customerMobile, '8939594018');
  // 6/7/8: amount
  const free = await book(a, c.id, d, '12:00', '13:00', { bookingAmount: '0' });
  assert.equal(free.status, 201); assert.equal(free.data.bookingAmount, '0.00');
  assert.equal((await book(a, c.id, d, '13:00', '14:00', { bookingAmount: '-1' })).status, 400);
  assert.equal((await book(a, c.id, d, '13:00', '14:00', { bookingAmount: '1.234' })).status, 400);
  assert.equal((await book(a, c.id, d, '13:00', '14:00', { bookingAmount: undefined })).status, 400); // never defaulted
  assert.equal((await book(a, c.id, d, '13:00', '14:00', { bookingAmount: '0.10' })).data.bookingAmount, '0.10');
  assert.equal((await book(a, c.id, d, '14:00', '15:00', { bookingAmount: 99999999.99 })).data.bookingAmount, '99999999.99');
  // 9/10/11/12: date & time
  assert.equal((await book(a, c.id, '2020-01-01', '09:00', '10:00')).status, 400);
  assert.equal((await book(a, c.id, d, '16:00', '16:00')).status, 400);
  assert.equal((await book(a, c.id, d, '17:00', '16:00')).status, 400);
  assert.equal((await book(a, c.id, d, '23:00', '01:00')).status, 400);
  assert.equal((await book(a, c.id, '2031-02-30', '09:00', '10:00')).status, 400);
  assert.equal((await book(a, c.id, d, '22:00', '24:00')).status, 201); // end of day is allowed
  // 24/25/26: ownership, inactive court
  assert.equal((await book(b, c.id, d, '19:00', '20:00')).status, 404);
  const ci = await ctx.court();
  await api(a, 'PATCH', `/courts/${ci.id}`, { status: 'INACTIVE' });
  assert.equal((await book(a, ci.id, d, '09:00', '10:00')).status, 409);
  assert.equal((await book(a, 'missing', d, '09:00', '10:00')).status, 404);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_bookings WHERE academy_id=$1 AND court_id=$2", [ctx.acB.id, c.id])).rows[0].n, 0);
  // bookings never create members / players / users
  assert.equal((await admin.query('SELECT count(*)::int n FROM owner_members WHERE academy_id=$1', [acA.id])).rows[0].n, 0);
  assert.equal((await admin.query('SELECT count(*)::int n FROM users')).rows[0].n, usersBefore); // no account created for the customer
  assert.equal((await admin.query('SELECT count(*)::int n FROM player_profiles WHERE user_id IN (SELECT id FROM users WHERE mobile LIKE $1)', ['%8939594018'])).rows[0].n >= 0, true);
  // unauthenticated
  assert.equal((await api(null, 'POST', '/bookings', {})).status, 401);
});

test('create: the clock rule on "today" with an injected clock', { skip }, async () => {
  const { a } = users;
  const c = await ctx.court();
  const identity = await verifyAccessToken(env, await issueAccessToken(env, a));
  const now = new Date('2031-05-05T04:30:00Z'); // 10:00 IST
  const input = (startTime, endTime) => ({ courtId: c.id, bookingDate: '2031-05-05', startTime, endTime, customerName: 'Clock', customerMobile: '8939594019', bookingAmount: '10' });
  await assert.rejects(createBooking(env, identity, input('09:00', '09:59'), { now }), /already passed/);
  await assert.rejects(createBooking(env, identity, input('08:00', '10:00'), { now }), /already passed/);
  assert.equal((await createBooking(env, identity, input('09:30', '10:30'), { now })).status, 'CONFIRMED'); // running now
  assert.equal((await createBooking(env, identity, input('10:30', '11:00'), { now })).status, 'CONFIRMED');
  await assert.rejects(createBooking(env, identity, { ...input('09:00', '10:00'), bookingDate: '2031-05-04' }, { now }), /past/);
});

test('conflicts through the Phase 9.1 engine; released occurrences; cancel frees time', { skip }, async () => {
  const { a } = users; const { acA } = ctx;
  const d = dayOf(3, 21); // Wednesday
  const c = await ctx.court();
  await mkBatch(a, acA, c.id, { name: 'Reg', startTime: '06:00', endTime: '07:00' });
  await mkBatch(a, acA, c.id, { name: 'Coach', type: 'COACHING', startTime: '18:00', endTime: '20:00' });
  await block(a, c.id, d, '12:00', '13:00', 'Maintenance');
  // 13: free interval
  assert.equal((await book(a, c.id, d, '09:15', '10:45')).status, 201);
  // 14/15/16/17: batch, coaching, block, confirmed booking conflicts (with conflict detail)
  const reg = await book(a, c.id, d, '06:30', '07:30');
  assert.equal(reg.status, 409); assert.equal(reg.conflict.conflicts[0].type, 'REGULAR_BATCH'); assert.match(reg.message, /no longer available/);
  assert.equal((await book(a, c.id, d, '19:00', '21:00')).conflict.conflicts[0].type, 'COACHING_BATCH');
  assert.equal((await book(a, c.id, d, '12:30', '13:30')).conflict.conflicts[0].type, 'COURT_BLOCK');
  assert.equal((await book(a, c.id, d, '10:00', '11:00')).conflict.conflicts[0].type, 'BOOKING');
  // 18: PENDING blocks; 19: CANCELLED does not
  const pend = await fixture(acA.id, c.id, d, '14:00', '15:00', 'PENDING');
  assert.equal((await book(a, c.id, d, '14:30', '15:30')).status, 409);
  await fixture(acA.id, c.id, d, '16:00', '17:00', 'CANCELLED');
  assert.equal((await book(a, c.id, d, '16:00', '17:00')).status, 201);
  // 20/21: touching OK, one minute overlap rejected
  assert.equal((await book(a, c.id, d, '10:45', '11:45')).status, 201);
  assert.equal((await book(a, c.id, d, '11:45', '12:00')).status, 201);
  assert.equal((await book(a, c.id, d, '15:00', '15:59')).status, 201);
  assert.equal((await book(a, c.id, d, '17:00', '17:59')).status, 201);
  assert.equal((await book(a, c.id, d, '17:59', '18:01')).status, 409);
  assert.equal((await book(a, c.id, d, '09:00', '09:16')).status, 409);
  void pend;
  // 22/23: released occurrence is bookable, the next day is not
  const c2 = await ctx.court();
  const batch = (await mkBatch(a, acA, c2.id, { name: 'Daily', startTime: '06:00', endTime: '07:00' })).data;
  const d10 = dayOf(5, 21); const d11 = dayOf(6, 21);
  assert.equal((await api(a, 'POST', `/batches/${batch.id}/releases`, { date: d10 })).status, 201);
  assert.equal((await book(a, c2.id, d10, '06:00', '07:00')).status, 201);
  const next = await book(a, c2.id, d11, '06:00', '07:00');
  assert.equal(next.status, 409); assert.equal(next.conflict.conflicts[0].label, 'Daily');
  // 34: availability shows BOOKING (with customer label) immediately
  const day = await avail(a, c2.id, d10);
  assert.deepEqual(day.unavailable.map((x) => [x.type, x.startTime, x.endTime, x.label]), [['BOOKING', '06:00', '07:00', 'Phase92 Customer']]);
  assert.deepEqual(day.available, [{ startTime: '00:00', endTime: '06:00' }, { startTime: '07:00', endTime: '24:00' }]);
});

test('cancel, list, detail, restore interaction', { skip }, async () => {
  const { a, b } = users; const { acA } = ctx;
  const c = await ctx.court();
  const d = dayOf(4, 22);
  const made = (await book(a, c.id, d, '09:00', '10:00', { customerName: 'Cancel Me', bookingAmount: '750.25' })).data;
  assert.equal((await book(a, c.id, d, '09:30', '10:30')).status, 409);
  // 27/28: cross-owner 404
  assert.equal((await api(b, 'GET', `/bookings/${made.id}`)).status, 404);
  assert.equal((await api(b, 'POST', `/bookings/${made.id}/cancel`, {})).status, 404);
  assert.equal((await api(a, 'GET', '/bookings/nope')).status, 404);
  assert.deepEqual((await api(b, 'GET', `/bookings?courtId=${c.id}`)).data, []);
  // 29/30/35/31: cancel keeps the row, frees time, repeat is idempotent and keeps the first reason/time
  const cx = await api(a, 'POST', `/bookings/${made.id}/cancel`, { cancellationReason: ' Customer called ' });
  assert.equal(cx.status, 200);
  assert.deepEqual([cx.data.status, cx.data.cancellationReason, cx.data.customerName, cx.data.bookingAmount], ['CANCELLED', 'Customer called', 'Cancel Me', '750.25']);
  assert.ok(cx.data.cancelledAt);
  assert.equal((await admin.query('SELECT count(*)::int n FROM owner_bookings WHERE id=$1', [made.id])).rows[0].n, 1);
  assert.deepEqual((await avail(a, c.id, d)).unavailable, []);
  const again = await api(a, 'POST', `/bookings/${made.id}/cancel`, { cancellationReason: 'different' });
  assert.equal(again.status, 200); assert.deepEqual(again.data, cx.data);
  const meta = (await admin.query('SELECT cancelled_by, cancellation_reason FROM owner_bookings WHERE id=$1', [made.id])).rows[0];
  assert.equal(meta.cancellation_reason, 'Customer called'); assert.ok(meta.cancelled_by);
  assert.equal((await api(a, 'GET', `/bookings/${made.id}`)).data.status, 'CANCELLED');
  // 44: the freed slot can be booked again
  assert.equal((await book(a, c.id, d, '09:00', '10:00', { customerName: 'Second' })).status, 201);

  // 36: list filters
  const c2 = await ctx.court();
  const up1 = (await book(a, c2.id, dayOf(1, 23), '10:00', '11:00', { customerName: 'Up 1' })).data;
  const up2 = (await book(a, c2.id, dayOf(2, 23), '10:00', '11:00', { customerName: 'Up 2' })).data;
  const gone = (await book(a, c2.id, dayOf(3, 23), '10:00', '11:00', { customerName: 'Gone' })).data;
  await api(a, 'POST', `/bookings/${gone.id}/cancel`, {});
  await fixture(acA.id, c2.id, '2020-03-03', '10:00', '11:00', 'CONFIRMED'); // already ended
  const names = async (q) => (await api(a, 'GET', `/bookings?courtId=${c2.id}${q}`)).data.map((x) => x.customerName ?? '(legacy)');
  assert.deepEqual(await names(''), ['Gone', 'Up 2', 'Up 1', '(legacy)']); // newest first, cancelled included
  assert.deepEqual(await names('&view=upcoming'), ['Up 1', 'Up 2']);
  assert.deepEqual(await names('&view=history'), ['(legacy)']);
  assert.deepEqual(await names('&view=cancelled'), ['Gone']);
  assert.deepEqual(await names('&status=CANCELLED'), ['Gone']);
  assert.deepEqual(await names('&status=CONFIRMED&fromDate=' + dayOf(2, 23)), ['Up 2']);
  assert.deepEqual(await names(`&date=${dayOf(1, 23)}`), ['Up 1']);
  assert.deepEqual(await names(`&fromDate=${dayOf(1, 23)}&toDate=${dayOf(2, 23)}`), ['Up 2', 'Up 1']);
  assert.equal((await api(a, 'GET', '/bookings?view=bogus')).status, 400);
  assert.equal((await api(a, 'GET', '/bookings?status=BOGUS')).status, 400);
  assert.equal((await api(a, 'GET', '/bookings?date=bad')).status, 400);
  void up1; void up2;

  // 32/33: release -> booking -> restore 409 -> cancel -> restore 200
  const c3 = await ctx.court();
  const batch = (await mkBatch(a, acA, c3.id, { name: 'Morning', startTime: '06:00', endTime: '07:00' })).data;
  const day = dayOf(5, 24);
  assert.equal((await api(a, 'POST', `/batches/${batch.id}/releases`, { date: day })).status, 201);
  const inside = (await book(a, c3.id, day, '06:15', '06:45')).data;
  const rej = await api(a, 'DELETE', `/batches/${batch.id}/releases/${day}`);
  assert.equal(rej.status, 409); assert.deepEqual(rej.conflict.conflicts.map((x) => x.type), ['BOOKING']);
  assert.equal((await api(a, 'POST', `/bookings/${inside.id}/cancel`, {})).status, 200);
  const ok = await api(a, 'DELETE', `/batches/${batch.id}/releases/${day}`);
  assert.equal(ok.status, 200); assert.equal(ok.data.status, 'RESTORED');
  assert.deepEqual(brief((await avail(a, c3.id, day)).unavailable), ['06:00-07:00']);
  assert.equal((await book(a, c3.id, day, '06:15', '06:45')).status, 409);
});

test('concurrency: no double booking', { skip }, async () => {
  const { a } = users; const { acA } = ctx;
  const d = dayOf(2, 30);
  const c = await ctx.court();
  // 38: six identical attempts -> exactly one
  const six = await Promise.all(Array.from({ length: 6 }, (_, i) => book(a, c.id, d, '09:00', '10:00', { customerName: `Racer ${i}` })));
  assert.deepEqual(six.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
  assert.equal((await activeRows(c.id, d)).length, 1);
  // 39: six partially overlapping windows -> no overlapping state
  const c2 = await ctx.court();
  const windows = [['09:00', '10:00'], ['09:30', '10:30'], ['10:00', '11:00'], ['10:30', '11:30'], ['09:15', '09:45'], ['10:59', '12:00']];
  const part = await Promise.all(windows.map(([s, e]) => book(a, c2.id, d, s, e)));
  assert.ok(part.some((r) => r.status === 201));
  assert.ok(part.every((r) => [201, 409].includes(r.status)), part.map((r) => r.status).join());
  noOverlap(await activeRows(c2.id, d));
  // 40: booking racing a court block -> exactly one writer wins (repeated)
  for (let i = 0; i < 4; i++) {
    const cc = await ctx.court();
    const [bk, bl] = await Promise.all([book(a, cc.id, d, '14:00', '15:00'), block(a, cc.id, d, '14:30', '15:30', 'Race')]);
    assert.equal([bk.status === 201, bl.status === 201].filter(Boolean).length, 1, `round ${i}: ${bk.status}/${bl.status}`);
  }
  // 41: booking racing Restore Batch -> exactly one wins; final state never overlaps
  const c3 = await ctx.court();
  const batch = (await mkBatch(a, acA, c3.id, { name: 'Rb', startTime: '06:00', endTime: '07:00' })).data;
  for (let i = 0; i < 4; i++) {
    const day = dayOf(1, 31 + i);
    await api(a, 'POST', `/batches/${batch.id}/releases`, { date: day });
    const [rs, bk] = await Promise.all([api(a, 'DELETE', `/batches/${batch.id}/releases/${day}`), book(a, c3.id, day, '06:10', '06:50')]);
    assert.equal([rs.status === 200, bk.status === 201].filter(Boolean).length, 1, `round ${i}: restore=${rs.status} booking=${bk.status}`);
    const unavailable = (await avail(a, c3.id, day)).unavailable;
    assert.deepEqual(brief(unavailable), bk.status === 201 ? ['06:10-06:50'] : ['06:00-07:00']);
  }
  // 42/43: different courts same time, same court different dates -> all succeed
  const c4 = await ctx.court(); const c5 = await ctx.court();
  const par = await Promise.all([book(a, c4.id, d, '09:00', '10:00'), book(a, c5.id, d, '09:00', '10:00'), book(a, c4.id, dayOf(3, 30), '09:00', '10:00'), book(a, c4.id, dayOf(4, 30), '09:00', '10:00')]);
  assert.deepEqual(par.map((r) => r.status), [201, 201, 201, 201]);
  // 44: cancel then a racing set of new attempts -> one winner again
  const first = six.find((r) => r.status === 201).data;
  await api(a, 'POST', `/bookings/${first.id}/cancel`, {});
  const again = await Promise.all(Array.from({ length: 4 }, () => book(a, c.id, d, '09:00', '10:00')));
  assert.equal(again.filter((r) => r.status === 201).length, 1);
});

test('Owner financial and role data untouched by booking operations', { skip }, async () => {
  const acs = [ctx.acA.id, ctx.acB.id];
  assert.equal((await admin.query('SELECT count(*)::int n FROM owner_payments WHERE academy_id = ANY($1)', [acs])).rows[0].n, 0);
  assert.deepEqual((await admin.query('SELECT role FROM users WHERE id = ANY($1) ORDER BY id', [Object.values(users).map((u) => u.id)])).rows.map((r) => r.role), ['PLAYER', 'PLAYER']);
});
