// Phase 9.1 pure/static tests: interval math, validators, migration shape, route auth. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { complementOfDay, mergeIntervals, overlaps } from '../src/utils/owner-intervals.js';
import { dateValue, windowValue, evaluateWindow, toBlockers, isoWeekday } from '../src/services/owner-availability.service.js';
import { daysValue, createInput } from '../src/services/owner-batch.service.js';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';

const iv = (startTime, endTime) => ({ startTime, endTime });

test('overlap rule: touching allowed, one minute conflicts', () => {
  assert.equal(overlaps(iv('10:00', '11:00'), iv('09:00', '10:00')), false);
  assert.equal(overlaps(iv('09:59', '11:00'), iv('09:00', '10:00')), true);
  assert.equal(overlaps(iv('09:15', '10:45'), iv('10:45', '24:00')), false);
});

test('merge: overlapping and adjacent intervals collapse; separated stay apart', () => {
  assert.deepEqual(mergeIntervals([iv('07:00', '08:00'), iv('06:00', '07:00')]), [iv('06:00', '08:00')]);
  assert.deepEqual(mergeIntervals([iv('06:00', '09:00'), iv('07:00', '08:00')]), [iv('06:00', '09:00')]);
  assert.deepEqual(mergeIntervals([iv('06:00', '07:00'), iv('07:01', '08:00')]), [iv('06:00', '07:00'), iv('07:01', '08:00')]);
});

test('complement: full day, gaps, edges and end-of-day marker', () => {
  assert.deepEqual(complementOfDay([]), [iv('00:00', '24:00')]);
  assert.deepEqual(complementOfDay([iv('06:00', '07:00'), iv('07:00', '08:00'), iv('12:00', '13:00'), iv('15:00', '16:30')]),
    [iv('00:00', '06:00'), iv('08:00', '12:00'), iv('13:00', '15:00'), iv('16:30', '24:00')]);
  assert.deepEqual(complementOfDay([iv('00:00', '24:00')]), []);
  assert.deepEqual(complementOfDay([iv('00:00', '09:15'), iv('10:45', '24:00')]), [iv('09:15', '10:45')]);
});

test('window validation: minute level, end of day, no zero/negative/overnight', () => {
  assert.deepEqual(windowValue('09:15', '10:45'), iv('09:15', '10:45'));
  assert.deepEqual(windowValue('18:30', '24:00'), iv('18:30', '24:00'));
  for (const [s, e] of [['09:00', '09:00'], ['10:00', '09:00'], ['23:00', '01:00'], ['24:00', '24:00'], ['9:00', '10:00'], ['09:00', '25:00'], ['09:60', '10:00']]) {
    assert.throws(() => windowValue(s, e), `${s}-${e}`);
  }
  assert.throws(() => dateValue('2026-02-30'));
  assert.throws(() => dateValue('26-10-10'));
  assert.equal(dateValue('2026-10-10'), '2026-10-10');
  assert.equal(isoWeekday('2026-10-10'), 6); // Saturday
  assert.equal(isoWeekday('2026-10-11'), 7); // Sunday
  assert.equal(isoWeekday('2026-10-12'), 1); // Monday
});

test('weekday validation: non-empty, 1-7, no duplicates, normalised ascending', () => {
  assert.deepEqual(daysValue([5, 1, 3]), [1, 3, 5]);
  for (const bad of [[], [0], [8], [1, 1], ['1'], [1.5], null, 'x']) assert.throws(() => daysValue(bad));
});

test('batch create input: defaults and effective-date rules', () => {
  const base = { academyId: 'a', courtId: 'c', type: 'REGULAR', name: 'B', startTime: '06:00', endTime: '07:00', feePerPerson: '100' };
  const v = createInput(base);
  assert.deepEqual(v.daysOfWeek, [1, 2, 3, 4, 5, 6, 7]);
  assert.match(v.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(v.effectiveTo, null);
  assert.throws(() => createInput({ ...base, effectiveFrom: '2031-05-01', effectiveTo: '2031-04-30' }), /before/);
  assert.throws(() => createInput({ ...base, daysOfWeek: [] }));
  assert.equal(createInput({ ...base, effectiveFrom: '2031-05-01', effectiveTo: '2031-05-01' }).effectiveTo, '2031-05-01');
});

test('shared conflict decision covers every blocker type identically', () => {
  const blockers = toBlockers({
    batches: [{ batch_type: 'REGULAR', name: 'Morning', s: '06:00', e: '07:00', id: 'b1' }, { batch_type: 'COACHING', name: 'Eve', s: '18:00', e: '20:00', id: 'b2' }],
    bookings: [{ id: 'k1', s: '15:00', e: '16:30' }], blocks: [{ id: 'x1', reason: 'Maintenance', s: '12:00', e: '13:00' }],
  });
  assert.deepEqual(blockers.map((b) => b.type), ['REGULAR_BATCH', 'COURT_BLOCK', 'BOOKING', 'COACHING_BATCH']);
  assert.equal(evaluateWindow(blockers, '07:00', '12:00').available, true);
  const r = evaluateWindow(blockers, '06:59', '12:01');
  assert.equal(r.available, false);
  assert.deepEqual(r.conflicts.map((c) => c.type), ['REGULAR_BATCH', 'COURT_BLOCK']);
  assert.equal(evaluateWindow(blockers, '16:30', '18:00').available, true);
});

test('migration is additive, owner-domain only, no pricing/payment columns', () => {
  const sql = readFileSync(new URL('../migrations/20261004_owner_court_booking_foundation.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i);
  const alters = [...code.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(alters)], ['owner_batches']);
  for (const t of ['owner_batch_exceptions', 'owner_bookings', 'owner_court_blocks']) assert.match(code, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`));
  const bookings = code.slice(code.indexOf('CREATE TABLE IF NOT EXISTS owner_bookings'), code.indexOf('CREATE TABLE IF NOT EXISTS owner_court_blocks'));
  assert.doesNotMatch(bookings, /amount|price|rate|payment|customer/i);
  assert.doesNotMatch(code, /\busers\b|player_profiles/i);
});

test('unauthenticated booking-foundation routes are rejected', async () => {
  const env = { AUTH_TOKEN_SECRET: 's' };
  for (const [m, p] of [['GET', '/courts/x/availability?date=2031-01-01'], ['GET', '/court-blocks'], ['POST', '/court-blocks'], ['DELETE', '/court-blocks/x'], ['POST', '/batches/x/releases'], ['DELETE', '/batches/x/releases/2031-01-01']]) {
    const res = await handleOwnerRoutes(new Request(`http://x/api/owner${p}`, { method: m }), env);
    assert.equal(res.status, 401, `${m} ${p}`);
  }
});
