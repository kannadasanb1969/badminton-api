// Cross-app handoff against the LOCAL DEVELOPMENT database only (q2-friendly-test). Throwaway user; removes only its own rows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleAuthRoutes } from '../src/routes/auth.routes.js';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';

const REQUIRED_ENDPOINT = 'ep-weathered-meadow-b3ot536q';
let enabled = true;
let config;
try { config = getSafeDatabaseConfig(); } catch { enabled = false; }
if (enabled && !new URL(config.connectionString).hostname.startsWith(REQUIRED_ENDPOINT)) throw new Error('Refusing: database endpoint is not the verified q2-friendly-test endpoint');
const skip = !enabled && 'set DB_ENV, ALLOW_DB_INTEGRATION_TESTS and DATABASE_URL_DEV';
const env = enabled ? {
  AUTH_MODE: 'development', ENVIRONMENT: 'local', AUTH_TOKEN_SECRET: 'integration-secret',
  HYPERDRIVE: { connectionString: config.connectionString },
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.connectionString,
} : {};
const tag = String(Math.floor(Math.random() * 9e7) + 1e7);
const mobile = `+91${tag}7`;
let admin; let user; let session;

async function api(path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handleAuthRoutes(new Request(`http://x/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) }), env);
  return { status: res.status, ...(await res.json()) };
}
const sha = (text) => createHash('sha256').update(text).digest('hex');

before(async () => {
  if (!enabled) return;
  admin = new pg.Pool({ connectionString: config.connectionString, max: 6, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  // a normal OTP sign-in creates the throwaway PLAYER account (exactly what the Mobile app does first)
  assert.equal((await api('/request-otp', { mobile })).success, true);
  const login = await api('/verify-otp', { mobile, otp: '12345' });
  assert.equal(login.status, 200, JSON.stringify(login));
  session = login.data;
  user = (await admin.query('SELECT id, role, is_active FROM users WHERE mobile=$1', [mobile])).rows[0];
});
after(async () => {
  if (!enabled) return;
  await admin.query('DELETE FROM auth_app_handoffs WHERE user_id=$1', [user.id]);
  await admin.query('DELETE FROM auth_sessions WHERE user_id=$1', [user.id]);
  await admin.query('DELETE FROM otp_requests WHERE mobile=$1', [mobile]);
  await admin.query('DELETE FROM users WHERE id=$1', [user.id]);
  await admin.end();
});

const make = (token = session.accessToken) => api('/app-handoff', { targetApp: 'OWNER' }, token);

test('valid handoff: one-time code, only the hash is stored, Owner gets its own independent session for the same user', { skip }, async () => {
  const h = await make();
  assert.equal(h.status, 200, JSON.stringify(h));
  assert.deepEqual([h.data.targetApp, h.data.expiresInSeconds], ['OWNER', 60]);
  assert.match(h.data.code, /^[A-Za-z0-9_-]{40,}$/);
  assert.deepEqual(Object.keys(h.data).sort(), ['code', 'expiresInSeconds', 'targetApp']); // no tokens in the response
  // only the SHA-256 is stored; the raw code is nowhere in the table
  const rows = (await admin.query('SELECT code_hash, expires_at - created_at AS ttl FROM auth_app_handoffs WHERE user_id=$1 AND consumed_at IS NULL', [user.id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, sha(h.data.code));
  assert.notEqual(rows[0].code_hash, h.data.code);
  assert.equal((await admin.query('SELECT count(*)::int n FROM auth_app_handoffs WHERE code_hash=$1', [h.data.code])).rows[0].n, 0);
  assert.ok(rows[0].ttl.seconds === 60 || rows[0].ttl.minutes === 1, JSON.stringify(rows[0].ttl)); // 60 second life

  const sessionsBefore = (await admin.query('SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [user.id])).rows[0].n;
  const x = await api('/app-handoff/exchange', { code: h.data.code }); // NO bearer token needed
  assert.equal(x.status, 200, JSON.stringify(x));
  assert.equal(x.data.user.id, user.id);
  assert.ok(x.data.accessToken && x.data.refreshToken);
  assert.notEqual(x.data.refreshToken, session.refreshToken); // its own session, not the Mobile one
  assert.equal((await admin.query('SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL', [user.id])).rows[0].n, sessionsBefore + 1);
  // users.role is untouched
  const after = (await admin.query('SELECT role, is_active FROM users WHERE id=$1', [user.id])).rows[0];
  assert.deepEqual([after.role, after.is_active], [user.role, user.is_active]);
  assert.equal(after.role, 'PLAYER');

  // the exchanged tokens are normal ones: the Owner API accepts the access token, refresh rotates the refresh token
  const profile = await handleOwnerRoutes(new Request('http://x/api/owner/profile', { headers: { authorization: `Bearer ${x.data.accessToken}` } }), env);
  assert.equal(profile.status, 200);
  const refreshed = await api('/refresh', { refreshToken: x.data.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.data.refreshToken, x.data.refreshToken);

  // the Mobile session survives the exchange (cleanup is the Mobile app's explicit, later step)
  assert.equal((await api('/refresh', { refreshToken: session.refreshToken })).status, 200);
});

test('replay of a used code is rejected; concurrent exchanges produce exactly one session', { skip }, async () => {
  await api('/request-otp', { mobile });
  session = (await api('/verify-otp', { mobile, otp: '12345' })).data;
  const h = await make();
  const first = await api('/app-handoff/exchange', { code: h.data.code });
  assert.equal(first.status, 200);
  const replay = await api('/app-handoff/exchange', { code: h.data.code });
  assert.equal(replay.status, 401);
  assert.match(replay.message, /Invalid or expired/);

  const h2 = await make();
  const before = (await admin.query('SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1', [user.id])).rows[0].n;
  const six = await Promise.all(Array.from({ length: 6 }, () => api('/app-handoff/exchange', { code: h2.data.code })));
  assert.deepEqual(six.map((r) => r.status).sort(), [200, 401, 401, 401, 401, 401]);
  assert.equal((await admin.query('SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1', [user.id])).rows[0].n, before + 1);
});

test('expired, random, malformed and wrong-target codes are rejected', { skip }, async () => {
  const h = await make();
  await admin.query("UPDATE auth_app_handoffs SET expires_at = created_at + interval '1 millisecond' WHERE code_hash=$1", [sha(h.data.code)]);
  const expired = await api('/app-handoff/exchange', { code: h.data.code });
  assert.equal(expired.status, 401);
  assert.equal((await admin.query('SELECT consumed_at FROM auth_app_handoffs WHERE code_hash=$1', [sha(h.data.code)])).rows[0].consumed_at, null); // an expired code is never "used"

  for (const code of ['A'.repeat(43), 'not a code', '', null, 123, 'x'.repeat(300)]) {
    assert.equal((await api('/app-handoff/exchange', { code })).status, 401, String(code));
  }
  assert.equal((await api('/app-handoff/exchange', {})).status, 401);

  // wrong target application
  for (const targetApp of ['PLAYER', 'ORGANIZER', 'ADMIN', 'owner', '', null, undefined]) {
    assert.equal((await api('/app-handoff', { targetApp }, session.accessToken)).status, 400, String(targetApp));
  }
  const good = await make();
  assert.equal((await api('/app-handoff/exchange', { code: good.data.code, targetApp: 'PLAYER' })).status, 400);
  assert.equal((await api('/app-handoff/exchange', { code: good.data.code, targetApp: 'OWNER' })).status, 200); // still unused after the rejected attempt
});

test('unauthenticated or invalid creation is rejected; a newer code retires the older one; inactive users cannot hand off', { skip }, async () => {
  assert.equal((await api('/app-handoff', { targetApp: 'OWNER' })).status, 401);
  assert.equal((await api('/app-handoff', { targetApp: 'OWNER' }, 'x.y')).status, 401);
  const a = await make(); const b = await make();
  assert.equal((await api('/app-handoff/exchange', { code: a.data.code })).status, 401);
  assert.equal((await api('/app-handoff/exchange', { code: b.data.code })).status, 200);

  const c = await make();
  await admin.query('UPDATE users SET is_active=false WHERE id=$1', [user.id]);
  try {
    assert.equal((await make()).status, 403);
    assert.equal((await api('/app-handoff/exchange', { code: c.data.code })).status, 403);
  } finally {
    await admin.query('UPDATE users SET is_active=true WHERE id=$1', [user.id]);
  }
  assert.equal((await admin.query('SELECT role FROM users WHERE id=$1', [user.id])).rows[0].role, 'PLAYER');
});
