// Static + mocked-DB checks for the cross-app handoff. No real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAuthRoutes } from '../src/routes/auth.routes.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (p) => read(p).split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//')).join('\n');

test('migration is additive: one new table, no ALTER/DROP, never touches users.role', () => {
  const sql = code('../migrations/20261007_auth_app_handoffs.sql');
  assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['auth_app_handoffs']);
  assert.doesNotMatch(sql, /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b|\bALTER TABLE\b|\bUPDATE\b/i);
  assert.match(sql, /code_hash text NOT NULL UNIQUE/);
  assert.doesNotMatch(sql, /\bcode text\b|raw_code|access_token|refresh_token/i);
  assert.match(sql, /CHECK \(target_app IN \('OWNER'\)\)/);
});

test('service stores only a hash, consumes atomically, and never mutates roles or logs codes', () => {
  const svc = code('../src/services/auth.service.js');
  const repo = code('../src/repositories/auth.repository.js');
  const handoff = svc.slice(svc.indexOf('createAppHandoff'));
  assert.match(handoff, /tokenHash\(code\)/);
  assert.doesNotMatch(handoff, /console\./);
  assert.doesNotMatch(handoff, /UPDATE users|role\s*=/i);
  assert.match(repo, /UPDATE auth_app_handoffs SET consumed_at=NOW\(\) WHERE code_hash=\$1 AND target_app=\$2 AND consumed_at IS NULL AND expires_at > NOW\(\)/);
  assert.doesNotMatch(repo.slice(repo.indexOf('createHandoff')), /INSERT INTO auth_app_handoffs\(user_id,target_app,code_hash,expires_at\) VALUES\(\$1,\$2,\$3,\$4\)/); // expiry is computed by the database clock
});

test('handoff routes are POST-only and creation requires a bearer token', async () => {
  const env = { AUTH_MODE: 'development', ENVIRONMENT: 'local', AUTH_TOKEN_SECRET: 's' };
  for (const path of ['/api/auth/app-handoff', '/api/auth/app-handoff/exchange']) {
    assert.equal((await handleAuthRoutes(new Request(`http://x${path}`, { method: 'GET' }), env)).status, 405);
  }
  const unauth = await handleAuthRoutes(new Request('http://x/api/auth/app-handoff', { method: 'POST', body: JSON.stringify({ targetApp: 'OWNER' }) }), env);
  assert.equal(unauth.status, 401);
  const badToken = await handleAuthRoutes(new Request('http://x/api/auth/app-handoff', { method: 'POST', headers: { authorization: 'Bearer nope.nope' }, body: JSON.stringify({ targetApp: 'OWNER' }) }), env);
  assert.equal(badToken.status, 401);
  const garbage = await handleAuthRoutes(new Request('http://x/api/auth/app-handoff/exchange', { method: 'POST', body: JSON.stringify({ code: 'short' }) }), env);
  assert.equal(garbage.status, 401); // rejected before any database access
});
