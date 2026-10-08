// Phase 5 fee-engine tests (A-Z + reconciliation) against the LOCAL DEVELOPMENT database only (q2-friendly-test).
// All dates are derived from "today" so the suite is valid in any month.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { addDays, currentMonthIST, monthEnd, todayIST } from '../src/utils/owner-dates.js';

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
const tag = String(Math.floor(Math.random() * 9e7) + 1e7);
const users = {};
let admin;

const M0 = currentMonthIST();
const shift = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10); };
const day = (monthStart, n) => `${monthStart.slice(0, 8)}${String(n).padStart(2, '0')}`;
const toCents = (s) => { const [w, f = ''] = String(s).split('.'); return BigInt(w) * 100n + BigInt(f.padEnd(2, '0')); };

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
  const members = `(SELECT id FROM owner_members WHERE academy_id IN ${academies})`;
  const memberships = `(SELECT id FROM owner_memberships WHERE member_id IN ${members})`;
  const batches = `(SELECT id FROM owner_batches WHERE academy_id IN ${academies})`;
  await admin.query(`DELETE FROM owner_monthly_fees WHERE membership_id IN ${memberships}`, [ids]);
  await admin.query(`DELETE FROM owner_monthly_leaves WHERE membership_id IN ${memberships}`, [ids]);
  await admin.query(`DELETE FROM owner_memberships WHERE member_id IN ${members}`, [ids]);
  await admin.query(`DELETE FROM owner_members WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_fee_rates WHERE batch_id IN ${batches}`, [ids]);
  await admin.query(`DELETE FROM owner_batches WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_courts WHERE academy_id IN ${academies}`, [ids]);
  await admin.query(`DELETE FROM owner_academies WHERE owner_profile_id IN ${profiles}`, [ids]);
  await admin.query("DELETE FROM owner_profiles WHERE user_id = ANY($1)", [ids]);
  await admin.query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  await admin.end();
});

async function setup(owner, academyName) {
  await api(owner, 'POST', '/profile');
  const academy = (await api(owner, 'POST', '/academies', { name: academyName })).data;
  const court = async (n) => (await api(owner, 'POST', `/academies/${academy.id}/courts`, { name: n })).data;
  return { academy, court };
}
const mkBatch = async (owner, academy, court, type, name, fee, s, e) =>
  (await api(owner, 'POST', '/batches', { academyId: academy.id, courtId: court.id, type, name, startTime: s, endTime: e, feePerPerson: fee })).data;

// Rates for one batch must be a gapless, non-overlapping chain with exactly one open-ended (latest) rate.
async function assertChain(batchId) {
  const rows = (await admin.query("SELECT to_char(effective_from,'YYYY-MM-DD') f, to_char(effective_to,'YYYY-MM-DD') t FROM owner_fee_rates WHERE batch_id=$1 ORDER BY effective_from", [batchId])).rows;
  rows.forEach((r, i) => {
    if (i < rows.length - 1) assert.equal(r.t, addDays(rows[i + 1].f, -1), `contiguous: ${JSON.stringify(rows)}`);
    else assert.equal(r.t, null, 'latest rate is open-ended');
  });
  return rows;
}

test('fee rates: history, exact decimals, validation, overlap protection, ownership', { skip }, async () => {
  const { a, b } = users;
  const { academy, court } = await setup(a, 'Rates academy');
  await setup(b, 'B academy');
  const c1 = await court('R1');
  const bRate = await mkBatch(a, academy, c1, 'REGULAR', 'Rate batch', '1000', '06:00', '07:00');

  // batch creation records the Owner-entered fee as its first effective-dated rate (current month)
  let r = (await admin.query("SELECT fee_amount::text f, to_char(effective_from,'YYYY-MM-DD') s, effective_to FROM owner_fee_rates WHERE batch_id=$1", [bRate.id])).rows;
  assert.deepEqual(r.map((x) => [x.f, x.s, x.effective_to]), [['1000.00', M0, null]]);
  assert.equal(bRate.currentFee, '1000.00');
  const fresh = await mkBatch(a, academy, await court('R2'), 'REGULAR', 'Fresh', '2100.75', '06:00', '07:00');
  assert.equal(fresh.currentFee, '2100.75'); assert.equal(fresh.feePerPerson, '2100.75');

  // A, B: first rate for a batch, exact decimal preserved (start with a clean slate)
  await admin.query("DELETE FROM owner_fee_rates WHERE batch_id=$1", [bRate.id]);
  assert.deepEqual((await api(a, 'GET', `/batches/${bRate.id}/fee-rates`)).data.rates, []);
  const first = await api(a, 'POST', `/batches/${bRate.id}/fee-rates`, { feeAmount: '1234.50', effectiveFrom: shift(M0, -2) });
  assert.equal(first.status, 201);
  assert.deepEqual(first.data.rates.map((x) => [x.feeAmount, x.effectiveFrom, x.effectiveTo]), [['1234.50', shift(M0, -2), null]]);
  assert.equal((await admin.query("SELECT fee_amount::text f FROM owner_fee_rates WHERE batch_id=$1", [bRate.id])).rows[0].f, '1234.50');
  // C, D
  const url = `/batches/${bRate.id}/fee-rates`;
  assert.equal((await api(a, 'POST', url, { feeAmount: '-1', effectiveFrom: shift(M0, 1) })).status, 400);
  assert.equal((await api(a, 'POST', url, { effectiveFrom: shift(M0, 1) })).status, 400, 'no default fee');
  assert.equal((await api(a, 'POST', url, { feeAmount: '10', effectiveFrom: day(shift(M0, 1), 15) })).status, 400);
  assert.equal((await api(a, 'POST', url, { feeAmount: '10', effectiveFrom: 'next month' })).status, 400);
  // a change cannot be backdated before the current month; failed attempts leave history intact
  assert.equal((await api(a, 'POST', url, { feeAmount: '1300', effectiveFrom: shift(M0, -1) })).status, 409);
  assert.equal((await api(a, 'GET', url)).data.rates.length, 1);
  // E: change keeps previous rate, closes it at the end of the previous month
  const change = await api(a, 'POST', url, { feeAmount: '1500', effectiveFrom: shift(M0, 1) });
  assert.equal(change.status, 201);
  assert.deepEqual(change.data.rates.map((x) => [x.feeAmount, x.effectiveFrom, x.effectiveTo]),
    [['1500.00', shift(M0, 1), null], ['1234.50', shift(M0, -2), monthEnd(M0)]]);
  assert.equal(change.data.currentFeeRate.feeAmount, '1234.50', 'this month is still on the old rate');
  assert.equal((await api(a, 'POST', url, { feeAmount: '1', effectiveFrom: shift(M0, 1) })).status, 409, 'month already starts a rate');
  assert.equal((await api(a, 'POST', url, { feeAmount: '1', effectiveFrom: M0 })).status, 409, 'inside existing history');
  // earlier history can be added without touching later rates
  const prepend = await api(a, 'POST', url, { feeAmount: '900', effectiveFrom: shift(M0, -4) });
  assert.equal(prepend.status, 201);
  assert.deepEqual(prepend.data.rates.map((x) => x.feeAmount), ['1500.00', '1234.50', '900.00']);
  assert.equal(prepend.data.rates[2].effectiveTo, monthEnd(shift(M0, -3)));
  assert.equal((await assertChain(bRate.id)).length, 3);
  // F: the database itself refuses overlaps (direct SQL, bypassing the service)
  const overlapping = (sql, p) => assert.rejects(admin.query(sql, p), (e) => ['23P01', '23505'].includes(e.code));
  await overlapping("INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from, effective_to) VALUES ($1, 5, $2, $3)", [bRate.id, shift(M0, -3), monthEnd(shift(M0, -3))]);
  await overlapping("INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from) VALUES ($1, 5, $2)", [bRate.id, shift(M0, 5)]);
  await overlapping("UPDATE owner_fee_rates SET effective_to = $2 WHERE batch_id=$1 AND effective_from=$3", [bRate.id, monthEnd(shift(M0, 3)), shift(M0, -2)]);
  // table CHECKs (on a batch without rates, so the overlap trigger is not what rejects these)
  await admin.query("DELETE FROM owner_fee_rates WHERE batch_id=$1", [fresh.id]);
  const checkFails = (sql, p) => assert.rejects(admin.query(sql, p), (e) => e.code === '23514');
  await checkFails("INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from) VALUES ($1, 5, $2)", [fresh.id, day(shift(M0, 7), 9)]);
  await checkFails("INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from) VALUES ($1, -5, $2)", [fresh.id, shift(M0, 8)]);
  await checkFails("INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from, effective_to) VALUES ($1, 5, $2, $3)", [fresh.id, shift(M0, 8), day(shift(M0, 8), 14)]);
  assert.equal((await assertChain(bRate.id)).length, 3, 'rejected SQL left history untouched');
  // legacy column is no longer an editable source of truth; other edits still work
  const legacy = await api(a, 'PATCH', `/batches/${bRate.id}`, { feePerPerson: '777' });
  assert.equal(legacy.status, 409);
  assert.equal((await api(a, 'PATCH', `/batches/${bRate.id}`, { name: 'Rate batch renamed' })).data.currentFee, '1234.50');
  assert.equal((await admin.query("SELECT fee_per_person::text f FROM owner_batches WHERE id=$1", [bRate.id])).rows[0].f, '1000.00', 'owner_batches.fee_per_person untouched');
  // X: Owner B isolation
  assert.equal((await api(b, 'GET', url)).status, 404);
  assert.equal((await api(b, 'POST', url, { feeAmount: '1', effectiveFrom: shift(M0, 9) })).status, 404);
  assert.equal((await assertChain(bRate.id)).length, 3);
});

test('G: concurrent fee changes stay consistent', { skip }, async () => {
  const { a } = users;
  const { academy, court } = await setup(a, 'Concurrent rates academy');
  const bConc = await mkBatch(a, academy, await court('K1'), 'REGULAR', 'Conc', '100', '06:00', '07:00');
  const reqs = [[101, 1], [102, 1], [103, 1], [104, 1], [201, 2], [202, 2], [203, 2], [204, 2]];
  const res = await Promise.all(reqs.map(([amt, m]) => api(a, 'POST', `/batches/${bConc.id}/fee-rates`, { feeAmount: String(amt), effectiveFrom: shift(M0, m) })));
  assert.ok(res.every((x) => [201, 409].includes(x.status)), JSON.stringify(res.map((x) => x.status)));
  const rows = await assertChain(bConc.id);
  assert.equal(res.filter((x) => x.status === 201).length, rows.length - 1);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_fee_rates WHERE batch_id=$1 AND effective_to IS NULL", [bConc.id])).rows[0].n, 1);
});

test('leave, monthly fee generation and reconciliation', { skip }, async () => {
  const { a, b } = users;
  const { academy, court } = await setup(a, 'Fees academy');
  const { academy: bAcademy } = await setup(b, 'B fees academy');
  const bReg = await mkBatch(a, academy, await court('F1'), 'REGULAR', 'Fee Regular', '1500', '06:00', '07:00'); // initial rate: M0 = 1500.00
  const bCoach = await mkBatch(a, academy, await court('F2'), 'COACHING', 'Fee Coaching', '2500.50', '08:00', '09:00'); // M0 = 2500.50
  assert.equal((await api(a, 'POST', `/batches/${bReg.id}/fee-rates`, { feeAmount: '1400', effectiveFrom: shift(M0, -3) })).status, 201); // M-3..M-1 = 1400.00
  const member = async (name) => (await api(a, 'POST', '/members', { academyId: academy.id, name })).data;
  const assign = async (m, batch, startDate) => { const r = await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: batch.id, startDate }); assert.equal(r.status, 201, JSON.stringify(r)); return r.data; };
  const [m1, m2, m3, m4] = [await member('M One'), await member('M Two'), await member('M Three'), await member('M Four')];
  const ms1 = await assign(m1, bReg, day(shift(M0, -3), 10));          // open, Regular
  const ms2 = await assign(m1, bCoach, M0);                             // same person, Coaching, starts this month (R: mid/1st-of-month start)
  const ms3 = await assign(m2, bReg, day(shift(M0, -3), 5));            // open, Regular
  const ms5 = await assign(m2, bCoach, day(shift(M0, -3), 15));         // open, Coaching (no coaching rate before M0)
  const ms6 = await assign(m3, bReg, day(shift(M0, -2), 20));           // starts mid-month M-2
  const ms4 = await assign(m4, bReg, day(shift(M0, -3), 5));            // will end mid-month M-2
  assert.equal((await api(a, 'POST', `/memberships/${ms4.id}/end`, { effectiveDate: day(shift(M0, -2), 10) })).status, 200);
  const fees = async (q) => (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&${q}`)).data;
  const gen = (month, owner = a, academyId = academy.id) => api(owner, 'POST', '/monthly-fees/generate', { academyId, feeMonth: month });

  // H, I, K, L, J: leave rules
  const leaveUrl = `/memberships/${ms1.id}/leaves`;
  assert.equal((await api(a, 'POST', leaveUrl, { feeMonth: M0 })).status, 201); // H (ms1 this month)
  assert.equal((await api(a, 'POST', leaveUrl, { feeMonth: M0 })).status, 409, 'I: duplicate leave');
  assert.equal((await api(a, 'POST', leaveUrl, { feeMonth: day(M0, 15) })).status, 400, 'leave months are whole months');
  assert.equal((await api(a, 'POST', `/memberships/${ms2.id}/leaves`, { feeMonth: shift(M0, -1) })).status, 400, 'K: before the membership started');
  assert.equal((await api(a, 'POST', `/memberships/${ms4.id}/leaves`, { feeMonth: shift(M0, -1) })).status, 400, 'K: after the membership ended');
  assert.equal((await api(a, 'POST', `/memberships/${ms4.id}/leaves`, { feeMonth: shift(M0, -2) })).status, 201, 'final month of an ended membership is eligible');
  assert.deepEqual((await api(a, 'GET', `/memberships/${ms2.id}/leaves`)).data, [], 'J: leave on ms1 does not touch ms2 (same person)');
  assert.equal((await api(a, 'GET', `/members/${m1.id}`)).data.activeMemberships.find((x) => x.id === ms1.id).leaveMonths[0], M0, 'member detail exposes leave months');
  assert.equal((await api(a, 'DELETE', `/memberships/${ms4.id}/leaves/${shift(M0, -2)}`)).status, 200, 'L: cancel leave');
  assert.equal((await api(a, 'DELETE', `/memberships/${ms4.id}/leaves/${shift(M0, -2)}`)).status, 404);
  assert.deepEqual((await api(a, 'GET', `/memberships/${ms4.id}/leaves`)).data, []);

  // M, N, Q: generate this month (ms1 on leave)
  const g1 = await gen(M0);
  assert.equal(g1.status, 200);
  assert.deepEqual([g1.data.eligible, g1.data.generated, g1.data.onLeave, g1.data.alreadyExisting, g1.data.missingFeeRate], [5, 4, 1, 0, 0]);
  const m0 = await fees(`feeMonth=${M0}`);
  const by = (items, id) => items.find((x) => x.membershipId === id);
  assert.deepEqual([by(m0.items, ms1.id).status, by(m0.items, ms1.id).applicableFee], ['ON_LEAVE', '0.00'], 'N');
  assert.deepEqual([by(m0.items, ms3.id).status, by(m0.items, ms3.id).applicableFee], ['PENDING', '1500.00'], 'M');
  assert.deepEqual([by(m0.items, ms2.id).status, by(m0.items, ms2.id).applicableFee, by(m0.items, ms2.id).type], ['PENDING', '2500.50', 'COACHING']);
  assert.notEqual(by(m0.items, ms1.id).id, by(m0.items, ms2.id).id, 'Q: Regular and Coaching are separate obligations for one person');
  assert.equal(m0.items.filter((x) => x.memberId === m1.id).length, 2);
  assert.ok(m0.items.every((x) => x.membershipId !== ms4.id), 'ended-before-month membership is not billed');
  // W: expected collection = sum of non-leave obligations; ON_LEAVE excluded; no payment metrics exposed
  const expected = m0.items.filter((x) => x.status === 'PENDING').reduce((s, x) => s + toCents(x.applicableFee), 0n);
  assert.equal(toCents(m0.summary.expectedCollection), expected);
  assert.equal((await admin.query("SELECT COALESCE(SUM(f.applicable_fee),0)::text s FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id WHERE m.academy_id=$1 AND f.fee_month=$2", [academy.id, M0])).rows[0].s, m0.summary.expectedCollection);
  assert.deepEqual([m0.summary.pendingCount, m0.summary.onLeaveCount, m0.summary.totalCount], [4, 1, 5]);
  // Phase 6 widened the summary with payment-aware figures; with no payments yet they are all zero (Phase-5 expectations hold)
  assert.deepEqual(Object.keys(m0.summary).sort(), ['collected', 'expectedCollection', 'onLeaveCount', 'outstanding', 'paidCount', 'partiallyPaidCount', 'pendingCount', 'totalCount']);
  assert.deepEqual([m0.summary.collected, m0.summary.outstanding, m0.summary.paidCount, m0.summary.partiallyPaidCount], ['0.00', m0.summary.expectedCollection, 0, 0]);
  // O: idempotent
  const g2 = await gen(M0);
  assert.deepEqual([g2.data.generated, g2.data.onLeave, g2.data.alreadyExisting], [0, 0, 5]);
  assert.equal((await fees(`feeMonth=${M0}`)).items.length, 5);

  // P: concurrent generation for a fresh month -> one obligation per membership
  const M1 = shift(M0, -1);
  const conc = await Promise.all(Array.from({ length: 6 }, () => gen(M1)));
  assert.ok(conc.every((x) => x.status === 200));
  assert.equal(conc.reduce((s, x) => s + x.data.generated, 0), 3, 'exactly 3 created in total (ms1, ms3, ms6)');
  const rowsM1 = (await admin.query("SELECT membership_id, count(*)::int n FROM owner_monthly_fees WHERE fee_month=$1 AND membership_id = ANY($2) GROUP BY 1", [M1, [ms1.id, ms2.id, ms3.id, ms5.id, ms6.id]])).rows;
  assert.ok(rowsM1.every((x) => x.n === 1));
  // T: ms5 has no coaching rate before M0 -> reported, nothing invented
  assert.equal(conc[0].data.missingFeeRate, 1); assert.equal(conc[0].data.missing[0].membershipId, ms5.id);
  assert.equal(rowsM1.length, 3);
  assert.equal(by((await fees(`feeMonth=${M1}`)).items, ms1.id).applicableFee, '1400.00', 'V: the rate in force on the 1st of that month');
  // R, S: mid-month start / end are eligible with the first-of-month rate (no proration)
  const M2 = shift(M0, -2);
  const g3 = await gen(M2);
  assert.deepEqual([g3.data.eligible, g3.data.generated, g3.data.missingFeeRate], [5, 4, 1]);
  const m2items = (await fees(`feeMonth=${M2}`)).items;
  assert.equal(by(m2items, ms6.id).applicableFee, '1400.00', 'R: started on the 20th, full-month fee');
  assert.equal(by(m2items, ms4.id).applicableFee, '1400.00', 'S: ended on the 10th, full-month fee');
  // reconciliation: leave added after generation -> same row becomes ON_LEAVE/0; cancelled -> restored PENDING at the right rate
  const before = by((await fees(`feeMonth=${M0}`)).items, ms3.id);
  assert.equal((await api(a, 'POST', `/memberships/${ms3.id}/leaves`, { feeMonth: M0 })).status, 201);
  const onLeave = by((await fees(`feeMonth=${M0}`)).items, ms3.id);
  assert.deepEqual([onLeave.id, onLeave.status, onLeave.applicableFee], [before.id, 'ON_LEAVE', '0.00']);
  assert.equal(toCents((await fees(`feeMonth=${M0}`)).summary.expectedCollection), expected - toCents('1500.00'));
  assert.equal((await api(a, 'DELETE', `/memberships/${ms3.id}/leaves/${M0}`)).status, 200);
  const restored = by((await fees(`feeMonth=${M0}`)).items, ms3.id);
  assert.deepEqual([restored.id, restored.status, restored.applicableFee], [before.id, 'PENDING', '1500.00']);
  assert.equal((await fees(`feeMonth=${M0}`)).items.length, 5, 'still one obligation per membership');
  // leave with no rate: generation creates ON_LEAVE (no rate needed) but cancelling cannot restore a fee it cannot price
  assert.equal((await api(a, 'POST', `/memberships/${ms5.id}/leaves`, { feeMonth: M1 })).status, 201);
  const g4 = await gen(M1);
  assert.deepEqual([g4.data.generated, g4.data.onLeave, g4.data.missingFeeRate], [0, 1, 0]);
  const cancelNoRate = await api(a, 'DELETE', `/memberships/${ms5.id}/leaves/${M1}`);
  assert.equal(cancelNoRate.status, 409);
  assert.equal(by((await fees(`feeMonth=${M1}`)).items, ms5.id).status, 'ON_LEAVE', 'unchanged after refused cancel');
  assert.equal((await api(a, 'GET', `/memberships/${ms5.id}/leaves`)).data.length, 1, 'leave kept after refused cancel');

  // U, V: a later fee change never rewrites generated snapshots; later months use the new rate
  const snapshot = async () => (await admin.query("SELECT membership_id, fee_month::text m, applicable_fee::text f, status FROM owner_monthly_fees WHERE membership_id = ANY($1) ORDER BY 1,2", [[ms1, ms2, ms3, ms4, ms5, ms6].map((x) => x.id)])).rows;
  const snapBefore = await snapshot();
  assert.equal((await api(a, 'POST', `/batches/${bReg.id}/fee-rates`, { feeAmount: '1800.25', effectiveFrom: shift(M0, 1) })).status, 201);
  assert.deepEqual(await snapshot(), snapBefore, 'U: existing snapshots identical after a fee change');
  assert.deepEqual([(await gen(M0)).data.generated, (await gen(M2)).data.generated], [0, 0], 'regenerating old months changes nothing');
  assert.deepEqual(await snapshot(), snapBefore);
  const next = shift(M0, 1);
  await api(a, 'DELETE', `/memberships/${ms1.id}/leaves/${M0}`); // back to pending for this month
  const g5 = await gen(next);
  assert.equal(by((await fees(`feeMonth=${next}`)).items, ms3.id).applicableFee, '1800.25', 'V: later month uses the new Owner-defined rate');
  assert.equal(by((await fees(`feeMonth=${next}`)).items, ms2.id).applicableFee, '2500.50', 'coaching rate unchanged');
  assert.equal(g5.data.missingFeeRate, 0);
  assert.equal(by((await fees(`feeMonth=${M0}`)).items, ms3.id).applicableFee, '1500.00', 'this month still on the old rate');
  // filters
  assert.ok((await fees(`feeMonth=${M0}&status=ON_LEAVE`)).items.every((x) => x.status === 'ON_LEAVE'));
  assert.deepEqual((await fees(`feeMonth=${M0}&memberId=${m1.id}`)).items.map((x) => x.memberId), [m1.id, m1.id]);
  assert.equal((await api(a, 'GET', `/monthly-fees?status=ADVANCE`)).status, 400, 'ADVANCE is not a status (advance is credit)');
  assert.equal((await api(a, 'GET', `/monthly-fees?feeMonth=2026-10-15`)).status, 400);
  assert.equal((await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id })).status, 400);

  // Y: Owner B cannot see or change Owner A's leave / obligations
  const ownerB = [
    api(b, 'GET', `/memberships/${ms1.id}/leaves`), api(b, 'POST', `/memberships/${ms1.id}/leaves`, { feeMonth: shift(M0, 4) }),
    api(b, 'DELETE', `/memberships/${ms3.id}/leaves/${M0}`), gen(M0, b, academy.id),
  ];
  assert.deepEqual((await Promise.all(ownerB)).map((x) => x.status), [404, 404, 404, 404]);
  const bView = await api(b, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}`);
  assert.deepEqual([bView.data.items.length, bView.data.summary.expectedCollection, bView.data.summary.totalCount], [0, '0.00', 0]);
  assert.deepEqual((await api(b, 'GET', '/monthly-fees')).data.items, []);
  assert.equal((await gen(M0, b, bAcademy.id)).data.eligible, 0, "B's own academy generates only B's data");
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_monthly_leaves WHERE membership_id = ANY($1)", [[ms1.id, ms2.id, ms3.id]])).rows[0].n, 0, "A's leaves untouched by B");
  // no payment has been recorded in this scenario, so nothing may look paid
  assert.ok(m0.items.every((i) => i.paidAmount === '0.00' && ['PENDING', 'ON_LEAVE'].includes(i.status)));
  assert.equal(todayIST() >= M0, true);
});

test('roles and users untouched by fee-engine operations', { skip }, async () => {
  const ids = Object.values(users).map((u) => u.id);
  assert.deepEqual((await admin.query("SELECT role FROM users WHERE id = ANY($1)", [ids])).rows.map((r) => r.role), ['PLAYER', 'PLAYER']);
  assert.equal((await admin.query("SELECT count(*)::int n FROM users WHERE mobile LIKE $1", [`+91${tag}%`])).rows[0].n, 2);
});
