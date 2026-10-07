// Phase 3 batch tests (A-S) against the LOCAL DEVELOPMENT database only (q2-friendly-test).
// Same safety gates as owner.database.test.mjs; creates throwaway users and removes only its own rows.
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
const tag = String(Math.floor(Math.random() * 9e7) + 1e7); // random so parallel test files never share a mobile
const users = {};
let admin;

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
  // Phase 5: batches own fee-rate rows (RESTRICT FK), so remove those first
  await admin.query(`DELETE FROM owner_fee_rates WHERE batch_id IN (SELECT id FROM owner_batches WHERE academy_id IN ${academies})`, [ids]);
  await admin.query(`DELETE FROM owner_batches WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_courts WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_academies WHERE owner_profile_id IN ${profiles}`, [ids]);
  await admin.query("DELETE FROM owner_profiles WHERE user_id = ANY($1)", [ids]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await admin.end();
});

test('owner batch rules', { skip }, async () => {
  const { a, b } = users;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const acA = (await api(a, 'POST', '/academies', { name: 'A Academy' })).data;
  const acB = (await api(b, 'POST', '/academies', { name: 'B Academy' })).data;
  const mk = async (user, academy, name) => (await api(user, 'POST', `/academies/${academy.id}/courts`, { name })).data;
  const c1 = await mk(a, acA, 'Court 1'), c2 = await mk(a, acA, 'Court 2'), c3 = await mk(a, acA, 'Court 3');
  const bc1 = await mk(b, acB, 'B Court');
  const post = (user, courtId, over = {}, academyId = acA.id) => api(user, 'POST', '/batches', { academyId, courtId, type: 'REGULAR', name: 'Batch', startTime: '06:00', endTime: '08:00', feePerPerson: '1500', ...over });

  // A, C, D
  const reg = await post(a, c1.id, { name: 'Morning Regular', startTime: '06:10', endTime: '08:00', feePerPerson: '1234.50' });
  assert.equal(reg.status, 201);
  assert.deepEqual([reg.data.type, reg.data.startTime, reg.data.endTime, reg.data.feePerPerson, reg.data.status, reg.data.courtName], ['REGULAR', '06:10', '08:00', '1234.50', 'ACTIVE', 'Court 1']);
  // B + G (touching boundary)
  const coach = await post(a, c1.id, { type: 'COACHING', name: 'Coaching', startTime: '08:00', endTime: '09:30', feePerPerson: 0 });
  assert.equal(coach.status, 201); assert.equal(coach.data.type, 'COACHING'); assert.equal(coach.data.feePerPerson, '0.00');
  // E, F
  const e = await post(a, c1.id, { startTime: '07:00', endTime: '07:30' });
  assert.equal(e.status, 409); assert.equal(e.conflict.name, 'Morning Regular');
  assert.equal((await post(a, c1.id, { type: 'COACHING', startTime: '09:00', endTime: '10:00' })).status, 409);
  assert.equal((await post(a, c1.id, { startTime: '05:00', endTime: '06:11' })).status, 409);
  assert.equal((await post(a, c1.id, { startTime: '05:00', endTime: '06:10' })).status, 201, 'touching before start');
  // H
  const other = await post(a, c2.id, { startTime: '06:10', endTime: '08:00' });
  assert.equal(other.status, 201);
  // M, N
  assert.equal((await post(a, c3.id, { startTime: '09:00', endTime: '09:00' })).status, 400);
  assert.equal((await post(a, c3.id, { startTime: '10:00', endTime: '09:00' })).status, 400);
  assert.equal((await post(a, c3.id, { feePerPerson: '-5' })).status, 400);
  assert.equal((await post(a, c3.id, { feePerPerson: undefined })).status, 400);
  // I: inactive does not block
  assert.equal((await api(a, 'PATCH', `/batches/${reg.data.id}`, { status: 'INACTIVE' })).data.status, 'INACTIVE');
  const replacement = await post(a, c1.id, { name: 'Replacement', startTime: '06:30', endTime: '07:30' });
  assert.equal(replacement.status, 201);
  // J: reactivate conflicting
  const j = await api(a, 'PATCH', `/batches/${reg.data.id}`, { status: 'ACTIVE' });
  assert.equal(j.status, 409); assert.equal(j.conflict.name, 'Replacement');
  // name/fee-only edits on active batch do not re-conflict with itself
  // Phase 5: the fee is no longer an editable batch field (effective-dated rates are the source of truth)
  const feeEdit = await api(a, 'PATCH', `/batches/${replacement.data.id}`, { name: 'Renamed', feePerPerson: '1750.75' });
  assert.equal(feeEdit.status, 409);
  const edit = await api(a, 'PATCH', `/batches/${replacement.data.id}`, { name: 'Renamed' });
  assert.deepEqual([edit.status, edit.data.name, edit.data.feePerPerson, edit.data.currentFee], [200, 'Renamed', '1500.00', '1500.00']);
  assert.equal((await api(a, 'PATCH', `/batches/${replacement.data.id}`, { startTime: '06:30', endTime: '07:45' })).status, 200, 'own range excluded');
  // K: timing into conflict
  assert.equal((await api(a, 'PATCH', `/batches/${replacement.data.id}`, { endTime: '08:30' })).status, 409);
  // L: move to conflicting court (c2 has 06:10-08:00)
  assert.equal((await api(a, 'PATCH', `/batches/${replacement.data.id}`, { courtId: c2.id })).status, 409);
  assert.equal((await api(a, 'PATCH', `/batches/${replacement.data.id}`, { courtId: c3.id })).data.courtName, 'Court 3');
  // start>=end on patch
  assert.equal((await api(a, 'PATCH', `/batches/${replacement.data.id}`, { startTime: '23:00' })).status, 400);
  // now reg can reactivate (replacement moved away)
  assert.equal((await api(a, 'PATCH', `/batches/${reg.data.id}`, { status: 'ACTIVE' })).status, 200);
  // S: deactivating a court with active batches is refused; without active batches it works
  const s1 = await api(a, 'PATCH', `/courts/${c1.id}`, { status: 'INACTIVE' });
  assert.equal(s1.status, 409);
  assert.equal((await api(a, 'GET', `/academies/${acA.id}/courts`)).data.find((c) => c.id === c1.id).status, 'ACTIVE');
  assert.equal((await api(a, 'PATCH', `/courts/${c1.id}`, { name: 'Court One' })).status, 200, 'rename still allowed');
  // R: inactive court rejects new active batch; history preserved
  const spare = await mk(a, acA, 'Spare');
  assert.equal((await api(a, 'PATCH', `/courts/${spare.id}`, { status: 'INACTIVE' })).status, 200);
  assert.equal((await post(a, spare.id)).status, 409);
  const hist = await post(a, c3.id, { name: 'Late', startTime: '20:00', endTime: '21:00' });
  await api(a, 'PATCH', `/batches/${hist.data.id}`, { status: 'INACTIVE' });
  const c3batches = (await api(a, 'GET', `/batches?courtId=${c3.id}`)).data;
  assert.ok(c3batches.some((x) => x.id === hist.data.id && x.status === 'INACTIVE'));
  await api(a, 'PATCH', `/batches/${replacement.data.id}`, { status: 'INACTIVE' });
  assert.equal((await api(a, 'PATCH', `/courts/${c3.id}`, { status: 'INACTIVE' })).status, 200, 'only inactive batches -> allowed');
  assert.equal((await api(a, 'PATCH', `/batches/${hist.data.id}`, { status: 'ACTIVE' })).status, 409, 'cannot reactivate on inactive court');
  assert.equal((await api(a, 'GET', `/batches/${hist.data.id}`)).status, 200, 'history kept');
  // filters + dashboard counts
  assert.ok((await api(a, 'GET', '/batches?type=COACHING')).data.every((x) => x.type === 'COACHING'));
  assert.equal((await api(a, 'GET', '/batches?type=BOGUS')).status, 400);
  const acc = (await api(a, 'GET', `/academies/${acA.id}`)).data;
  const real = (await admin.query("SELECT batch_type, count(*)::int n FROM owner_batches WHERE academy_id=$1 AND status='ACTIVE' GROUP BY 1", [acA.id])).rows;
  const n = (t) => real.find((r) => r.batch_type === t)?.n ?? 0;
  assert.deepEqual([acc.activeRegularBatchCount, acc.activeCoachingBatchCount], [n('REGULAR'), n('COACHING')]);
  // O, P: Owner B isolation
  assert.equal((await api(b, 'GET', `/batches/${reg.data.id}`)).status, 404);
  assert.equal((await api(b, 'PATCH', `/batches/${reg.data.id}`, { name: 'hijack' })).status, 404);
  assert.equal((await api(b, 'PATCH', `/batches/${reg.data.id}`, { status: 'INACTIVE' })).status, 404);
  assert.deepEqual((await api(b, 'GET', '/batches')).data, []);
  assert.equal((await post(b, c2.id, {}, acA.id)).status, 404, 'B into A academy/court');
  assert.equal((await post(b, c2.id, {}, acB.id)).status, 404, "B academy + A's court");
  assert.equal((await post(a, bc1.id, {}, acA.id)).status, 404, "A academy + B's court");
  assert.equal((await post(a, bc1.id, {}, acB.id)).status, 404, 'A into B academy');
  assert.equal((await api(a, 'PATCH', `/batches/${reg.data.id}`, { courtId: bc1.id })).status, 404, "move into B's court");
  const own = await post(b, bc1.id, { name: 'B batch', ownerProfileId: 'x', userId: a.id }, acB.id);
  assert.equal(own.status, 201);
  assert.equal((await api(a, 'GET', '/batches')).data.every((x) => x.academyId === acA.id), true);
  // Q
  assert.equal((await api(null, 'GET', '/batches')).status, 401);
  // roles unchanged
  assert.deepEqual((await admin.query("SELECT DISTINCT role FROM users WHERE id = ANY($1)", [[a.id, b.id]])).rows, [{ role: 'PLAYER' }]);
});

test('concurrent overlapping creates on one court: exactly one wins', { skip }, async () => {
  const { a } = users;
  await api(a, 'POST', '/profile');
  const ac = (await api(a, 'GET', '/academies')).data[0];
  const court = (await api(a, 'POST', `/academies/${ac.id}/courts`, { name: 'Race Court' })).data;
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => api(a, 'POST', '/batches', {
    academyId: ac.id, courtId: court.id, type: i % 2 ? 'COACHING' : 'REGULAR', name: `Race ${i}`, startTime: '14:00', endTime: '15:00', feePerPerson: '100',
  })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
});
