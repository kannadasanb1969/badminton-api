// Route-level ownership/security tests against a LOCAL DEVELOPMENT database.
// Refuses to run unless DB_ENV=development|test, ALLOW_DB_INTEGRATION_TESTS=true and the target is not the
// known production Neon endpoint. Creates throwaway users/owner rows and removes only those rows afterwards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';

const PROD_HOST_MARKER = 'steep-king-b32iqh0h';
let enabled = true;
let config;
try { config = getSafeDatabaseConfig(); } catch { enabled = false; }
if (enabled && new URL(config.connectionString).hostname.includes(PROD_HOST_MARKER)) throw new Error('Refusing production database');

const skip = !enabled && 'set DB_ENV, ALLOW_DB_INTEGRATION_TESTS and DATABASE_URL_DEV';
const env = enabled ? {
  AUTH_TOKEN_SECRET: 'integration-secret',
  HYPERDRIVE: { connectionString: config.connectionString },
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.connectionString,
} : {};
const tag = `ownertest${Date.now()}`;
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
  for (const [key, role, mobile] of [['a', 'PLAYER', '1'], ['b', 'ORGANIZER', '2']]) {
    const row = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,$2) RETURNING id, role", [`+91${tag.slice(-8)}${mobile}`.slice(0, 13), role])).rows[0];
    users[key] = row;
  }
});
after(async () => {
  if (!enabled) return;
  const ids = Object.values(users).map((u) => u.id);
  await admin.query("DELETE FROM owner_courts WHERE academy_id IN (SELECT a.id FROM owner_academies a JOIN owner_profiles p ON p.id=a.owner_profile_id WHERE p.user_id = ANY($1))", [ids]);
  await admin.query("DELETE FROM owner_academies WHERE owner_profile_id IN (SELECT id FROM owner_profiles WHERE user_id = ANY($1))", [ids]);
  await admin.query("DELETE FROM owner_profiles WHERE user_id = ANY($1)", [ids]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await admin.end();
});

test('owner domain security flow', { skip }, async () => {
  const { a, b } = users;
  // pre-profile
  assert.equal((await api(a, 'GET', '/profile')).data, null);
  assert.equal((await api(a, 'GET', '/academies')).status, 403);
  // A: create profile; B: duplicate-safe
  const p1 = await api(a, 'POST', '/profile');
  assert.equal(p1.status, 201);
  const p2 = await api(a, 'POST', '/profile');
  assert.equal(p2.data.id, p1.data.id, 'C: no duplicate profile');
  assert.equal((await admin.query('SELECT count(*)::int n FROM owner_profiles WHERE user_id=$1', [a.id])).rows[0].n, 1);
  // B: global role unchanged
  assert.equal((await admin.query('SELECT role FROM users WHERE id=$1', [a.id])).rows[0].role, 'PLAYER');
  // D: academy
  assert.equal((await api(a, 'POST', '/academies', {})).status, 400);
  const ac = await api(a, 'POST', '/academies', { name: 'A Academy', city: 'Pune' });
  assert.equal(ac.status, 201);
  const academyId = ac.data.id;
  // E/F: dynamic courts
  const c1 = await api(a, 'POST', `/academies/${academyId}/courts`, { name: 'Court 1' });
  const c2 = await api(a, 'POST', `/academies/${academyId}/courts`, { name: 'Main Court' });
  const c3 = await api(a, 'POST', `/academies/${academyId}/courts`, { name: 'VIP Court' });
  assert.deepEqual([c1.status, c2.status, c3.status], [201, 201, 201]);
  assert.equal((await api(a, 'POST', `/academies/${academyId}/courts`, { name: ' court  1 ' })).status, 409, 'duplicate active name');
  const list = await api(a, 'GET', `/academies/${academyId}/courts`);
  assert.deepEqual(list.data.map((c) => c.name), ['Court 1', 'Main Court', 'VIP Court']);
  // G/H/I: edit, deactivate, reactivate
  assert.equal((await api(a, 'PATCH', `/courts/${c1.data.id}`, { name: 'Court One' })).data.name, 'Court One');
  assert.equal((await api(a, 'PATCH', `/courts/${c1.data.id}`, { status: 'INACTIVE' })).data.status, 'INACTIVE');
  assert.equal((await api(a, 'GET', `/academies/${academyId}`)).data.activeCourtCount, 2);
  assert.equal((await api(a, 'POST', `/academies/${academyId}/courts`, { name: 'Court One' })).status, 201, 'inactive name reusable');
  assert.equal((await api(a, 'PATCH', `/courts/${c1.data.id}`, { status: 'ACTIVE' })).status, 409, 'reactivate would duplicate');
  assert.equal((await api(a, 'PATCH', `/courts/${c1.data.id}`, { name: 'Court Uno', status: 'ACTIVE' })).data.status, 'ACTIVE');
  // J/K: Owner B isolation
  assert.equal((await api(b, 'POST', '/profile')).status, 201);
  assert.equal((await api(b, 'GET', `/academies/${academyId}`)).status, 404);
  assert.equal((await api(b, 'PATCH', `/academies/${academyId}`, { name: 'hijack' })).status, 404);
  assert.equal((await api(b, 'GET', `/academies/${academyId}/courts`)).status, 404);
  assert.equal((await api(b, 'POST', `/academies/${academyId}/courts`, { name: 'X' })).status, 404);
  assert.equal((await api(b, 'PATCH', `/courts/${c2.data.id}`, { name: 'hijack' })).status, 404);
  assert.deepEqual((await api(b, 'GET', '/academies')).data, []);
  assert.equal((await api(a, 'GET', `/academies/${academyId}`)).data.name, 'A Academy');
  // client-supplied identity ignored
  const spoof = await api(b, 'POST', '/academies', { name: 'B Academy', ownerProfileId: p1.data.id, userId: a.id });
  assert.equal(spoof.status, 201);
  assert.equal((await api(a, 'GET', '/academies')).data.length, 1);
  // L: unauthenticated
  assert.equal((await api(null, 'GET', '/academies')).status, 401);
  // users.role still unchanged for both
  assert.deepEqual((await admin.query('SELECT role FROM users WHERE id = ANY($1) ORDER BY role', [[a.id, b.id]])).rows.map((r) => r.role), ['ORGANIZER', 'PLAYER']);
});
