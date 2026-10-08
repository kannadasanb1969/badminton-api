// Phase 4 member/membership tests (A-Z) against the LOCAL DEVELOPMENT database only (q2-friendly-test).
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
const today = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 330 * 60 * 1000 - n * 864e5).toISOString().slice(0, 10);

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(env, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, ...(await res.json()) };
}

before(async () => {
  if (!enabled) return;
  // A pool, not one long-lived client: Neon drops idle sockets, and a dead single client makes the whole suite hang.
  admin = new pg.Pool({ connectionString: config.connectionString, max: 4, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  for (const [key, suffix] of [['a', '1'], ['b', '2']]) {
    users[key] = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,'PLAYER') RETURNING id, role", [`+91${tag}${suffix}`])).rows[0];
  }
});
after(async () => {
  if (!enabled) return;
  const ids = Object.values(users).map((u) => u.id);
  const profiles = "(SELECT id FROM owner_profiles WHERE user_id = ANY($1))";
  const academies = `(SELECT id FROM owner_academies WHERE owner_profile_id IN ${profiles})`;
  await admin.query(`DELETE FROM owner_memberships WHERE member_id IN (SELECT id FROM owner_members WHERE academy_id IN ${academies})`, [ids]);
  await admin.query(`DELETE FROM owner_members WHERE academy_id IN ${academies}`, [ids]);
  // Phase 5: batches own fee-rate rows (RESTRICT FK), so remove those first
  await admin.query(`DELETE FROM owner_fee_rates WHERE batch_id IN (SELECT id FROM owner_batches WHERE academy_id IN ${academies})`, [ids]);
  await admin.query(`DELETE FROM owner_batches WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_courts WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_academies WHERE owner_profile_id IN ${profiles}`, [ids]);
  await admin.query("DELETE FROM owner_profiles WHERE user_id = ANY($1)", [ids]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await admin.end();
});

test('owner members & memberships', { skip }, async () => {
  const { a, b } = users;
  const rolesBefore = (await admin.query('SELECT id, role FROM users WHERE id = ANY($1) ORDER BY id', [[a.id, b.id]])).rows;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const A1 = (await api(a, 'POST', '/academies', { name: 'A1' })).data;
  const A2 = (await api(a, 'POST', '/academies', { name: 'A2' })).data;
  const B1 = (await api(b, 'POST', '/academies', { name: 'B1' })).data;
  const court = async (u, ac, name) => (await api(u, 'POST', `/academies/${ac.id}/courts`, { name })).data;
  const batch = async (u, ac, c, type, name, s, e) => (await api(u, 'POST', '/batches', { academyId: ac.id, courtId: c.id, type, name, startTime: s, endTime: e, feePerPerson: '1000' })).data;
  const c1 = await court(a, A1, 'C1'), c2 = await court(a, A1, 'C2'), c3 = await court(a, A1, 'C3'), c4 = await court(a, A2, 'C4'), bc = await court(b, B1, 'BC');
  const reg1 = await batch(a, A1, c1, 'REGULAR', 'Reg 1', '06:00', '08:00');
  const reg2 = await batch(a, A1, c2, 'REGULAR', 'Reg 2', '06:00', '08:00');
  const coach = await batch(a, A1, c1, 'COACHING', 'Coach', '18:00', '20:00');
  const spare = await batch(a, A1, c2, 'REGULAR', 'Spare', '10:00', '11:00');
  const idle = await batch(a, A1, c3, 'REGULAR', 'Idle', '12:00', '13:00');
  const otherAcademy = await batch(a, A2, c4, 'REGULAR', 'Other academy', '06:00', '08:00');
  const bBatch = await batch(b, B1, bc, 'REGULAR', 'B Reg', '06:00', '08:00');
  for (const x of [reg1, reg2, coach, spare, idle, otherAcademy, bBatch]) assert.ok(x?.id, 'fixture batch');
  const mk = (u, ac, name, mobile) => api(u, 'POST', '/members', { academyId: ac.id, name, ...(mobile === undefined ? {} : { mobile }) });
  const assign = (u, memberId, batchId, extra = {}) => api(u, 'POST', `/members/${memberId}/memberships`, { batchId, ...extra });

  // A, B: create with / without mobile
  const m1 = await mk(a, A1, 'Sudhakar', '+91 98765 43210');
  assert.equal(m1.status, 201); assert.equal(m1.data.mobile, '9876543210'); assert.equal(m1.data.linkedUserId, null); assert.equal(m1.data.status, 'ACTIVE');
  const m2 = await mk(a, A1, 'Kumar');
  assert.equal(m2.status, 201); assert.equal(m2.data.mobile, null);
  assert.equal((await mk(a, A1, 'Kumar')).status, 201, 'name alone is never identity');
  assert.equal((await mk(a, A1, '')).status, 400);
  // client cannot set linkedUserId
  const sneaky = await api(a, 'POST', '/members', { academyId: A1.id, name: 'Sneaky', linkedUserId: b.id });
  assert.equal(sneaky.data.linkedUserId, null);
  // C: duplicate normalised mobile in same academy
  const dup = await mk(a, A1, 'Dup', '9876543210');
  assert.equal(dup.status, 409);
  assert.equal((await mk(a, A1, 'Dup2', '09876543210')).status, 409);
  // D: same mobile in another academy of the same owner and of another owner
  assert.equal((await mk(a, A2, 'Sudhakar@A2', '9876543210')).status, 201);
  assert.equal((await mk(b, B1, 'Sudhakar@B', '9876543210')).status, 201);

  // E, F, G
  const e = await assign(a, m1.data.id, reg1.id, { startDate: daysAgo(10) });
  assert.equal(e.status, 201); assert.deepEqual([e.data.status, e.data.endDate, e.data.startDate, e.data.batch.type], ['ACTIVE', null, daysAgo(10), 'REGULAR']);
  const f = await assign(a, m1.data.id, coach.id);
  assert.equal(f.status, 201); assert.equal(f.data.batch.type, 'COACHING'); assert.equal(f.data.startDate, today());
  const detail = (await api(a, 'GET', `/members/${m1.data.id}`)).data;
  assert.equal(detail.activeMemberships.length, 2, 'G: regular + coaching simultaneously');
  assert.equal(detail.history.length, 0);
  assert.equal(detail.activeMemberships[0].batch.courtName, 'C1');
  // H
  assert.equal((await assign(a, m1.data.id, reg1.id)).status, 409);
  // I: cross-academy (same owner) and other owner's batch
  assert.equal((await assign(a, m1.data.id, otherAcademy.id)).status, 409);
  assert.equal((await assign(a, m1.data.id, bBatch.id)).status, 404);
  // J: inactive batch
  assert.equal((await api(a, 'PATCH', `/batches/${spare.id}`, { status: 'INACTIVE' })).status, 200);
  assert.equal((await assign(a, m1.data.id, spare.id)).status, 409);
  // K: court inactive while batch still active (forced directly in the test DB to hit this branch)
  await admin.query("UPDATE owner_courts SET status='INACTIVE' WHERE id=$1", [c3.id]);
  const k = await assign(a, m1.data.id, idle.id);
  assert.equal(k.status, 409); assert.match(k.message, /court is inactive/i);
  await admin.query("UPDATE owner_courts SET status='ACTIVE' WHERE id=$1", [c3.id]);
  // bad dates
  assert.equal((await assign(a, m2.data.id, reg2.id, { startDate: '2999-01-01' })).status, 400);
  assert.equal((await assign(a, m2.data.id, reg2.id, { startDate: 'tomorrow' })).status, 400);

  // L, M: move preserves history
  const move = await api(a, 'POST', `/memberships/${e.data.id}/move`, { batchId: reg2.id, effectiveDate: daysAgo(2) });
  assert.equal(move.status, 200); assert.deepEqual([move.data.status, move.data.startDate, move.data.batchId], ['ACTIVE', daysAgo(2), reg2.id]);
  const afterMove = (await api(a, 'GET', `/members/${m1.data.id}`)).data;
  assert.equal(afterMove.activeMemberships.length, 2);
  assert.equal(afterMove.history.length, 1);
  assert.deepEqual([afterMove.history[0].id, afterMove.history[0].status, afterMove.history[0].endDate, afterMove.history[0].startDate, afterMove.history[0].batchId], [e.data.id, 'ENDED', daysAgo(2), daysAgo(10), reg1.id]);
  // O, P
  assert.equal((await api(a, 'POST', `/memberships/${move.data.id}/move`, { batchId: reg2.id })).status, 409, 'same batch');
  assert.equal((await api(a, 'POST', `/memberships/${move.data.id}/move`, { batchId: spare.id })).status, 409, 'inactive destination');
  assert.equal((await api(a, 'POST', `/memberships/${move.data.id}/move`, { batchId: otherAcademy.id })).status, 409, 'cross-academy destination');
  assert.equal((await api(a, 'POST', `/memberships/${move.data.id}/move`, { batchId: reg1.id, effectiveDate: daysAgo(30) })).status, 400, 'before start date');
  assert.equal((await api(a, 'POST', `/memberships/${move.data.id}/move`, { batchId: reg1.id, effectiveDate: '2999-01-01' })).status, 400, 'future');
  // N: atomic. Moving the coaching membership onto reg2 where the member already has an ACTIVE row fails at the
  // unique index AFTER the old row was ended inside the transaction; the old row must still be ACTIVE.
  const failed = await api(a, 'POST', `/memberships/${f.data.id}/move`, { batchId: reg2.id });
  assert.equal(failed.status, 409);
  const still = (await admin.query("SELECT status, end_date FROM owner_memberships WHERE id=$1", [f.data.id])).rows[0];
  assert.deepEqual([still.status, still.end_date], ['ACTIVE', null], 'old membership untouched after failed move');
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_memberships WHERE member_id=$1", [m1.data.id])).rows[0].n, 3, 'no partial rows');

  // S: deactivation blocked while memberships active
  const s = await api(a, 'PATCH', `/members/${m1.data.id}`, { status: 'INACTIVE' });
  assert.equal(s.status, 409);
  assert.equal((await admin.query("SELECT status FROM owner_members WHERE id=$1", [m1.data.id])).rows[0].status, 'ACTIVE');
  // U: batch deactivation blocked while a membership is active (Phase 3 rule extended)
  const u = await api(a, 'PATCH', `/batches/${reg2.id}`, { status: 'INACTIVE' });
  assert.equal(u.status, 409); assert.match(u.message, /active memberships/i);
  assert.equal((await api(a, 'PATCH', `/batches/${reg2.id}`, { name: 'Reg 2 renamed' })).status, 200, 'other batch edits still fine');
  // Q, R: end preserves row; second end rejected
  const end1 = await api(a, 'POST', `/memberships/${f.data.id}/end`, { effectiveDate: today() });
  assert.equal(end1.status, 200); assert.deepEqual([end1.data.status, end1.data.endDate], ['ENDED', today()]);
  assert.equal((await api(a, 'POST', `/memberships/${f.data.id}/end`, {})).status, 409);
  assert.equal((await api(a, 'POST', `/memberships/${f.data.id}/move`, { batchId: reg1.id })).status, 409, 'cannot move an ended membership');
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_memberships WHERE id=$1", [f.data.id])).rows[0].n, 1, 'row kept');
  // W, X: Owner B isolation
  assert.equal((await api(b, 'GET', `/members/${m1.data.id}`)).status, 404);
  assert.equal((await api(b, 'PATCH', `/members/${m1.data.id}`, { name: 'hijack' })).status, 404);
  assert.equal((await api(b, 'GET', `/members/${m1.data.id}/memberships`)).status, 404);
  assert.equal((await assign(b, m1.data.id, bBatch.id)).status, 404, "B assigning A's member");
  assert.equal((await assign(b, (await mk(b, B1, 'B guy')).data.id, reg1.id)).status, 404, "B assigning to A's batch");
  assert.equal((await api(b, 'POST', `/memberships/${move.data.id}/move`, { batchId: bBatch.id })).status, 404);
  assert.equal((await api(b, 'POST', `/memberships/${move.data.id}/end`, {})).status, 404);
  assert.equal((await mk(b, A1, 'into A1')).status, 404, "B creating in A's academy");
  assert.ok((await api(b, 'GET', '/members')).data.every((x) => x.academyId === B1.id));
  assert.equal((await admin.query("SELECT status FROM owner_memberships WHERE id=$1", [move.data.id])).rows[0].status, 'ACTIVE');
  // list: single response with summaries, correct counts
  const list = (await api(a, 'GET', `/members?academyId=${A1.id}`)).data;
  const listed = list.find((x) => x.id === m1.data.id);
  assert.equal(listed.activeMembershipCount, 1); assert.equal(listed.activeMemberships[0].batchName, 'Reg 2 renamed');
  // end remaining, then T and V
  assert.equal((await api(a, 'POST', `/memberships/${move.data.id}/end`, { effectiveDate: today() })).status, 200);
  assert.equal((await api(a, 'PATCH', `/members/${m1.data.id}`, { status: 'INACTIVE' })).data.status, 'INACTIVE');
  assert.equal((await assign(a, m1.data.id, reg1.id)).status, 409, 'inactive member cannot be assigned');
  assert.equal((await api(a, 'PATCH', `/batches/${reg2.id}`, { status: 'INACTIVE' })).data.status, 'INACTIVE', 'V');
  assert.equal((await api(a, 'GET', `/members/${m1.data.id}`)).data.history.length, 3, 'history intact');
  // inactive member's mobile is released; reactivating while taken is refused
  const reuse = await mk(a, A1, 'New owner of number', '9876543210');
  assert.equal(reuse.status, 201);
  assert.equal((await api(a, 'PATCH', `/members/${m1.data.id}`, { status: 'ACTIVE' })).status, 409);
  // dashboard count
  assert.ok((await api(a, 'GET', `/academies/${A1.id}`)).data.activeMemberCount >= 3);
  // Z: roles unchanged
  assert.deepEqual((await admin.query('SELECT id, role FROM users WHERE id = ANY($1) ORDER BY id', [[a.id, b.id]])).rows, rolesBefore);
  assert.equal((await admin.query("SELECT count(*)::int n FROM users WHERE mobile LIKE $1", [`+91${tag}%`])).rows[0].n, 2, 'no users created by member operations');
});

test('concurrency: duplicates, moves and deactivation races', { skip }, async () => {
  const { a } = users;
  await api(a, 'POST', '/profile');
  const ac = (await api(a, 'POST', '/academies', { name: 'Race academy' })).data;
  const court = async (n) => (await api(a, 'POST', `/academies/${ac.id}/courts`, { name: n })).data;
  const [r1, r2, r3, r4] = [await court('R1'), await court('R2'), await court('R3'), await court('R4')];
  const batch = async (c, n) => (await api(a, 'POST', '/batches', { academyId: ac.id, courtId: c.id, type: 'REGULAR', name: n, startTime: '06:00', endTime: '07:00', feePerPerson: '10' })).data;
  const [b1, b2, b3, b4] = [await batch(r1, 'B1'), await batch(r2, 'B2'), await batch(r3, 'B3'), await batch(r4, 'B4')];
  const m = (await api(a, 'POST', '/members', { academyId: ac.id, name: 'Racer', mobile: '9000011111' })).data;
  const count = async (sql, p) => (await admin.query(sql, p)).rows[0].n;

  // same mobile created concurrently -> exactly one
  const mobiles = await Promise.all(Array.from({ length: 6 }, (_, i) => api(a, 'POST', '/members', { academyId: ac.id, name: `Same mobile ${i}`, mobile: '9000022222' })));
  assert.equal(mobiles.filter((r) => r.status === 201).length, 1);
  assert.equal(mobiles.filter((r) => r.status === 409).length, 5);

  // duplicate concurrent assignment -> exactly one ACTIVE row
  const dupes = await Promise.all(Array.from({ length: 6 }, () => api(a, 'POST', `/members/${m.id}/memberships`, { batchId: b1.id })));
  assert.equal(dupes.filter((r) => r.status === 201).length, 1);
  assert.equal(dupes.filter((r) => r.status === 409).length, 5);
  assert.equal(await count("SELECT count(*)::int n FROM owner_memberships WHERE member_id=$1 AND batch_id=$2 AND status='ACTIVE'", [m.id, b1.id]), 1);
  const ms = dupes.find((r) => r.status === 201).data;

  // concurrent moves of the SAME membership to different destinations -> exactly one wins, old ended once
  const moves = await Promise.all([b2, b3, b4, b2, b3, b4].map((b) => api(a, 'POST', `/memberships/${ms.id}/move`, { batchId: b.id })));
  assert.equal(moves.filter((r) => r.status === 200).length, 1);
  assert.equal(moves.filter((r) => r.status === 409).length, 5);
  assert.equal(await count("SELECT count(*)::int n FROM owner_memberships WHERE member_id=$1 AND status='ACTIVE'", [m.id]), 1, 'exactly one active line');
  assert.equal(await count("SELECT count(*)::int n FROM owner_memberships WHERE member_id=$1", [m.id]), 2, 'one ended + one active, no strays');
  const winner = moves.find((r) => r.status === 200).data;

  // member deactivation racing with a new assignment: never "inactive member with active membership"
  const other = (await api(a, 'POST', '/members', { academyId: ac.id, name: 'Racer 2' })).data;
  await Promise.all([api(a, 'PATCH', `/members/${other.id}`, { status: 'INACTIVE' }), api(a, 'POST', `/members/${other.id}/memberships`, { batchId: b1.id })]);
  assert.equal(await count("SELECT count(*)::int n FROM owner_members m JOIN owner_memberships s ON s.member_id=m.id WHERE m.id=$1 AND m.status='INACTIVE' AND s.status='ACTIVE'", [other.id]), 0);

  // batch deactivation racing with assignment: never "inactive batch with active membership"
  const third = (await api(a, 'POST', '/members', { academyId: ac.id, name: 'Racer 3' })).data;
  await Promise.all([api(a, 'PATCH', `/batches/${b1.id}`, { status: 'INACTIVE' }), api(a, 'POST', `/members/${third.id}/memberships`, { batchId: b1.id })]);
  assert.equal(await count("SELECT count(*)::int n FROM owner_batches b JOIN owner_memberships s ON s.batch_id=b.id WHERE b.id=$1 AND b.status='INACTIVE' AND s.status='ACTIVE'", [b1.id]), 0);
  assert.ok(winner.batchId);
});
