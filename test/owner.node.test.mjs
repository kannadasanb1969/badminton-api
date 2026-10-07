import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { academyInput, academyPatch, courtPatch, nameValue, OwnerError } from '../src/services/owner.service.js';
import { readFile } from 'node:fs/promises';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };
const call = (path, init = {}) => handleOwnerRoutes(new Request(`http://x${path}`, init), env);

test('L: unauthenticated /api/owner/* is rejected with 401', async () => {
  for (const [method, path] of [['GET', '/api/owner/profile'], ['POST', '/api/owner/profile'], ['GET', '/api/owner/academies'],
    ['POST', '/api/owner/academies'], ['GET', '/api/owner/academies/a'], ['PATCH', '/api/owner/academies/a'],
    ['GET', '/api/owner/academies/a/courts'], ['POST', '/api/owner/academies/a/courts'], ['PATCH', '/api/owner/courts/c']]) {
    assert.equal((await call(path, { method })).status, 401, `${method} ${path}`);
  }
  assert.equal((await call('/api/owner/profile', { headers: { authorization: 'Bearer garbage' } })).status, 401);
});

test('authenticated unknown owner route is 404, not a DB hit', async () => {
  const token = await issueAccessToken(env, { id: 'u1', role: 'PLAYER' });
  assert.equal((await call('/api/owner/nope', { headers: { authorization: `Bearer ${token}` } })).status, 404);
});

test('academy validation: name required, optional fields trimmed/cleared', () => {
  assert.throws(() => academyInput({}), OwnerError);
  assert.throws(() => academyInput({ name: '   ' }), OwnerError);
  assert.throws(() => academyInput({ name: 'A', pincode: 'abc' }), OwnerError);
  assert.throws(() => academyInput({ name: 'A', mobile: '12' }), OwnerError);
  assert.deepEqual(academyInput({ name: '  Smash   Academy ', city: ' Pune ', area: '' }), { name: 'Smash Academy', city: 'Pune', area: null });
  assert.throws(() => academyPatch({}), OwnerError);
  assert.throws(() => academyPatch({ status: 'DELETED' }), OwnerError);
  assert.deepEqual(academyPatch({ status: 'INACTIVE' }), { status: 'INACTIVE' });
});

test('F: court names are free-form; status limited to ACTIVE/INACTIVE', () => {
  for (const n of ['Court 1', 'Main Court', 'VIP Court']) assert.equal(nameValue(n, 'Court name'), n);
  assert.throws(() => courtPatch({}), OwnerError);
  assert.throws(() => courtPatch({ name: '' }), OwnerError);
  assert.throws(() => courtPatch({ status: 'DELETED' }), OwnerError);
  assert.deepEqual(courtPatch({ name: ' Court  2 ', status: 'ACTIVE' }), { name: 'Court 2', status: 'ACTIVE' });
});

test('migration is additive: no DROP/TRUNCATE/ALTER/DELETE, creates only the three owner tables', async () => {
  const sql = await readFile(new URL('../migrations/20261003_owner_domain.sql', import.meta.url), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|ALTER|UPDATE|INSERT)\b|(?<!ON )\bDELETE\b/i);
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['owner_profiles', 'owner_academies', 'owner_courts']);
  assert.doesNotMatch(code, /REFERENCES (?!users\(|owner_)/);
});
