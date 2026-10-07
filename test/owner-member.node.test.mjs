import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { memberCreateInput, memberPatchInput, mobileValue, dateValue, todayIST } from '../src/services/owner-member.service.js';
import { OwnerError } from '../src/services/owner.service.js';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };

test('Y: unauthenticated member/membership routes are rejected', async () => {
  for (const [method, path] of [['GET', '/api/owner/members'], ['POST', '/api/owner/members'], ['GET', '/api/owner/members/m'], ['PATCH', '/api/owner/members/m'],
    ['GET', '/api/owner/members/m/memberships'], ['POST', '/api/owner/members/m/memberships'], ['POST', '/api/owner/memberships/x/move'], ['POST', '/api/owner/memberships/x/end']]) {
    assert.equal((await handleOwnerRoutes(new Request(`http://x${path}`, { method }), env)).status, 401, `${method} ${path}`);
  }
});

test('mobile normalisation: one canonical 10-digit form, optional, never guessed', () => {
  for (const v of ['9876543210', '+91 98765 43210', '+91-9876543210', '09876543210', '919876543210', ' 98765-43210 ']) assert.equal(mobileValue(v), '9876543210', v);
  for (const v of [undefined, null, '', '   ']) assert.equal(mobileValue(v), null);
  for (const v of ['12345', '98765432101', 'abcdefghij', 12345678901]) assert.throws(() => mobileValue(v), OwnerError, String(v));
});

test('member input: name required, mobile optional, client identity ignored', () => {
  assert.throws(() => memberCreateInput({ academyId: 'a' }), OwnerError);
  assert.throws(() => memberCreateInput({ academyId: 'a', name: '  ' }), OwnerError);
  assert.throws(() => memberCreateInput({ name: 'X' }), OwnerError);
  assert.deepEqual(memberCreateInput({ academyId: 'a', name: '  Sudhakar  K ' }), { academyId: 'a', name: 'Sudhakar K', mobile: null });
  const out = memberCreateInput({ academyId: 'a', name: 'X', mobile: '9876543210', linkedUserId: 'u1', userId: 'u2' });
  assert.equal(out.linkedUserId, undefined);
  assert.equal(out.userId, undefined);
  assert.throws(() => memberPatchInput({}), OwnerError);
  assert.throws(() => memberPatchInput({ status: 'DELETED' }), OwnerError);
  assert.deepEqual(memberPatchInput({ mobile: '' }), { mobile: null });
  assert.equal(memberPatchInput({ linkedUserId: 'u', name: 'ok' }).linkedUserId, undefined);
});

test('effective dates: calendar dates, default today, no future', () => {
  assert.equal(dateValue(undefined), todayIST());
  assert.equal(dateValue('2020-02-29'), '2020-02-29');
  for (const v of ['2021-02-29', '2020-13-01', '20-01-01', 'today', 20200101]) assert.throws(() => dateValue(v), OwnerError, String(v));
  assert.throws(() => dateValue('2999-01-01'), OwnerError);
});

test('migration is additive: only the two member tables, no destructive/ALTER, no change to users', async () => {
  const code = (await readFile(new URL('../migrations/20261003_owner_memberships.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|ALTER|UPDATE|INSERT|EXTENSION)\b|(?<!ON )\bDELETE\b/i);
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['owner_members', 'owner_memberships']);
  assert.match(code, /linked_user_id text REFERENCES users\(id\)/);
  assert.doesNotMatch(code.match(/linked_user_id[^\n]*/)[0], /NOT NULL/i, 'linked_user_id stays optional');
  assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX[^;]*ON (users|player_profiles)/i);
  assert.match(code, /owner_members_active_mobile_uidx/);
  assert.match(code, /owner_memberships_active_member_batch_uidx/);
  assert.doesNotMatch(code, /REFERENCES (?!owner_|users\()/);
});
