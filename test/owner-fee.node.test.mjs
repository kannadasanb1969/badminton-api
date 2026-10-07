import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { monthValue, rateInput } from '../src/services/owner-fee.service.js';
import { OwnerError } from '../src/services/owner.service.js';
import { addDays, monthEnd } from '../src/utils/owner-dates.js';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };

test('Z: unauthenticated fee-engine routes are rejected', async () => {
  for (const [method, path] of [['GET', '/api/owner/batches/b/fee-rates'], ['POST', '/api/owner/batches/b/fee-rates'], ['GET', '/api/owner/memberships/m/leaves'],
    ['POST', '/api/owner/memberships/m/leaves'], ['DELETE', '/api/owner/memberships/m/leaves/2026-10'], ['GET', '/api/owner/monthly-fees'], ['POST', '/api/owner/monthly-fees/generate']]) {
    assert.equal((await handleOwnerRoutes(new Request(`http://x${path}`, { method }), env)).status, 401, `${method} ${path}`);
  }
});

test('D: fee months must be whole months (first day only); YYYY-MM accepted', () => {
  assert.equal(monthValue('2026-10'), '2026-10-01');
  assert.equal(monthValue('2026-10-01'), '2026-10-01');
  for (const bad of ['2026-10-15', '2026-13', '2026-13-01', '2026-02-30', '26-10', 'October', '', null, undefined, 202610]) assert.throws(() => monthValue(bad), OwnerError, String(bad));
});

test('B/C: rate input keeps the exact Owner-entered decimal, rejects negatives, never defaults', () => {
  assert.deepEqual(rateInput({ feeAmount: '1234.50', effectiveFrom: '2026-10' }), { feeAmount: '1234.50', effectiveFrom: '2026-10-01' });
  assert.equal(rateInput({ feeAmount: 0, effectiveFrom: '2026-10-01' }).feeAmount, '0');
  for (const bad of [-1, '-0.01', '10.999', '', undefined, null, true, '1e3']) assert.throws(() => rateInput({ feeAmount: bad, effectiveFrom: '2026-10-01' }), OwnerError, String(bad));
  assert.throws(() => rateInput({ effectiveFrom: '2026-10-01' }), OwnerError, 'no default fee');
  assert.throws(() => rateInput({ feeAmount: '10' }), OwnerError);
  assert.throws(() => rateInput({ feeAmount: '10', effectiveFrom: '2026-10-15' }), OwnerError);
});

test('calendar helpers: month end and day arithmetic across month/year/leap boundaries', () => {
  assert.equal(monthEnd('2026-10-01'), '2026-10-31');
  assert.equal(monthEnd('2026-02-01'), '2026-02-28');
  assert.equal(monthEnd('2028-02-01'), '2028-02-29');
  assert.equal(monthEnd('2026-12-01'), '2026-12-31');
  assert.equal(addDays('2026-11-01', -1), '2026-10-31');
  assert.equal(addDays('2027-01-01', -1), '2026-12-31');
});

test('migration is additive and schema-only: three new tables + one guard trigger, no data, no ALTER of existing tables', async () => {
  const code = (await readFile(new URL('../migrations/20261003_owner_fee_engine.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|ALTER|EXTENSION)\b|\bUPDATE\s+\w+\s+SET\b|(?<!ON )\bDELETE\s+FROM\b|\bINSERT\s+INTO\b/i);
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['owner_fee_rates', 'owner_monthly_leaves', 'owner_monthly_fees']);
  assert.doesNotMatch(code, /DEFAULT\s+\d/, 'no default fee amounts');
  assert.doesNotMatch(code, /fee_amount[^\n]*DEFAULT|applicable_fee[^\n]*DEFAULT/i);
  assert.match(code, /numeric\(10, 2\)/);
  assert.doesNotMatch(code, /\b(float|double precision|real)\b/i);
  assert.match(code, /owner_fee_rates_no_overlap/);
  assert.match(code, /owner_monthly_fees_membership_month_uidx/);
  assert.match(code, /owner_monthly_leaves_membership_month_uidx/);
  assert.doesNotMatch(code, /REFERENCES (?!owner_)/);
});

test('bootstrap script is guarded: pinned endpoint, dry-run by default, never touches owner_batches', async () => {
  const src = await readFile(new URL('../scripts/bootstrap-owner-fee-rates.mjs', import.meta.url), 'utf8');
  assert.match(src, /ep-weathered-meadow-b3ot536q/);
  assert.match(src, /process\.argv\.includes\('--apply'\)/);
  assert.doesNotMatch(src, /UPDATE\s+owner_batches|DELETE\s+FROM|DROP|TRUNCATE/i);
  assert.match(src, /WHERE NOT EXISTS/);
});
