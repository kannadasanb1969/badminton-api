// Phase 7 reporting tests (A-AC) against the LOCAL DEVELOPMENT database only (q2-friendly-test). Dates derive from "today".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { currentMonthIST, todayIST } from '../src/utils/owner-dates.js';
import { loadDashboard } from '../src/services/owner-dashboard.service.js';
import { toCents } from '../src/utils/owner-money.js';

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
const [M1, M2, M3] = [shift(M0, -1), shift(M0, -2), shift(M0, -3)];
const day = (m, n) => `${m.slice(0, 8)}${String(n).padStart(2, '0')}`;

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(env, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, ...(await res.json()) };
}

before(async () => {
  if (!enabled) return;
  admin = new pg.Pool({ connectionString: config.connectionString, max: 4, idleTimeoutMillis: 15000 });
  admin.on('error', () => {});
  for (const [key, suffix] of [['a', '1'], ['b', '2']]) {
    users[key] = (await admin.query("INSERT INTO users (mobile, role) VALUES ($1,'PLAYER') RETURNING id, role", [`+91${tag}${suffix}`])).rows[0];
  }
});
after(async () => {
  if (!enabled) return;
  const ids = Object.values(users).map((u) => u.id);
  const academies = "(SELECT id FROM owner_academies WHERE owner_profile_id IN (SELECT id FROM owner_profiles WHERE user_id = ANY($1)))";
  const members = `(SELECT id FROM owner_members WHERE academy_id IN ${academies})`;
  const memberships = `(SELECT id FROM owner_memberships WHERE member_id IN ${members})`;
  const batches = `(SELECT id FROM owner_batches WHERE academy_id IN ${academies})`;
  const fees = `(SELECT id FROM owner_monthly_fees WHERE membership_id IN ${memberships})`;
  const tx = await admin.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL smashpoint.owner_payment_cleanup = 'on'");
    for (const sql of [
      `DELETE FROM owner_payment_allocations WHERE monthly_fee_id IN ${fees}`, `DELETE FROM owner_payments WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_receipt_counters WHERE academy_id IN ${academies}`, `DELETE FROM owner_monthly_fees WHERE membership_id IN ${memberships}`,
      `DELETE FROM owner_monthly_leaves WHERE membership_id IN ${memberships}`, `DELETE FROM owner_memberships WHERE member_id IN ${members}`,
      `DELETE FROM owner_members WHERE academy_id IN ${academies}`, `DELETE FROM owner_fee_rates WHERE batch_id IN ${batches}`,
      `DELETE FROM owner_batches WHERE academy_id IN ${academies}`, `DELETE FROM owner_courts WHERE academy_id IN ${academies}`,
      `DELETE FROM owner_academies WHERE owner_profile_id IN (SELECT id FROM owner_profiles WHERE user_id = ANY($1))`,
      'DELETE FROM owner_profiles WHERE user_id = ANY($1)', 'DELETE FROM users WHERE id = ANY($1)']) await tx.query(sql, [ids]);
    await tx.query('COMMIT');
  } catch (e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }
  await admin.end();
});

test('dashboard reporting', { skip }, async () => {
  const { a, b } = users;
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const academy = (await api(a, 'POST', '/academies', { name: 'Dash academy' })).data;
  const bAcademy = (await api(b, 'POST', '/academies', { name: 'Empty academy' })).data;

  // AB-empty: an academy with nothing in it still answers, with exact zeros and empty lists
  const empty = (await api(b, 'GET', `/dashboard?academyId=${bAcademy.id}`)).data;
  assert.deepEqual(empty.operations, { activeCourts: 0, activeBatches: 0, activeMembers: 0, regularPlayers: 0, coachingStudents: 0, activeMemberships: 0 });
  assert.deepEqual([empty.financial.expectedCollection, empty.financial.collected, empty.financial.outstanding, empty.financial.totalCount, empty.financial.notGeneratedCount], ['0.00', '0.00', '0.00', 0, 0]);
  assert.deepEqual([empty.recentPayments, empty.credit.members, empty.credit.totalAvailableCredit, empty.credit.membersWithCredit, empty.needsAttention.outstanding, empty.needsAttention.notGenerated.items],
    [[], [], '0.00', 0, [], []]);
  assert.equal(empty.feeMonth, M0, 'defaults to the current Owner month');
  assert.equal((await api(b, 'GET', '/dashboard')).data.academy.id, bAcademy.id, 'academy defaults to the Owner\'s first academy');

  const court = async (n) => (await api(a, 'POST', `/academies/${academy.id}/courts`, { name: n })).data;
  const [c1, c2] = [await court('Dash C1'), await court('Dash C2')];
  const batch = async (c, type, name, fee, s, e) => (await api(a, 'POST', '/batches', { academyId: academy.id, courtId: c.id, type, name, startTime: s, endTime: e, feePerPerson: fee })).data;
  const r1 = await batch(c1, 'REGULAR', 'Dash R1', '1000', '06:00', '07:00');
  const k1 = await batch(c1, 'COACHING', 'Dash K1', '2000', '18:00', '19:00');
  const r2 = await batch(c2, 'REGULAR', 'Dash R2', '600', '08:00', '09:00');
  const r3 = await batch(c2, 'REGULAR', 'Dash R3', '700', '12:00', '13:00'); // no rate before the current month
  for (const [bt, amt] of [[r1, '800'], [k1, '1500'], [r2, '500']]) assert.equal((await api(a, 'POST', `/batches/${bt.id}/fee-rates`, { feeAmount: amt, effectiveFrom: M3 })).status, 201);

  const member = async (name, mobile) => (await api(a, 'POST', '/members', { academyId: academy.id, name, ...(mobile ? { mobile } : {}) })).data;
  const join = async (m, bt, startDate) => { const r = await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: bt.id, startDate }); assert.equal(r.status, 201, JSON.stringify(r)); return r.data; };
  const [alice, bob, cara, dan, eve, fay, gus] = [await member('Alice', '9100000001'), await member('Bob'), await member('Cara'), await member('Dan'), await member('Eve'), await member('Fay'), await member('Gus')];
  const early = day(M3, 5);
  const aliceR = await join(alice, r1, early); const aliceK = await join(alice, k1, early);
  await join(bob, r1, early); await join(cara, k1, early);
  const danMs = await join(dan, r2, early);
  const eveMs = await join(eve, r2, early);
  const fayMs = await join(fay, r1, early);
  const gusMs = await join(gus, r3, day(M1, 3));
  assert.equal((await api(a, 'POST', `/memberships/${eveMs.id}/end`, { effectiveDate: day(M1, 10) })).status, 200);
  assert.equal((await api(a, 'POST', `/memberships/${fayMs.id}/end`, { effectiveDate: day(M2, 20) })).status, 200);
  assert.equal((await api(a, 'POST', `/memberships/${gusMs.id}/end`, { effectiveDate: day(M1, 20) })).status, 200);

  const dash = async (q = '') => (await api(a, 'GET', `/dashboard?academyId=${academy.id}${q}`)).data;
  const gen = async (m) => (await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: m })).data;

  // W: not generated, before anything is generated (membership dates only; no fee rows exist)
  const m3before = await dash(`&feeMonth=${M3}`);
  assert.equal(m3before.financial.totalCount, 0);
  assert.equal(m3before.financial.notGeneratedCount, 7, 'alice x2, bob, cara, dan, eve, fay are eligible; gus started later');
  assert.equal(m3before.financial.missingFeeRateCount, 0);
  const m1before = await dash(`&feeMonth=${M1}`);
  assert.deepEqual([m1before.financial.notGeneratedCount, m1before.financial.missingFeeRateCount], [7, 1], 'gus: eligible, but Dash R3 has no fee rate in M1');
  assert.equal(m1before.financial.expectedCollection, '0.00', 'not generated is NOT a zero-value due and NOT paid');
  assert.deepEqual(m1before.needsAttention.notGenerated.items.filter((i) => i.missingFeeRate).map((i) => i.memberName), ['Gus']);

  // generate M2, M1 and M0 (dan on leave in M0)
  assert.equal((await api(a, 'POST', `/memberships/${danMs.id}/leaves`, { feeMonth: M0 })).status, 201);
  for (const m of [M2, M1, M0]) assert.equal((await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: m })).status, 200);
  const g1 = await gen(M1);
  assert.deepEqual([g1.generated, g1.alreadyExisting, g1.missingFeeRate], [0, 6, 1]);
  assert.deepEqual([(await dash(`&feeMonth=${M1}`)).financial.notGeneratedCount, (await dash(`&feeMonth=${M1}`)).financial.missingFeeRateCount], [1, 1]);
  assert.equal((await dash(`&feeMonth=${M0}`)).financial.notGeneratedCount, 0, 'nothing eligible is missing in the current month');

  // payments (manual allocations so the numbers are exact)
  const feeId = async (month, memberName, batchName) => (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${month}`)).data.items.find((i) => i.memberName === memberName && i.batchName === batchName).id;
  const pay = (memberId, amount, allocations, extra = {}) => api(a, 'POST', '/payments', { memberId, amount, paymentMode: 'CASH', paymentDate: todayIST(), allocationMode: 'MANUAL', allocations, ...extra });
  assert.equal((await pay(alice.id, '1000', [{ monthlyFeeId: await feeId(M0, 'Alice', 'Dash R1'), amount: '1000' }])).status, 201);
  assert.equal((await pay(alice.id, '500', [{ monthlyFeeId: await feeId(M0, 'Alice', 'Dash K1'), amount: '500' }])).status, 201);
  const bobPay = await pay(bob.id, '1500.00', [{ monthlyFeeId: await feeId(M0, 'Bob', 'Dash R1'), amount: '1000' }]);
  assert.equal(bobPay.data.creditRemaining, '500.00');
  const eveFee = await feeId(M1, 'Eve', 'Dash R2');
  const evePays = [];
  for (let i = 0; i < 3; i += 1) evePays.push((await pay(eve.id, '10', [{ monthlyFeeId: eveFee, amount: '10' }], { paymentDate: day(M1, 5) })).data);

  // A, B, C, D: operations. People, not rows.
  const d0 = await dash();
  assert.deepEqual(d0.operations, { activeCourts: 2, activeBatches: 4, activeMembers: 4, regularPlayers: 3, coachingStudents: 2, activeMemberships: 5 });
  assert.equal(d0.operations.activeMembers < d0.operations.activeMemberships, true, 'Alice (Regular + Coaching) is counted once as a member');
  assert.equal((await admin.query("SELECT count(DISTINCT m.id)::int n FROM owner_members m JOIN owner_memberships ms ON ms.member_id=m.id AND ms.status='ACTIVE' WHERE m.academy_id=$1 AND m.status='ACTIVE'", [academy.id])).rows[0].n, d0.operations.activeMembers);
  // an inactive court and an inactive member do not count
  assert.equal((await api(a, 'PATCH', `/members/${fay.id}`, { status: 'INACTIVE' })).data.status, 'INACTIVE');
  assert.equal((await dash()).operations.activeMembers, 4);

  // E-L: current month. Expected 6000 (Dan on leave = 0); Collected 2500 from allocations only; credit separate.
  const f0 = d0.financial;
  assert.deepEqual([f0.expectedCollection, f0.collected, f0.outstanding], ['6000.00', '2500.00', '3500.00']);
  assert.deepEqual([f0.pendingCount, f0.partiallyPaidCount, f0.paidCount, f0.onLeaveCount, f0.totalCount], [1, 1, 2, 1, 5]);
  assert.equal(toCents(f0.expectedCollection) - toCents(f0.collected), toCents(f0.outstanding), 'H: outstanding = expected - collected');
  const gross0 = (await admin.query("SELECT COALESCE(SUM(p.amount),0)::text s FROM owner_payments p WHERE p.academy_id=$1 AND p.payment_date = $2::date", [academy.id, todayIST()])).rows[0].s;
  assert.equal(gross0, '3000.00');
  assert.equal(f0.collected, '2500.00', 'G: the unused 500.00 of credit is not collected');
  assert.equal((await admin.query(`SELECT COALESCE(SUM(al.amount),0)::text s FROM owner_payment_allocations al JOIN owner_monthly_fees f ON f.id=al.monthly_fee_id JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id WHERE m.academy_id=$1 AND f.fee_month=$2`, [academy.id, M0])).rows[0].s, '2500.00', 'independent SQL agrees');

  // U, V: credit (derived, exact)
  assert.deepEqual([d0.credit.membersWithCredit, d0.credit.totalAvailableCredit], [1, '500.00']);
  assert.deepEqual(d0.credit.members.map((m) => [m.memberName, m.availableCredit]), [['Bob', '500.00']]);
  assert.equal((await dash()).financial.outstanding, '3500.00', 'credit does not reduce outstanding until it is applied');

  // S, T: recent payments, newest first, limit 5 (6 exist)
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_payments WHERE academy_id=$1", [academy.id])).rows[0].n, 6);
  assert.equal(d0.recentPayments.length, 5);
  assert.deepEqual(d0.recentPayments.map((p) => p.amount), ['1500.00', '500.00', '1000.00', '10.00', '10.00']);
  assert.equal(d0.recentPayments[0].id, bobPay.data.id);
  assert.equal(d0.recentPayments[0].memberName, 'Bob');
  assert.deepEqual(Object.keys(d0.recentPayments[0]).sort(), ['amount', 'createdAt', 'id', 'memberId', 'memberName', 'paymentDate', 'paymentMode', 'receiptNumber']);
  assert.ok(d0.recentPayments.slice(3).every((p) => p.paymentDate === day(M1, 5)), 'older-dated payments follow the newer ones');

  // N, O, P, Q, R: filters change the summary AND the list consistently
  const combos = [
    ['', ''], [`&courtId=${c1.id}`, 'c1'], [`&courtId=${c2.id}`, 'c2'], [`&batchId=${k1.id}`, 'k1'], [`&batchId=${r1.id}`, 'r1'],
    ['&type=REGULAR', 'reg'], ['&type=COACHING', 'coach'], [`&courtId=${c1.id}&type=REGULAR`, 'c1+reg'], [`&courtId=${c2.id}&type=COACHING`, 'c2+coach'],
  ];
  const expectations = {
    '': ['6000.00', '2500.00', '3500.00', 1, 1, 2, 1], c1: ['6000.00', '2500.00', '3500.00', 1, 1, 2, 0], c2: ['0.00', '0.00', '0.00', 0, 0, 0, 1],
    k1: ['4000.00', '500.00', '3500.00', 1, 1, 0, 0], r1: ['2000.00', '2000.00', '0.00', 0, 0, 2, 0], reg: ['2000.00', '2000.00', '0.00', 0, 0, 2, 1],
    coach: ['4000.00', '500.00', '3500.00', 1, 1, 0, 0], 'c1+reg': ['2000.00', '2000.00', '0.00', 0, 0, 2, 0], 'c2+coach': ['0.00', '0.00', '0.00', 0, 0, 0, 0],
  };
  for (const [q, key] of combos) {
    const d = await dash(`&feeMonth=${M0}${q}`);
    const list = (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}${q}`)).data;
    const f = d.financial;
    assert.deepEqual([f.expectedCollection, f.collected, f.outstanding, f.pendingCount, f.partiallyPaidCount, f.paidCount, f.onLeaveCount], expectations[key], `filter ${key || 'none'}`);
    // the dashboard, the Fees summary and the Fees list describe the same slice
    assert.equal(list.summary.expectedCollection, f.expectedCollection, `Fees summary matches dashboard (${key})`);
    assert.equal(list.summary.collected, f.collected);
    assert.equal(list.items.length, f.totalCount, `list rows = status counts (${key})`);
    assert.equal(list.items.reduce((s, i) => s + toCents(i.applicableFee), 0n), toCents(f.expectedCollection), `list sums to Expected (${key})`);
    assert.equal(list.items.reduce((s, i) => s + toCents(i.paidAmount), 0n), toCents(f.collected), `list sums to Collected (${key})`);
    assert.equal(toCents(f.expectedCollection) - toCents(f.collected), toCents(f.outstanding));
    // operations are academy-wide and unaffected by collection filters
    assert.deepEqual(d.operations, d0.operations);
  }
  assert.equal((await api(a, 'GET', `/dashboard?academyId=${academy.id}&type=MONTHLY`)).status, 400);
  // status is a LIST filter: it narrows rows but not the summary counts
  const onlyPartial = (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}&status=PARTIALLY_PAID`)).data;
  assert.equal(onlyPartial.items.length, 1);
  assert.equal(onlyPartial.summary.totalCount, 5, 'summary still describes the whole slice');
  const outstandingList = (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&outstanding=true`)).data.items;
  assert.ok(outstandingList.every((i) => ['PENDING', 'PARTIALLY_PAID'].includes(i.status) && toCents(i.balance) > 0n));
  const months = outstandingList.map((i) => i.feeMonth);
  assert.deepEqual(months, [...months].sort(), 'oldest fee month first');
  assert.ok(outstandingList[0].memberMobile !== undefined && 'courtId' in outstandingList[0]);

  // Needs attention: unpaid + partial for the month, never PAID / ON_LEAVE
  assert.deepEqual(d0.needsAttention.outstanding.map((i) => [i.memberName, i.status, i.balance]).sort(), [['Alice', 'PARTIALLY_PAID', '1500.00'], ['Cara', 'PENDING', '2000.00']]);
  assert.equal(d0.needsAttention.outstandingCount, 2);
  assert.deepEqual(d0.needsAttention.pendingByBatch.map((x) => [x.batchName, x.outstanding, x.feeCount]), [['Dash K1', '3500.00', 2]]);

  // M, X, Y: historical months use snapshots and date intersection, not today's status
  const h1 = await dash(`&feeMonth=${M1}`);
  assert.deepEqual([h1.financial.expectedCollection, h1.financial.collected, h1.financial.outstanding], ['5600.00', '30.00', '5570.00']);
  assert.deepEqual([h1.financial.pendingCount, h1.financial.partiallyPaidCount, h1.financial.paidCount, h1.financial.totalCount], [5, 1, 0, 6]);
  assert.ok((await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M1}`)).data.items.some((i) => i.memberName === 'Eve'), 'X: Eve ended in M1 but still has her M1 snapshot');
  const h2 = await dash(`&feeMonth=${M2}`);
  assert.equal(h2.financial.expectedCollection, '6400.00');
  assert.ok((await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M2}`)).data.items.some((i) => i.memberName === 'Fay'), 'Y: Fay is INACTIVE now, her M2 fee is still reported');
  assert.equal(h2.financial.notGeneratedCount, 0, 'Gus was only eligible in M1');
  assert.equal((await dash(`&feeMonth=${M1}`)).financial.notGeneratedCount, 1);
  // history is not rewritten by the current state of memberships or members
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_memberships WHERE status='ENDED' AND member_id IN (SELECT id FROM owner_members WHERE academy_id=$1)", [academy.id])).rows[0].n, 3);

  // AB: exact decimals survive (cent-level fee + cent-level payment)
  const tiny = await member('Tiny');
  const tinyBatch = await batch(c2, 'REGULAR', 'Dash Tiny', '0.30', '14:00', '15:00');
  await join(tiny, tinyBatch, M0);
  await gen(M0);
  await pay(tiny.id, '0.10', [{ monthlyFeeId: await feeId(M0, 'Tiny', 'Dash Tiny'), amount: '0.10' }]);
  const dTiny = await dash(`&feeMonth=${M0}&batchId=${tinyBatch.id}`);
  assert.deepEqual([dTiny.financial.expectedCollection, dTiny.financial.collected, dTiny.financial.outstanding], ['0.30', '0.10', '0.20']);
  assert.ok(/^\d+\.\d{2}$/.test(dTiny.financial.outstanding) && /^\d+\.\d{2}$/.test(d0.credit.totalAvailableCredit), 'money is always an exact two-decimal string');

  // Z: Owner B cannot read Owner A's reporting data, whichever way it asks
  assert.equal((await api(b, 'GET', `/dashboard?academyId=${academy.id}`)).status, 404);
  assert.equal((await api(b, 'GET', `/dashboard?academyId=${academy.id}&courtId=${c1.id}&feeMonth=${M0}`)).status, 404);
  const bFees = (await api(b, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}`)).data;
  assert.deepEqual([bFees.items.length, bFees.summary.totalCount, bFees.summary.expectedCollection, bFees.notGenerated], [0, 0, '0.00', undefined], 'no counts leak for a foreign academy');
  const bOwn = (await api(b, 'GET', `/dashboard?academyId=${bAcademy.id}&courtId=${c1.id}&batchId=${r1.id}`)).data;
  assert.deepEqual([bOwn.financial.totalCount, bOwn.needsAttention.outstanding.length, bOwn.options.courts.length], [0, 0, 0], "foreign court/batch ids select nothing and Owner B's options never list Owner A's");

  // AC: the number of queries is constant, whatever the number of members / payments / fees
  const profileId = (await admin.query('SELECT id FROM owner_profiles WHERE user_id=$1', [a.id])).rows[0].id;
  const counted = async () => {
    const client = await admin.connect();
    let n = 0;
    const wrapper = { query: (...args) => { n += 1; return client.query(...args); } };
    try { await loadDashboard(wrapper, { id: profileId }, { academyId: academy.id, feeMonth: M0 }); } finally { client.release(); }
    return n;
  };
  const queriesBefore = await counted();
  await admin.query(`INSERT INTO owner_members (academy_id, name) SELECT $1, 'Bulk ' || g FROM generate_series(1, 40) g`, [academy.id]);
  await admin.query(`INSERT INTO owner_memberships (member_id, batch_id, start_date) SELECT m.id, $2, $3::date FROM owner_members m WHERE m.academy_id=$1 AND m.name LIKE 'Bulk %'`, [academy.id, r2.id, day(M3, 5)]);
  await admin.query(`INSERT INTO owner_payments (academy_id, member_id, receipt_number, amount, payment_mode, payment_date)
    SELECT $1, m.id, 'BULK-' || row_number() OVER (), 12.34, 'UPI', $2::date FROM owner_members m WHERE m.academy_id=$1 AND m.name LIKE 'Bulk %'`, [academy.id, todayIST()]);
  const queriesAfter = await counted();
  assert.equal(queriesAfter, queriesBefore, 'the query count does not grow with the data');
  assert.ok(queriesAfter <= 12, `a small, fixed number of queries (${queriesAfter})`);
  const big = await dash();
  assert.equal(big.credit.membersWithCredit, 41, 'Bob + 40 bulk members now hold unallocated payments');
  assert.equal(big.credit.totalAvailableCredit, '993.60', '500.00 + 40 x 12.34, summed exactly in SQL');
  assert.equal(big.credit.members.length, 10, 'the credit list is capped');
  assert.equal(big.operations.activeMembers, 45, 'Alice, Bob, Cara, Dan, Tiny + 40 bulk; not Eve, Fay or Gus');
});
