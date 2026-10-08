import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { feeScope } from '../src/services/owner-fee.service.js';
import { OwnerError } from '../src/services/owner.service.js';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };

test('AA: unauthenticated dashboard is rejected; dashboard is read-only', async () => {
  assert.equal((await handleOwnerRoutes(new Request('http://x/api/owner/dashboard'), env)).status, 401);
  const token = await issueAccessToken(env, { id: 'u1', role: 'PLAYER' });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    const res = await handleOwnerRoutes(new Request('http://x/api/owner/dashboard', { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' }), env);
    assert.equal(res.status, 404, method);
  }
});

test('scope parsing: month, court, batch, type validated; unknown type rejected', () => {
  assert.deepEqual(feeScope({ feeMonth: '2026-10', courtId: 'c', batchId: 'b', type: 'COACHING' }), { feeMonth: '2026-10-01', courtId: 'c', batchId: 'b', type: 'COACHING' });
  assert.deepEqual(feeScope({}), {});
  assert.throws(() => feeScope({ type: 'MONTHLY' }), OwnerError);
  assert.throws(() => feeScope({ feeMonth: '2026-10-15' }), OwnerError);
});

test('Phase 7 adds no schema: no migration file, and the reporting code never writes', async () => {
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(new URL('../migrations/', import.meta.url));
  assert.deepEqual(names.filter((n) => /dashboard|report|summary/i.test(n)), [], 'no Phase-7 migration');
  for (const f of ['../src/repositories/owner-dashboard.repository.js', '../src/services/owner-dashboard.service.js']) {
    const src = (await readFile(new URL(f, import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER|DROP|TRUNCATE|CREATE\s+TABLE)\b/i, f);
  }
});

test('the read-only dashboard has no WhatsApp / reminder / provider code (Phase 8 reminders live in their own service)', async () => {
  for (const f of ['../src/services/owner-dashboard.service.js', '../src/repositories/owner-dashboard.repository.js']) {
    assert.doesNotMatch(await readFile(new URL(f, import.meta.url), 'utf8'), /whatsapp|reminder|twilio|msg91/i, f);
  }
});
