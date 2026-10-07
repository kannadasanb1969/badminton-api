import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { createInput, patchInput, feeValue, timeValue, hhmm12 } from '../src/services/owner-batch.service.js';
import { OwnerError } from '../src/services/owner.service.js';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };
const base = { academyId: 'a', courtId: 'c', type: 'REGULAR', name: 'Morning', startTime: '05:30', endTime: '07:15', feePerPerson: '1234.50' };

test('Q: unauthenticated batch routes are rejected', async () => {
  for (const [method, path] of [['GET', '/api/owner/batches'], ['POST', '/api/owner/batches'], ['GET', '/api/owner/batches/b'], ['PATCH', '/api/owner/batches/b']]) {
    assert.equal((await handleOwnerRoutes(new Request(`http://x${path}`, { method }), env)).status, 401, `${method} ${path}`);
  }
});

test('C: arbitrary manual minutes are accepted, no fixed slots', () => {
  for (const [s, e] of [['05:30', '07:15'], ['07:15', '08:45'], ['18:10', '20:20'], ['00:00', '23:59']]) {
    const v = createInput({ ...base, startTime: s, endTime: e });
    assert.equal(v.startTime, s); assert.equal(v.endTime, e);
  }
});

test('M: start >= end rejected; times must be HH:MM same-day', () => {
  assert.throws(() => createInput({ ...base, startTime: '08:00', endTime: '08:00' }), OwnerError);
  assert.throws(() => createInput({ ...base, startTime: '09:00', endTime: '08:00' }), OwnerError);
  for (const bad of ['24:00', '6:00', '06:60', '06:00:00', '', null, 600]) assert.throws(() => timeValue(bad, 't'), OwnerError, String(bad));
});

test('D/N: fee is exact, Owner-entered, never defaulted, non-negative', () => {
  assert.equal(feeValue('1234.50'), '1234.50');
  assert.equal(feeValue(0), '0');
  assert.equal(feeValue(1750), '1750');
  assert.throws(() => feeValue(undefined), OwnerError);
  assert.throws(() => feeValue(''), OwnerError);
  assert.throws(() => feeValue(-1), OwnerError);
  assert.throws(() => feeValue('-0.01'), OwnerError);
  assert.throws(() => feeValue('10.999'), OwnerError);
  assert.throws(() => feeValue('1e3'), OwnerError);
  assert.throws(() => feeValue(true), OwnerError);
  assert.throws(() => createInput({ ...base, feePerPerson: undefined }), OwnerError);
});

test('type/status/name validation and patch rules', () => {
  assert.throws(() => createInput({ ...base, type: 'MONTHLY' }), OwnerError);
  assert.throws(() => createInput({ ...base, name: '  ' }), OwnerError);
  assert.throws(() => createInput({ ...base, academyId: undefined }), OwnerError);
  assert.throws(() => patchInput({}), OwnerError);
  assert.throws(() => patchInput({ status: 'DELETED' }), OwnerError);
  assert.deepEqual(patchInput({ name: ' A  B ', status: 'INACTIVE' }), { name: 'A B', status: 'INACTIVE' });
  assert.equal(patchInput({ ownerProfileId: 'x', userId: 'y', name: 'ok' }).userId, undefined);
});

test('12-hour display helper', () => {
  assert.equal(hhmm12('00:00'), '12:00 AM'); assert.equal(hhmm12('06:00'), '6:00 AM');
  assert.equal(hhmm12('12:05'), '12:05 PM'); assert.equal(hhmm12('20:30'), '8:30 PM');
});

test('migration is additive: only creates owner_batches, no destructive/ALTER statements', async () => {
  const code = (await readFile(new URL('../migrations/20261003_owner_batches.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|ALTER|UPDATE|INSERT|EXTENSION)\b|(?<!ON )\bDELETE\b/i);
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['owner_batches']);
  assert.doesNotMatch(code.match(/fee_per_person[^\n]*/)[0], /DEFAULT/i, 'no default fee');
  assert.doesNotMatch(code, /REFERENCES (?!owner_)/);
});
