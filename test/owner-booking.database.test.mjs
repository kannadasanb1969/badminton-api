// Phase 9.1 DB tests against the LOCAL DEVELOPMENT database only (q2-friendly-test): batch calendar, one-day
// release/restore, court blocks, availability engine, conflict engine and concurrency. Throwaway users only;
// cleanup removes only rows created here. All dates are in 2031 so they never depend on "today".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';

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
let ctx;

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(env, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, ...(await res.json()) };
}

// 2031-01-06 is a Monday (asserted below). dayOf(isoDow, week) => calendar date of that weekday in a given week.
const MON = '2031-01-06';
const addDays = (ymd, n) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const dayOf = (iso, week = 0) => addDays(MON, week * 7 + iso - 1);

before(async () => {
  if (!enabled) return;
  assert.equal(new Date(`${MON}T00:00:00Z`).getUTCDay(), 1);
  admin = new pg.Pool({ connectionString: config.connectionString, max: 8, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  for (const [key, suffix] of [['a', '1'], ['b', '2']]) {
    users[key] = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,'PLAYER') RETURNING id, role", [`+91${tag}${suffix}`])).rows[0];
  }
  const { a, b } = users;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const acA = (await api(a, 'POST', '/academies', { name: 'Booking A' })).data;
  const acB = (await api(b, 'POST', '/academies', { name: 'Booking B' })).data;
  let n = 0;
  const court = async (user, ac) => (await api(user, 'POST', `/academies/${ac.id}/courts`, { name: `C${++n}` })).data;
  ctx = { acA, acB, court: (u = a, ac = acA) => court(u, ac) };
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

const iv = (startTime, endTime) => ({ startTime, endTime });
const avail = async (user, courtId, date) => { const r = await api(user, 'GET', `/courts/${courtId}/availability?date=${date}`); assert.equal(r.status, 200, JSON.stringify(r)); return r.data; };
const brief = (list) => list.map((x) => `${x.startTime}-${x.endTime}`);
const mkBatch = (user, academy, courtId, over = {}) => api(user, 'POST', '/batches', {
  academyId: academy.id, courtId, type: 'REGULAR', name: 'Batch', startTime: '06:00', endTime: '07:00', feePerPerson: '100',
  effectiveFrom: '2031-01-01', ...over });
const block = (user, courtId, date, startTime, endTime, reason) => api(user, 'POST', '/court-blocks', { courtId, date, startTime, endTime, reason });
const booking = async (academyId, courtId, date, s, e, status = 'CONFIRMED') =>
  (await admin.query("INSERT INTO owner_bookings (academy_id, court_id, booking_date, start_time, end_time, status) VALUES ($1,$2,$3::date,$4::time,$5::time,$6) RETURNING id", [academyId, courtId, date, s, e, status])).rows[0].id;

test('batch calendar: weekdays, effective dates, overlap algorithm, legacy defaults', { skip }, async () => {
  const { a } = users; const { acA } = ctx;

  // 1/5/12/13: a legacy-style row (inserted without the new columns) is Mon-Sun with no date bounds
  const cL = await ctx.court();
  const legacy = (await admin.query("INSERT INTO owner_batches (academy_id, court_id, batch_type, name, start_time, end_time, fee_per_person) VALUES ($1,$2,'REGULAR','Legacy','06:00','07:00',100) RETURNING days_of_week, effective_from, effective_to", [acA.id, cL.id])).rows[0];
  assert.deepEqual(legacy.days_of_week, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(legacy.effective_from, null); assert.equal(legacy.effective_to, null);
  for (const d of [dayOf(1), dayOf(7), '2020-02-29', '2099-12-31']) assert.deepEqual(brief((await avail(a, cL.id, d)).unavailable), ['06:00-07:00'], d);
  const listed = (await api(a, 'GET', `/batches?courtId=${cL.id}`)).data[0];
  assert.deepEqual([listed.daysOfWeek, listed.effectiveFrom, listed.effectiveTo], [[1, 2, 3, 4, 5, 6, 7], null, null]);

  // 2/3: Monday-only appears Monday, not Tuesday
  const c1 = await ctx.court();
  const mon = await mkBatch(a, acA, c1.id, { name: 'Mon', startTime: '18:00', endTime: '19:00', daysOfWeek: [1] });
  assert.equal(mon.status, 201); assert.deepEqual(mon.data.daysOfWeek, [1]);
  assert.deepEqual(brief((await avail(a, c1.id, dayOf(1))).unavailable), ['18:00-19:00']);
  assert.deepEqual((await avail(a, c1.id, dayOf(2))).unavailable, []);
  assert.deepEqual((await avail(a, c1.id, dayOf(1, 1))).unavailable.length, 1); // following Monday too
  // 6: same time on Tuesday coexists; 7: overlapping Monday conflicts (409 + detail)
  assert.equal((await mkBatch(a, acA, c1.id, { name: 'Tue', startTime: '18:00', endTime: '19:00', daysOfWeek: [2] })).status, 201);
  const clash = await mkBatch(a, acA, c1.id, { name: 'Mon2', startTime: '18:30', endTime: '19:30', daysOfWeek: [1, 3] });
  assert.equal(clash.status, 409); assert.equal(clash.conflict.name, 'Mon');
  assert.equal((await mkBatch(a, acA, c1.id, { name: 'MonTouch', startTime: '19:00', endTime: '20:00', daysOfWeek: [1] })).status, 201);

  // 4/19: Mon/Wed/Fri only; daily applies all 7
  const c2 = await ctx.court();
  assert.equal((await mkBatch(a, acA, c2.id, { name: 'MWF', daysOfWeek: [5, 1, 3] })).data.daysOfWeek.join(), '1,3,5');
  const hit = []; for (let i = 1; i <= 7; i++) if ((await avail(a, c2.id, dayOf(i))).unavailable.length) hit.push(i);
  assert.deepEqual(hit, [1, 3, 5]);
  const c3 = await ctx.court();
  await mkBatch(a, acA, c3.id, { name: 'Daily' });
  for (let i = 1; i <= 7; i++) assert.equal((await avail(a, c3.id, dayOf(i))).unavailable.length, 1);

  // 8/9: effective-range reuse vs overlap
  const c4 = await ctx.court();
  assert.equal((await mkBatch(a, acA, c4.id, { name: 'JanMar', daysOfWeek: [1], effectiveFrom: '2031-01-01', effectiveTo: '2031-03-31' })).status, 201);
  assert.equal((await mkBatch(a, acA, c4.id, { name: 'AprJun', daysOfWeek: [1], effectiveFrom: '2031-04-01', effectiveTo: '2031-06-30' })).status, 201);
  assert.equal((await mkBatch(a, acA, c4.id, { name: 'FebMay', daysOfWeek: [1], effectiveFrom: '2031-02-01', effectiveTo: '2031-05-31' })).status, 409);
  assert.equal((await mkBatch(a, acA, c4.id, { name: 'OpenEnded', daysOfWeek: [1], effectiveFrom: '2031-06-30' })).status, 409); // touches AprJun's last day
  assert.equal((await mkBatch(a, acA, c4.id, { name: 'OpenLater', daysOfWeek: [1], effectiveFrom: '2031-07-01' })).status, 201);
  // 10/11/13: before from / after to do not block; NULL effective_to continues indefinitely
  const c5 = await ctx.court();
  await mkBatch(a, acA, c5.id, { name: 'Bounded', effectiveFrom: '2031-03-01', effectiveTo: '2031-03-31' });
  assert.equal((await avail(a, c5.id, '2031-02-28')).unavailable.length, 0);
  assert.equal((await avail(a, c5.id, '2031-03-01')).unavailable.length, 1);
  assert.equal((await avail(a, c5.id, '2031-03-31')).unavailable.length, 1);
  assert.equal((await avail(a, c5.id, '2031-04-01')).unavailable.length, 0);
  const c6 = await ctx.court();
  await mkBatch(a, acA, c6.id, { name: 'Forever', effectiveFrom: '2031-03-01' });
  assert.equal((await avail(a, c6.id, '2031-02-28')).unavailable.length, 0);
  assert.equal((await avail(a, c6.id, '2099-01-01')).unavailable.length, 1);

  // 14: inactive batch does not block; 15/16/17 invalid input
  const c7 = await ctx.court();
  const b7 = await mkBatch(a, acA, c7.id, { name: 'Soon inactive' });
  assert.equal((await avail(a, c7.id, dayOf(1))).unavailable.length, 1);
  assert.equal((await api(a, 'PATCH', `/batches/${b7.data.id}`, { status: 'INACTIVE' })).status, 200);
  assert.equal((await avail(a, c7.id, dayOf(1))).unavailable.length, 0);
  assert.equal((await mkBatch(a, acA, c7.id, { daysOfWeek: [] })).status, 400);
  assert.equal((await mkBatch(a, acA, c7.id, { daysOfWeek: [0] })).status, 400);
  assert.equal((await mkBatch(a, acA, c7.id, { daysOfWeek: [8] })).status, 400);
  assert.equal((await mkBatch(a, acA, c7.id, { daysOfWeek: [2, 2] })).status, 400);
  assert.equal((await mkBatch(a, acA, c7.id, { effectiveFrom: '2031-05-02', effectiveTo: '2031-05-01' })).status, 400);
  assert.equal((await api(a, 'PATCH', `/batches/${mon.data.id}`, { effectiveTo: '2030-01-01' })).status, 400); // < existing from
  // DB itself rejects bad weekday arrays (defence in depth)
  await assert.rejects(admin.query("UPDATE owner_batches SET days_of_week = '{1,1}' WHERE id = $1", [mon.data.id]));
  await assert.rejects(admin.query("UPDATE owner_batches SET days_of_week = '{}' WHERE id = $1", [mon.data.id]));
  // patch schedule: editing weekdays re-runs overlap against other batches
  assert.equal((await api(a, 'PATCH', `/batches/${mon.data.id}`, { daysOfWeek: [1, 2] })).status, 409); // Tuesday batch has same time
  assert.equal((await api(a, 'PATCH', `/batches/${mon.data.id}`, { effectiveTo: '2031-12-31' })).status, 200);
  assert.equal((await api(a, 'PATCH', `/batches/${mon.data.id}`, { effectiveTo: null })).data.effectiveTo, null);
});

test('one-day release / restore', { skip }, async () => {
  const { a, b } = users; const { acA } = ctx;
  const c = await ctx.court();
  const morning = (await mkBatch(a, acA, c.id, { name: 'Morning Regular', startTime: '06:00', endTime: '07:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] })).data;
  const d9 = dayOf(5), d10 = dayOf(6), d11 = dayOf(7);
  const rel = (user, id, date, reason) => api(user, 'POST', `/batches/${id}/releases`, { date, reason });
  const restore = (user, id, date) => api(user, 'DELETE', `/batches/${id}/releases/${date}`);

  // 19/20/21/22/23
  for (const d of [d9, d10, d11]) assert.deepEqual(brief((await avail(a, c.id, d)).unavailable), ['06:00-07:00']);
  const r = await rel(a, morning.id, d10, 'No players');
  assert.equal(r.status, 201); assert.equal(r.data.status, 'ACTIVE');
  const day10 = await avail(a, c.id, d10);
  assert.deepEqual(day10.unavailable, []);
  assert.deepEqual(day10.available, [iv('00:00', '24:00')]);
  assert.deepEqual(day10.releasedBatches.map((x) => [x.label, x.startTime, x.endTime, x.batchId]), [['Morning Regular', '06:00', '07:00', morning.id]]);
  assert.equal((await avail(a, c.id, d9)).unavailable.length, 1);
  assert.equal((await avail(a, c.id, d11)).unavailable.length, 1);
  // 24/25/26: the recurring batch is untouched
  const after = (await api(a, 'GET', `/batches/${morning.id}`)).data;
  assert.deepEqual([after.status, after.daysOfWeek, after.effectiveFrom, after.effectiveTo, after.startTime, after.endTime],
    [morning.status, morning.daysOfWeek, morning.effectiveFrom, morning.effectiveTo, morning.startTime, morning.endTime]);
  // 32: duplicate release handled safely
  assert.equal((await rel(a, morning.id, d10)).status, 409);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_batch_exceptions WHERE batch_id=$1 AND exception_date=$2 AND status='ACTIVE'", [morning.id, d10])).rows[0].n, 1);

  // 27/28: released batch + booking / block still unavailable; availability derives from ALL blockers
  await booking(acA.id, c.id, d10, '06:30', '07:00');
  let day = await avail(a, c.id, d10);
  assert.deepEqual(brief(day.unavailable), ['06:30-07:00']);
  assert.deepEqual(day.available, [iv('00:00', '06:30'), iv('07:00', '24:00')]);
  assert.equal((await block(a, c.id, d10, '06:00', '06:30', 'Cleaning')).status, 201);
  day = await avail(a, c.id, d10);
  assert.deepEqual(brief(day.unavailable), ['06:00-06:30', '06:30-07:00']);
  assert.deepEqual(day.available, [iv('00:00', '06:00'), iv('07:00', '24:00')]);

  // 30/31: restore is rejected while a booking / block occupies the released time; nothing is changed
  const rej = await restore(a, morning.id, d10);
  assert.equal(rej.status, 409); assert.deepEqual(rej.conflict.conflicts.map((x) => x.type).sort(), ['BOOKING', 'COURT_BLOCK']);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_batch_exceptions WHERE batch_id=$1 AND exception_date=$2 AND status='ACTIVE'", [morning.id, d10])).rows[0].n, 1);
  await admin.query("UPDATE owner_bookings SET status='CANCELLED' WHERE court_id=$1", [c.id]);
  const blocks = (await api(a, 'GET', `/court-blocks?courtId=${c.id}&date=${d10}`)).data;
  assert.equal((await restore(a, morning.id, d10)).status, 409); // active block still there
  assert.equal((await api(a, 'DELETE', `/court-blocks/${blocks[0].id}`)).status, 200);
  // 29: restore makes the batch block the date again (history row kept)
  const ok = await restore(a, morning.id, d10);
  assert.equal(ok.status, 200); assert.equal(ok.data.status, 'RESTORED');
  assert.deepEqual(brief((await avail(a, c.id, d10)).unavailable), ['06:00-07:00']);
  assert.equal((await restore(a, morning.id, d10)).status, 409); // nothing left to restore
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_batch_exceptions WHERE batch_id=$1 AND exception_date=$2", [morning.id, d10])).rows[0].n, 1);
  // re-release after a restore is allowed (new live row, old one stays as history)
  assert.equal((await rel(a, morning.id, d10)).status, 201);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_batch_exceptions WHERE batch_id=$1 AND exception_date=$2", [morning.id, d10])).rows[0].n, 2);
  // 47: a block CAN use a released batch occurrence when nothing else is there
  const used = await block(a, c.id, d10, '06:00', '07:00', 'Maintenance');
  assert.equal(used.status, 201);
  assert.equal((await restore(a, morning.id, d10)).status, 409);

  // 33/34/35/36: cross-owner (404), unscheduled weekday, outside effective range, inactive batch
  assert.equal((await rel(b, morning.id, dayOf(1))).status, 404);
  assert.equal((await restore(b, morning.id, d10)).status, 404);
  const c2 = await ctx.court();
  const tue = (await mkBatch(a, acA, c2.id, { name: 'Tue only', daysOfWeek: [2], effectiveFrom: '2031-02-01', effectiveTo: '2031-02-28' })).data;
  assert.equal((await rel(a, tue.id, dayOf(3, 5))).status, 409); // a Wednesday
  assert.equal((await rel(a, tue.id, dayOf(2, 0))).status, 409); // Tuesday 2031-01-07, before effective_from
  assert.equal((await rel(a, tue.id, dayOf(2, 8))).status, 409); // Tuesday after effective_to
  assert.equal((await rel(a, tue.id, dayOf(2, 5))).status, 201); // Tuesday 2031-02-11 inside range
  await api(a, 'PATCH', `/batches/${tue.id}`, { status: 'INACTIVE' });
  assert.equal((await rel(a, tue.id, dayOf(2, 6))).status, 409);
  assert.equal((await rel(a, tue.id, 'nope')).status, 400);
  assert.equal((await rel(a, 'missing', d10)).status, 404);

  // releasing and then editing the schedule cannot create silent overlap with a block: batch edits are guarded
  const c3 = await ctx.court();
  const eve = (await mkBatch(a, acA, c3.id, { name: 'Eve', startTime: '17:00', endTime: '18:00', effectiveFrom: '2099-01-01', daysOfWeek: [1] })).data;
  const farMon = '2099-01-05';
  assert.equal((await rel(a, eve.id, farMon)).status, 201);
  assert.equal((await block(a, c3.id, farMon, '17:00', '18:00', 'Private event')).status, 201);
  assert.equal((await api(a, 'PATCH', `/batches/${eve.id}`, { startTime: '17:30', endTime: '18:30' })).status, 200); // release honoured
  assert.equal((await mkBatch(a, acA, c3.id, { name: 'Late', startTime: '17:00', endTime: '18:00', effectiveFrom: '2099-01-01', daysOfWeek: [1] })).status, 409);
});

test('court blocks + availability engine + conflict engine', { skip }, async () => {
  const { a, b } = users; const { acA, acB } = ctx;
  const date = dayOf(3, 2);

  // 37: empty day
  const c = await ctx.court();
  const empty = await avail(a, c.id, date);
  assert.deepEqual([empty.unavailable, empty.releasedBatches, empty.available], [[], [], [iv('00:00', '24:00')]]);
  assert.equal(empty.court.id, c.id);
  // 38/39: regular and coaching batches
  await mkBatch(a, acA, c.id, { name: 'Reg', startTime: '06:00', endTime: '07:00' });
  await mkBatch(a, acA, c.id, { name: 'Coach', type: 'COACHING', startTime: '18:00', endTime: '20:00' });
  let day = await avail(a, c.id, date);
  assert.deepEqual(day.unavailable.map((x) => [x.type, x.startTime, x.endTime, x.label]), [['REGULAR_BATCH', '06:00', '07:00', 'Reg'], ['COACHING_BATCH', '18:00', '20:00', 'Coach']]);
  assert.deepEqual(day.available, [iv('00:00', '06:00'), iv('07:00', '18:00'), iv('20:00', '24:00')]);

  // 40/52: a block removes availability; cancelling restores it (history kept)
  const m = await block(a, c.id, date, '12:00', '13:00', 'Maintenance');
  assert.equal(m.status, 201); assert.deepEqual([m.data.status, m.data.reason, m.data.date], ['ACTIVE', 'Maintenance', date]);
  day = await avail(a, c.id, date);
  assert.ok(day.unavailable.some((x) => x.type === 'COURT_BLOCK' && x.label === 'Maintenance' && x.blockId === m.data.id));
  assert.deepEqual(day.available, [iv('00:00', '06:00'), iv('07:00', '12:00'), iv('13:00', '18:00'), iv('20:00', '24:00')]);
  // 49 + 45 + 44: overlapping block rejected (one minute), touching accepted
  const dup = await block(a, c.id, date, '12:59', '14:00');
  assert.equal(dup.status, 409); assert.deepEqual(dup.conflict.conflicts.map((x) => [x.type, x.startTime, x.endTime]), [['COURT_BLOCK', '12:00', '13:00']]);
  assert.equal((await block(a, c.id, date, '13:00', '14:00', 'Touch after')).status, 201);
  assert.equal((await block(a, c.id, date, '11:00', '12:00', 'Touch before')).status, 201);
  assert.equal((await block(a, c.id, date, '10:15', '10:45')).status, 201); // arbitrary minutes, no slots
  // 41: cancelled block does not block
  const cancel = await api(a, 'DELETE', `/court-blocks/${m.data.id}`);
  assert.equal(cancel.status, 200); assert.equal(cancel.data.status, 'CANCELLED');
  assert.equal((await api(a, 'DELETE', `/court-blocks/${m.data.id}`)).status, 409);
  assert.equal((await block(a, c.id, date, '12:00', '13:00', 'Again')).status, 201);
  const history = (await api(a, 'GET', `/court-blocks?courtId=${c.id}&date=${date}`)).data;
  assert.ok(history.some((x) => x.id === m.data.id && x.status === 'CANCELLED'));
  assert.equal((await api(a, 'GET', `/court-blocks?courtId=${c.id}&date=${date}&status=ACTIVE`)).data.every((x) => x.status === 'ACTIVE'), true);

  // 46/48: block cannot overlap applicable batch or blocking booking
  const c2 = await ctx.court();
  await mkBatch(a, acA, c2.id, { name: 'Reg2', startTime: '06:00', endTime: '07:00', daysOfWeek: [3] });
  const bad = await block(a, c2.id, date, '06:30', '07:30');
  assert.equal(bad.status, 409); assert.equal(bad.conflict.conflicts[0].type, 'REGULAR_BATCH'); assert.equal(bad.conflict.conflicts[0].label, 'Reg2');
  assert.equal((await block(a, c2.id, date, '07:00', '08:00')).status, 201);
  assert.equal((await block(a, c2.id, dayOf(4, 2), '06:30', '07:30')).status, 201); // batch is Wed-only: Thursday free
  await booking(acA.id, c2.id, date, '15:00', '16:30', 'CONFIRMED');
  await booking(acA.id, c2.id, date, '17:00', '18:00', 'PENDING');
  const bk = await block(a, c2.id, date, '16:00', '17:00');
  assert.equal(bk.status, 409); assert.equal(bk.conflict.conflicts[0].type, 'BOOKING');
  assert.equal((await block(a, c2.id, date, '17:30', '18:30')).status, 409); // PENDING blocks too
  assert.equal((await block(a, c2.id, date, '16:30', '17:00')).status, 201); // touching both
  // 42/43: blocking booking removes availability, cancelled one does not
  await booking(acA.id, c2.id, date, '20:00', '21:00', 'CANCELLED');
  day = await avail(a, c2.id, date);
  assert.ok(day.unavailable.some((x) => x.type === 'BOOKING' && x.startTime === '15:00'));
  assert.ok(!day.unavailable.some((x) => x.startTime === '20:00'));
  assert.equal((await block(a, c2.id, date, '20:00', '21:00')).status, 201);

  // 50/51: adjacent unavailable intervals merge; separated blockers produce correct gaps
  const c3 = await ctx.court();
  await mkBatch(a, acA, c3.id, { name: 'Early', startTime: '06:00', endTime: '07:00', daysOfWeek: [3] });
  await block(a, c3.id, date, '07:00', '08:00', 'Right after');
  await block(a, c3.id, date, '12:00', '13:00', 'Mid');
  await booking(acA.id, c3.id, date, '15:00', '16:30');
  day = await avail(a, c3.id, date);
  assert.deepEqual(day.available, [iv('00:00', '06:00'), iv('08:00', '12:00'), iv('13:00', '15:00'), iv('16:30', '24:00')]);
  // end of day: block until 24:00 is allowed and leaves the last gap closed
  assert.equal((await block(a, c3.id, date, '22:00', '24:00', 'Closed late')).status, 201);
  assert.deepEqual((await avail(a, c3.id, date)).available.at(-1), iv('16:30', '22:00'));
  // fully blocked day => no availability
  const c4 = await ctx.court();
  assert.equal((await block(a, c4.id, date, '00:00', '24:00', 'Closed')).status, 201);
  assert.deepEqual((await avail(a, c4.id, date)).available, []);

  // validation: zero-length / reversed / overnight / bad date or time
  for (const [s, e] of [['09:00', '09:00'], ['10:00', '09:00'], ['23:00', '01:00'], ['9:00', '10:00'], ['09:00', '24:01']]) {
    assert.equal((await block(a, c.id, dayOf(5, 2), s, e)).status, 400, `${s}-${e}`);
  }
  assert.equal((await block(a, c.id, '2031-02-30', '09:00', '10:00')).status, 400);
  assert.equal((await block(a, c.id, undefined, '09:00', '10:00')).status, 400);
  assert.equal((await api(a, 'GET', `/courts/${c.id}/availability`)).status, 400);
  assert.equal((await api(a, 'GET', `/courts/${c.id}/availability?date=bad`)).status, 400);

  // 53/54: inactive court rejects new blocks; cross-owner court/block is 404
  const ci = await ctx.court();
  assert.equal((await api(a, 'PATCH', `/courts/${ci.id}`, { status: 'INACTIVE' })).status, 200);
  assert.equal((await block(a, ci.id, date, '09:00', '10:00')).status, 409);
  assert.equal((await block(b, c.id, date, '09:00', '10:00')).status, 404);
  assert.equal((await api(b, 'GET', `/courts/${c.id}/availability?date=${date}`)).status, 404);
  const mine = (await api(a, 'GET', `/court-blocks?courtId=${c.id}`)).data[0];
  assert.equal((await api(b, 'DELETE', `/court-blocks/${mine.id}`)).status, 404);
  assert.deepEqual((await api(b, 'GET', `/court-blocks?courtId=${c.id}`)).data, []);

  // a new batch cannot silently cover an existing future block (guard); an unrelated weekday is fine
  const c5 = await ctx.court();
  await block(a, c5.id, '2099-03-04', '10:00', '11:00', 'Booked off'); // a Wednesday
  assert.equal((await mkBatch(a, acA, c5.id, { startTime: '10:30', endTime: '11:30', daysOfWeek: [3], effectiveFrom: '2099-01-01' })).status, 409);
  assert.equal((await mkBatch(a, acA, c5.id, { startTime: '10:30', endTime: '11:30', daysOfWeek: [4], effectiveFrom: '2099-01-01' })).status, 201);
  void acB;
});

test('concurrency: one winner per court+date+time; independent courts and dates proceed', { skip }, async () => {
  const { a } = users; const { acA } = ctx;
  const date = dayOf(2, 3);
  const c = await ctx.court();

  // 55: six concurrent identical blocks => exactly one 201, five 409, one stored row
  const six = await Promise.all(Array.from({ length: 6 }, () => block(a, c.id, date, '09:00', '10:00', 'Race')));
  assert.deepEqual(six.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_court_blocks WHERE court_id=$1 AND status='ACTIVE'", [c.id])).rows[0].n, 1);
  // overlapping-but-different windows also serialise to a single winner
  const mixed = await Promise.all([['10:00', '11:00'], ['10:30', '11:30'], ['10:59', '12:00'], ['09:30', '10:01']].map(([s, e]) => block(a, c.id, date, s, e)));
  assert.equal(mixed.filter((r) => r.status === 201).length, 1);

  // 56/57: different courts same time, and same court different dates, both succeed concurrently
  const c2 = await ctx.court();
  const par = await Promise.all([block(a, c.id, dayOf(3, 3), '09:00', '10:00'), block(a, c2.id, date, '09:00', '10:00'), block(a, c.id, dayOf(4, 3), '09:00', '10:00'), block(a, c.id, dayOf(5, 3), '09:00', '10:00')]);
  assert.deepEqual(par.map((r) => r.status), [201, 201, 201, 201]);

  // 58: concurrent releases => no duplicate live exception
  const c3 = await ctx.court();
  const batch = (await mkBatch(a, acA, c3.id, { name: 'RaceBatch', daysOfWeek: [1, 2, 3, 4, 5, 6, 7] })).data;
  const rels = await Promise.all(Array.from({ length: 6 }, () => api(a, 'POST', `/batches/${batch.id}/releases`, { date })));
  assert.deepEqual(rels.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_batch_exceptions WHERE batch_id=$1 AND exception_date=$2 AND status='ACTIVE'", [batch.id, date])).rows[0].n, 1);

  // 59: restore racing a block inside the released period => exactly one wins; never overlapping state
  for (let i = 0; i < 4; i++) {
    const d = dayOf(1, 10 + i);
    await api(a, 'POST', `/batches/${batch.id}/releases`, { date: d });
    const [r, k] = await Promise.all([api(a, 'DELETE', `/batches/${batch.id}/releases/${d}`), block(a, c3.id, d, '06:30', '06:45', 'Race')]);
    // batch is 06:00-07:00; exactly one of restore / block may succeed
    assert.equal([r.status === 200, k.status === 201].filter(Boolean).length, 1, `round ${i}: restore=${r.status} block=${k.status}`);
    const day = await avail(a, c3.id, d);
    if (k.status === 201) assert.deepEqual(brief(day.unavailable), ['06:30-06:45']);
    else assert.deepEqual(brief(day.unavailable), ['06:00-07:00']);
  }
  // a booking racing a block (foundation fixture path used by Phase 9.2): same lock => one winner
  const c4 = await ctx.court();
  const { lockCourtDay } = await import('../src/repositories/owner-availability.repository.js');
  const { assertWindowFree } = await import('../src/services/owner-availability.service.js');
  const { withTransaction } = await import('../src/db/database.js');
  const profileId = (await admin.query('SELECT id FROM owner_profiles WHERE user_id=$1', [a.id])).rows[0].id;
  const tryBooking = () => withTransaction(env, async (db) => {
    await lockCourtDay(db, profileId, c4.id, date);
    await assertWindowFree(db, c4.id, date, '14:00', '15:00');
    await db.query("INSERT INTO owner_bookings (academy_id, court_id, booking_date, start_time, end_time, status) VALUES ($1,$2,$3::date,'14:00','15:00','CONFIRMED')", [acA.id, c4.id, date]);
    return 'ok';
  }).catch(() => 'conflict');
  const mix = await Promise.all([tryBooking(), block(a, c4.id, date, '14:00', '15:00').then((r) => (r.status === 201 ? 'ok' : 'conflict')), tryBooking(), tryBooking()]);
  assert.equal(mix.filter((x) => x === 'ok').length, 1, mix.join());
});

test('Owner financial and role data untouched by booking foundation operations', { skip }, async () => {
  const before = (await admin.query("SELECT count(*)::int n FROM owner_payments WHERE academy_id IN (SELECT id FROM owner_academies WHERE id = ANY($1))", [[ctx.acA.id, ctx.acB.id]])).rows[0].n;
  assert.equal(before, 0);
  const roles = (await admin.query('SELECT role FROM users WHERE id = ANY($1)', [Object.values(users).map((u) => u.id)])).rows.map((r) => r.role);
  assert.deepEqual(roles, ['PLAYER', 'PLAYER']);
});
