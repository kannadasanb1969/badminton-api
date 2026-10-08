// Phase 8 reminder tests (A-AJ) against the LOCAL DEVELOPMENT database only (q2-friendly-test).
// Providers are injected through the service's `deps`; the dry-run adapter is also used through the real configuration.
// Each scenario uses its own "today" so reminder slots never interfere. No real WhatsApp message is ever sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { currentMonthIST, todayIST } from '../src/utils/owner-dates.js';
import { toCents } from '../src/utils/owner-money.js';
import { DryRunWhatsAppProvider } from '../src/providers/whatsapp/dry-run.js';
import * as reminders from '../src/services/owner-reminder.service.js';
import { OwnerError } from '../src/services/owner.service.js';

const REQUIRED_ENDPOINT = 'ep-weathered-meadow-b3ot536q';
let enabled = true;
let config;
try { config = getSafeDatabaseConfig(); } catch { enabled = false; }
if (enabled && !new URL(config.connectionString).hostname.startsWith(REQUIRED_ENDPOINT)) throw new Error('Refusing: database endpoint is not the verified q2-friendly-test endpoint');
const skip = !enabled && 'set DB_ENV, ALLOW_DB_INTEGRATION_TESTS and DATABASE_URL_DEV';
const SENDER = '9876500001'; // arbitrary test sender supplied as configuration, like the real one
const env = enabled ? {
  AUTH_TOKEN_SECRET: 'integration-secret',
  HYPERDRIVE: { connectionString: config.connectionString },
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.connectionString,
  WHATSAPP_MODE: 'dry-run',
  WHATSAPP_SENDER_NUMBER: SENDER,
} : {};
const tag = String(Math.floor(Math.random() * 9e7) + 1e7);
const users = {};
let admin;

const M0 = currentMonthIST();
const shift = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10); };
const [M1, M3] = [shift(M0, -1), shift(M0, -3)];
const day = (m, n) => `${m.slice(0, 8)}${String(n).padStart(2, '0')}`;
const plusDays = (n) => new Date(new Date(`${todayIST()}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const on = (n) => ({ today: () => plusDays(n) });

const counting = (inner) => { const p = { name: inner.name, calls: [], async sendMessage(a) { p.calls.push(a); return inner.sendMessage(a); } }; return p; };
const okLive = { name: 'fake-live', async sendMessage() { return { success: true, provider: 'fake-live', providerMessageId: 'wamid.TEST123' }; } };
const rejecting = { name: 'fake-live', async sendMessage() { return { success: false, provider: 'fake-live', errorCode: 'RATE_LIMIT', errorMessage: 'Too many messages' }; } };
const throwing = { name: 'fake-live', async sendMessage() { throw new Error('socket hang up'); } };

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(env, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, ...(await res.json()) };
}
const idOf = (u) => ({ sub: u.id, role: u.role });
const statusOf = async (p) => { try { await p; return 200; } catch (e) { if (e instanceof OwnerError) return e.status; throw e; } };

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
    await tx.query("SET LOCAL smashpoint.owner_reminder_cleanup = 'on'");
    for (const sql of [
      `DELETE FROM owner_fee_reminders WHERE academy_id IN ${academies}`,
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

test('fee reminders', { skip }, async () => {
  const { a, b } = users;
  const A = idOf(a); const B = idOf(b);
  await api(a, 'POST', '/profile'); await api(b, 'POST', '/profile');
  const academy = (await api(a, 'POST', '/academies', { name: 'Reminder Academy' })).data;
  const bAcademy = (await api(b, 'POST', '/academies', { name: 'B Academy' })).data;
  const court = async (n) => (await api(a, 'POST', `/academies/${academy.id}/courts`, { name: n })).data;
  const [c1, c2] = [await court('RC1'), await court('RC2')];
  const batch = async (c, type, name, fee, s, e) => (await api(a, 'POST', '/batches', { academyId: academy.id, courtId: c.id, type, name, startTime: s, endTime: e, feePerPerson: fee })).data;
  const r1 = await batch(c1, 'REGULAR', 'Rem Regular', '1000', '06:00', '07:00');
  const k1 = await batch(c1, 'COACHING', 'Rem Coaching', '2000', '18:00', '19:00');
  const r2 = await batch(c2, 'REGULAR', 'Rem Court2', '600', '08:00', '09:00');
  const tinyB = await batch(c2, 'REGULAR', 'Rem Tiny', '0.30', '12:00', '13:00');
  for (const [bt, amt] of [[r1, '800'], [k1, '1500'], [r2, '500']]) assert.equal((await api(a, 'POST', `/batches/${bt.id}/fee-rates`, { feeAmount: amt, effectiveFrom: M3 })).status, 201);

  const member = async (name, mobile) => (await api(a, 'POST', '/members', { academyId: academy.id, name, ...(mobile ? { mobile } : {}) })).data;
  const join = async (m, bt, startDate) => { const r = await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: bt.id, startDate }); assert.equal(r.status, 201, JSON.stringify(r)); return r.data; };
  const early = day(M3, 5);
  const kumar = await member('Kumar', '9100000001'); const anil = await member('Anil', '9100000002'); const priya = await member('Priya', '9100000003');
  const leena = await member('Leena', '9100000004'); const missy = await member('Missy'); const dan = await member('Dan', '9100000006');
  const tiny = await member('Tiny', '9100000007'); const raj = await member('Raj', '9100000009'); const sita = await member('Sita', '9100000010');
  await join(kumar, r1, early); await join(kumar, k1, early); await join(anil, r1, early); await join(priya, k1, early);
  const leenaMs = await join(leena, r1, early); await join(missy, r1, early); const danMs = await join(dan, r2, early);
  await join(tiny, tinyB, M0); await join(raj, r1, early); await join(sita, r1, early);
  assert.equal((await api(a, 'POST', `/memberships/${leenaMs.id}/leaves`, { feeMonth: M0 })).status, 201);
  for (const m of [M1, M0]) assert.equal((await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: m })).status, 200);

  const feeId = async (month, who, batchName) => (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${month}`)).data.items.find((i) => i.memberName === who && i.batchName === batchName).id;
  const pay = (m, amount, fid) => api(a, 'POST', '/payments', { memberId: m.id, amount, paymentMode: 'CASH', paymentDate: todayIST(), allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: fid, amount }] });
  assert.equal((await pay(anil, '800', await feeId(M1, 'Anil', 'Rem Regular'))).status, 201);
  assert.equal((await pay(anil, '400', await feeId(M0, 'Anil', 'Rem Regular'))).status, 201); // partial: 1000 - 400 = 600 left
  for (const [m, month, amt] of [[priya, M1, '1500'], [priya, M0, '2000'], [leena, M1, '800']]) assert.equal((await pay(m, amt, await feeId(month, m.name, m === priya ? 'Rem Coaching' : 'Rem Regular'))).status, 201);

  const feeSummary = async () => (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}`)).data.summary;
  const historyCount = async () => (await admin.query('SELECT count(*)::int n FROM owner_fee_reminders WHERE academy_id=$1', [academy.id])).rows[0].n;
  const q = { academyId: academy.id, scope: 'MONTH', feeMonth: M0 };

  // ---- A-E, F, G, H, I, X: eligibility is member-grouped and uses current allocation-derived balances
  const el = await reminders.listEligible(env, A, q, on(0));
  const by = Object.fromEntries(el.members.map((m) => [m.memberName, m]));
  assert.deepEqual(Object.keys(by).sort(), ['Anil', 'Dan', 'Kumar', 'Missy', 'Raj', 'Sita', 'Tiny']);
  assert.equal(el.members.length, new Set(el.members.map((m) => m.memberId)).size, 'X: one row per member, never per obligation');
  assert.deepEqual([by.Kumar.itemCount, by.Kumar.total, by.Kumar.status], [2, '3000.00', 'ELIGIBLE']); // A, F
  assert.deepEqual(by.Kumar.items.map((i) => [i.batchName, i.balance]), [['Rem Coaching', '2000.00'], ['Rem Regular', '1000.00']]);
  assert.deepEqual([by.Anil.total, by.Anil.items[0].applicableFee, by.Anil.items[0].paidAmount], ['600.00', '1000.00', '400.00']); // B: only the remaining balance
  assert.equal(by.Priya, undefined, 'C/E: PAID excluded'); assert.equal(by.Leena, undefined, 'D: ON_LEAVE excluded');
  assert.deepEqual([by.Missy.status, by.Missy.mobile], ['MISSING_MOBILE', null]); // I: reported, not discarded
  assert.deepEqual([el.summary.skippedPaid, el.summary.skippedLeave, el.summary.missingMobile, el.summary.eligibleMembers, el.summary.candidates], [1, 1, 1, 6, 7]);
  assert.equal(el.summary.totalOutstanding, '7200.30'); // Kumar 3000 + Anil 600 + Missy 1000 + Dan 600 + Tiny 0.30 + Raj 1000 + Sita 1000
  assert.equal((await admin.query(`SELECT COALESCE(SUM(f.applicable_fee - COALESCE((SELECT SUM(amount) FROM owner_payment_allocations x WHERE x.monthly_fee_id=f.id),0)),0)::text s
    FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id
    WHERE m.academy_id=$1 AND f.fee_month=$2 AND f.status IN ('PENDING','PARTIALLY_PAID')`, [academy.id, M0])).rows[0].s, '7200.30', 'H: total equals the exact SQL sum of remaining balances');
  assert.deepEqual(el.config, { mode: 'DRY_RUN', modeLabel: 'Test / dry run: no real WhatsApp message is delivered', senderNumber: SENDER, senderConfigured: true, ready: true, realDelivery: false }); // S

  // ---- G: several months consolidate into ONE member entry
  const all = await reminders.listEligible(env, A, { academyId: academy.id, scope: 'ALL_OUTSTANDING' }, on(0));
  const kAll = all.members.find((m) => m.memberName === 'Kumar');
  assert.deepEqual([kAll.itemCount, kAll.total, kAll.items.map((i) => i.feeMonth)], [4, '5300.00', [M1, M1, M0, M0]]);
  assert.equal(all.members.find((m) => m.memberName === 'Anil').total, '600.00', 'Anil paid M1 in full');

  // ---- K, AJ: preview creates no history and contains no internal ids
  const before = await historyCount();
  const pv = await reminders.previewReminder(env, A, { memberId: kumar.id, ...q }, on(0));
  assert.equal(await historyCount(), before, 'K: preview wrote nothing');
  assert.deepEqual([pv.eligible, pv.reason, pv.total, pv.sender, pv.recipient, pv.config.mode], [true, null, '3000.00', SENDER, '9100000001', 'DRY_RUN']);
  assert.match(pv.message, /Total Pending: ₹3,000/);
  assert.doesNotMatch(pv.message, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/, 'AJ: no internal ids');
  assert.doesNotMatch(pv.message, /PENDING|PARTIALLY_PAID|ON_LEAVE/);
  const anilPv = await reminders.previewReminder(env, A, { memberId: anil.id, ...q }, on(0));
  assert.match(anilPv.message, /Rem Regular - ₹600\n/); assert.doesNotMatch(anilPv.message, /₹1,000/);
  assert.equal((await reminders.previewReminder(env, A, { memberId: priya.id, ...q }, on(0))).reason, 'PAID');
  assert.equal((await reminders.previewReminder(env, A, { memberId: leena.id, ...q }, on(0))).reason, 'ON_LEAVE');
  assert.equal((await reminders.previewReminder(env, A, { memberId: missy.id, ...q }, on(0))).reason, 'MISSING_MOBILE');
  assert.equal(await historyCount(), before);

  // ---- AE + L: exact decimals; a payment after the preview suppresses the send
  const tinyFee = await feeId(M0, 'Tiny', 'Rem Tiny');
  assert.equal((await pay(tiny, '0.10', tinyFee)).status, 201);
  const tinyPv = await reminders.previewReminder(env, A, { memberId: tiny.id, ...q }, on(0));
  assert.deepEqual([tinyPv.total, tinyPv.items[0].balance], ['0.20', '0.20']); assert.match(tinyPv.message, /₹0\.20/);
  assert.equal((await pay(tiny, '0.20', tinyFee)).status, 201);
  const probe = counting(okLive);
  const stale = await reminders.sendReminder(env, A, { memberId: tiny.id, ...q }, { ...on(0), provider: probe });
  assert.deepEqual([stale.result, stale.reason, probe.calls.length], ['SKIPPED', 'PAID', 0], 'L/M: stale preview, member paid meanwhile');

  // ---- M: partial payment between preview and send reduces the reminder amount
  assert.equal((await pay(anil, '100', await feeId(M0, 'Anil', 'Rem Regular'))).status, 201);
  const reduced = counting(okLive);
  const anilSend = await reminders.sendReminder(env, A, { memberId: anil.id, ...q }, { ...on(1), provider: reduced });
  assert.equal(anilSend.result, 'SENT');
  assert.equal(anilSend.reminder.totalOutstanding, '500.00'); assert.match(reduced.calls[0].body, /₹500/); assert.doesNotMatch(reduced.calls[0].body, /₹600|₹1,000/);

  // ---- N: leave added between preview and send suppresses it
  assert.equal((await reminders.previewReminder(env, A, { memberId: dan.id, ...q }, on(0))).eligible, true);
  assert.equal((await api(a, 'POST', `/memberships/${danMs.id}/leaves`, { feeMonth: M0 })).status, 201);
  const leaveProbe = counting(okLive);
  const danSend = await reminders.sendReminder(env, A, { memberId: dan.id, ...q }, { ...on(0), provider: leaveProbe });
  assert.deepEqual([danSend.result, danSend.reason, leaveProbe.calls.length], ['SKIPPED', 'ON_LEAVE', 0]);

  // ---- I, Z: missing mobile is never sent, and writes no history row
  const missProbe = counting(okLive);
  const missSend = await reminders.sendReminder(env, A, { memberId: missy.id, ...q }, { ...on(0), provider: missProbe });
  assert.deepEqual([missSend.result, missSend.reason, missProbe.calls.length], ['SKIPPED', 'MISSING_MOBILE', 0]);

  // ---- Q, S, U: dry run through the REAL configuration: DRY_RUN, never SENT; duplicate blocked
  const hBefore = await historyCount();
  const first = await reminders.sendReminder(env, A, { memberId: kumar.id, ...q }, on(0));
  assert.equal(first.result, 'DRY_RUN');
  const row = (await admin.query('SELECT * FROM owner_fee_reminders WHERE id=$1', [first.reminder.id])).rows[0];
  assert.deepEqual([row.status, row.provider, row.sent_at, row.provider_message_id, row.sender_number, row.recipient_number, row.total_outstanding, row.item_count, row.scope_key],
    ['DRY_RUN', 'dry-run', null, null, `+91${SENDER}`, '+919100000001', '3000.00', 2, `MONTH:${M0}`]);
  assert.equal(first.reminder.delivered, false);
  assert.equal(await historyCount(), hBefore + 1);
  const dupProbe = counting(new DryRunWhatsAppProvider());
  const dup = await reminders.sendReminder(env, A, { memberId: kumar.id, ...q }, { ...on(0), provider: dupProbe });
  assert.deepEqual([dup.result, dup.reason, dupProbe.calls.length, await historyCount()], ['SKIPPED', 'ALREADY_REMINDED_TODAY', 0, hBefore + 1], 'U: blocked, no second dispatch, no second row');
  assert.equal((await reminders.previewReminder(env, A, { memberId: kumar.id, ...q }, on(0))).reason, 'ALREADY_REMINDED_TODAY');
  assert.equal((await reminders.listEligible(env, A, q, on(0))).members.find((m) => m.memberName === 'Kumar').status, 'ALREADY_REMINDED_TODAY');

  // ---- V, O, R: next day is a new day; a live provider accepting stores SENT and its message id
  const live = counting(okLive);
  const next = await reminders.sendReminder(env, A, { memberId: kumar.id, ...q }, { ...on(1), provider: live });
  assert.deepEqual([next.result, next.reminder.status, next.reminder.providerMessageId, next.reminder.delivered, live.calls.length], ['SENT', 'SENT', 'wamid.TEST123', true, 1]);
  assert.deepEqual([live.calls[0].from, live.calls[0].to], [`+91${SENDER}`, '+919100000001']); // J: provider boundary format
  assert.ok((await admin.query('SELECT sent_at FROM owner_fee_reminders WHERE id=$1', [next.reminder.id])).rows[0].sent_at);

  // ---- P: a provider failure is FAILED (never SENT) and does not block a same-day retry
  const failA = await reminders.sendReminder(env, A, { memberId: sita.id, ...q }, { ...on(2), provider: rejecting });
  assert.deepEqual([failA.result, failA.reminder.status, failA.reminder.failureCode, failA.reminder.delivered], ['FAILED', 'FAILED', 'RATE_LIMIT', false]);
  const thrown = await reminders.sendReminder(env, A, { memberId: raj.id, ...q }, { ...on(2), provider: throwing });
  assert.deepEqual([thrown.result, thrown.reminder.failureCode], ['FAILED', 'PROVIDER_EXCEPTION']);
  const retry = await reminders.sendReminder(env, A, { memberId: sita.id, ...q }, { ...on(2), provider: okLive });
  assert.equal(retry.result, 'SENT', 'a failed attempt does not count as "reminded today"');
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_fee_reminders WHERE member_id=$1 AND reminder_date=$2", [sita.id, plusDays(2)])).rows[0].n, 2, 'both attempts are in the history');
  // an unsupported / unconfigured real mode is refused up front (409): nothing is claimed, nothing is recorded, nothing can look sent
  const histBeforeUnsupported = await historyCount();
  const refused = await reminders.sendReminder({ ...env, WHATSAPP_MODE: 'meta-cloud' }, A, { memberId: dan.id, scope: 'ALL_OUTSTANDING', academyId: academy.id }, on(2)).catch((e) => e);
  assert.equal(refused.status, 409); assert.match(refused.message, /not supported/);
  assert.equal(await historyCount(), histBeforeUnsupported);

  // ---- W: concurrent taps dispatch at most once
  const race = counting(okLive);
  const results = await Promise.all(Array.from({ length: 6 }, () => reminders.sendReminder(env, A, { memberId: raj.id, ...q }, { ...on(3), provider: race })));
  assert.deepEqual([results.filter((r) => r.result === 'SENT').length, results.filter((r) => r.reason === 'ALREADY_REMINDED_TODAY').length, race.calls.length], [1, 5, 1]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_fee_reminders WHERE member_id=$1 AND reminder_date=$2 AND status IN ('SENDING','SENT','DRY_RUN')", [raj.id, plusDays(3)])).rows[0].n, 1);

  // ---- AI (Phase 8.1): filters narrow message coverage, but never grant another daily allowance
  const coach = await reminders.sendReminder(env, A, { memberId: kumar.id, ...q, type: 'COACHING' }, { ...on(4), provider: counting(okLive) });
  assert.equal(coach.result, 'SENT'); assert.equal(coach.reminder.totalOutstanding, '2000.00'); assert.equal(coach.reminder.scope, `MONTH:${M0}|type:COACHING`); assert.doesNotMatch(coach.reminder.message, /Rem Regular/);
  assert.equal((await reminders.sendReminder(env, A, { memberId: kumar.id, ...q, type: 'REGULAR' }, { ...on(4), provider: okLive })).reason, 'ALREADY_REMINDED_TODAY');
  assert.equal((await reminders.previewReminder(env, A, { memberId: kumar.id, ...q, type: 'REGULAR' }, on(4))).total, '1000.00');
  assert.equal((await reminders.sendReminder(env, A, { memberId: kumar.id, ...q, courtId: c1.id }, { ...on(4), provider: okLive })).reason, 'ALREADY_REMINDED_TODAY');
  assert.equal((await reminders.previewReminder(env, A, { memberId: kumar.id, ...q, courtId: c1.id }, on(4))).total, '3000.00');
  const allScope = await reminders.sendReminder(env, A, { memberId: kumar.id, academyId: academy.id, scope: 'ALL_OUTSTANDING' }, { ...on(4), provider: okLive });
  assert.equal(allScope.reason, 'ALREADY_REMINDED_TODAY');
  const allPreview = await reminders.previewReminder(env, A, { memberId: kumar.id, academyId: academy.id, scope: 'ALL_OUTSTANDING' }, on(4));
  assert.deepEqual([allPreview.total, allPreview.items.length, allPreview.scopeKey], ['5300.00', 4, 'ALL_OUTSTANDING']);
  assert.equal((await reminders.sendReminder(env, A, { memberId: kumar.id, ...q, type: 'COACHING' }, { ...on(4), provider: okLive })).reason, 'ALREADY_REMINDED_TODAY');
  assert.equal((await reminders.listEligible(env, A, { ...q, type: 'COACHING' }, on(0))).members.find((m) => m.memberName === 'Kumar').itemCount, 1);
  assert.equal((await reminders.listEligible(env, A, { ...q, batchId: r2.id }, on(0))).members.length, 0, 'Dan (the only Court2 member) is on leave now');

  // ---- X, Y, Z, AA: bulk (day 5): groups by member, continues after failures, skips missing mobile and already-reminded
  const flaky = counting({ name: 'fake-live', async sendMessage(m) {
    if (m.to === '+919100000009') throw new Error('boom');
    if (m.to === '+919100000010') return { success: false, provider: 'fake-live', errorCode: 'BLOCKED', errorMessage: 'Recipient blocked' };
    return { success: true, provider: 'fake-live', providerMessageId: `wamid.${m.to}` };
  } });
  const moneyBeforeSends = await feeSummary();
  const bulk = await reminders.sendBulk(env, A, q, { ...on(5), provider: flaky });
  assert.deepEqual([bulk.sent, bulk.failed, bulk.missingMobile, bulk.alreadyRemindedToday, bulk.dryRun], [2, 2, 1, 0, 0]);
  assert.deepEqual([bulk.skippedPaid, bulk.skippedLeave], [2, 2], 'Priya + Tiny paid; Leena + Dan on leave');
  assert.equal(bulk.results.length, 5, 'Kumar, Anil, Raj, Sita, Missy');
  assert.equal(flaky.calls.length, 4, 'one message per member; Missy never reached the provider');
  assert.equal(new Set(flaky.calls.map((c) => c.to)).size, 4);
  const bulk2 = await reminders.sendBulk(env, A, q, { ...on(5), provider: counting(okLive) });
  assert.deepEqual([bulk2.sent, bulk2.alreadyRemindedToday, bulk2.missingMobile, bulk2.failed], [2, 2, 1, 0], 'AA: Kumar + Anil blocked; the two that failed are retried and sent');
  const cleanBulk = await reminders.sendBulk(env, A, q, { ...on(5), provider: counting(okLive) });
  assert.deepEqual([cleanBulk.sent, cleanBulk.dryRun, cleanBulk.alreadyRemindedToday], [0, 0, 4]);
  const dryBulk = await reminders.sendBulk(env, A, q, on(6));
  assert.deepEqual([dryBulk.sent, dryBulk.dryRun], [0, 4], 'real configuration: every record is DRY_RUN, none SENT');
  assert.equal((await admin.query("SELECT count(*)::int n FROM owner_fee_reminders WHERE academy_id=$1 AND status='SENT' AND provider='dry-run'", [academy.id])).rows[0].n, 0);
  assert.deepEqual(await feeSummary(), moneyBeforeSends, 'sending reminders changes no financial figure');

  // ---- AG, AH: later payments / leave never rewrite history
  const snap = async () => (await admin.query('SELECT id, status, message_body, total_outstanding::text t, item_count, sender_number, recipient_number FROM owner_fee_reminders WHERE academy_id=$1 ORDER BY id', [academy.id])).rows;
  const histBefore = await snap();
  assert.equal((await pay(kumar, '1000', await feeId(M0, 'Kumar', 'Rem Regular'))).status, 201);
  assert.equal((await api(a, 'POST', `/memberships/${danMs.id}/leaves`, { feeMonth: M1 })).status, 201);
  assert.deepEqual(await snap(), histBefore, 'old reminders are untouched by payments and leave changes');
  assert.equal((await reminders.listEligible(env, A, { ...q }, on(7))).members.find((m) => m.memberName === 'Kumar').total, '2000.00', 'future eligibility follows the new balance');

  // ---- AF: audit immutability enforced by the database
  const target = histBefore[0].id;
  for (const sql of ["UPDATE owner_fee_reminders SET message_body='tampered' WHERE id=$1", "UPDATE owner_fee_reminders SET status='SENT' WHERE id=$1", "UPDATE owner_fee_reminders SET total_outstanding=1 WHERE id=$1", 'DELETE FROM owner_fee_reminders WHERE id=$1'])
    await assert.rejects(admin.query(sql, [target]), (e) => e.code === '23000', sql);
  assert.deepEqual(await snap(), histBefore);
  const tx = await admin.connect(); // a claimed (SENDING) row may only complete; its content stays fixed
  try {
    await tx.query('BEGIN');
    await tx.query("INSERT INTO owner_fee_reminders (id, academy_id, member_id, scope_key, reminder_date, sender_number, recipient_number, message_body, total_outstanding, item_count, provider) VALUES ('11111111-1111-1111-1111-111111111111',$1,$2,'T',$3,'+91','+91','m',1,1,'x')", [academy.id, kumar.id, plusDays(20)]);
    await assert.rejects(tx.query("UPDATE owner_fee_reminders SET message_body='changed', status='SENT', sent_at=now(), completed_at=now() WHERE id='11111111-1111-1111-1111-111111111111'"), (e) => e.code === '23000');
  } finally { await tx.query('ROLLBACK'); tx.release(); }

  // ---- AB, AC: ownership
  assert.equal(await statusOf(reminders.previewReminder(env, B, { memberId: kumar.id, ...q }, on(0))), 404);
  assert.equal(await statusOf(reminders.sendReminder(env, B, { memberId: kumar.id, ...q }, { ...on(0), provider: counting(okLive) })), 404);
  assert.equal(await statusOf(reminders.listEligible(env, B, q, on(0))), 404);
  assert.equal(await statusOf(reminders.sendBulk(env, B, q, { ...on(0), provider: counting(okLive) })), 404);
  assert.deepEqual((await reminders.listReminders(env, B, {})).items, []);
  assert.deepEqual((await reminders.listReminders(env, B, { academyId: academy.id, memberId: kumar.id })).items, [], 'AC: Owner B sees none of Owner A\'s history');
  assert.equal(await statusOf(reminders.getReminder(env, B, histBefore[0].id)), 404);
  assert.equal((await reminders.listReminders(env, A, {})).items.length, histBefore.length);
  const emptyB = await reminders.listEligible(env, B, { academyId: bAcademy.id, scope: 'MONTH', feeMonth: M0 }, on(0));
  assert.deepEqual([emptyB.members, emptyB.summary.candidates], [[], 0]);

  // ---- history API shape + filters
  const hist = (await api(a, 'GET', `/reminders?academyId=${academy.id}`)).data;
  assert.deepEqual(Object.keys(hist.items[0]).sort(), ['academyId', 'attemptedAt', 'completedAt', 'delivered', 'failureCode', 'failureMessage', 'id', 'itemCount', 'memberId', 'memberName', 'message', 'provider', 'providerMessageId', 'recipient', 'reminderDate', 'scope', 'sender', 'sentAt', 'status', 'totalOutstanding']);
  assert.ok(hist.items.every((r, i, arr) => i === 0 || arr[i - 1].attemptedAt >= r.attemptedAt), 'newest first');
  for (const st of ['SENT', 'FAILED', 'DRY_RUN']) assert.ok((await api(a, 'GET', `/reminders?academyId=${academy.id}&status=${st}`)).data.items.every((r) => r.status === st) && (await api(a, 'GET', `/reminders?academyId=${academy.id}&status=${st}`)).data.items.length > 0, st);
  assert.equal((await api(a, 'GET', `/reminders?status=BOGUS`)).status, 400);
  assert.equal((await api(a, 'GET', `/reminders?memberId=${kumar.id}`)).data.items.every((r) => r.memberName === 'Kumar'), true);

  // ---- S: the sender is configuration. No sender configured = nothing is sent, nothing is recorded.
  const other = '9812345678';
  const swapped = await reminders.sendReminder({ ...env, WHATSAPP_SENDER_NUMBER: other }, A, { memberId: raj.id, ...q }, { ...on(8), provider: counting(okLive) });
  assert.equal(swapped.reminder.sender, `+91${other}`);
  const noSender = { ...env, WHATSAPP_SENDER_NUMBER: '' };
  const n0 = await historyCount();
  assert.equal(await statusOf(reminders.sendReminder(noSender, A, { memberId: raj.id, ...q }, { ...on(9), provider: counting(okLive) })), 409);
  assert.equal(await statusOf(reminders.sendBulk(noSender, A, q, { ...on(9), provider: counting(okLive) })), 409);
  assert.equal((await reminders.previewReminder(noSender, A, { memberId: raj.id, ...q }, on(9))).reason, 'SENDER_NOT_CONFIGURED');
  assert.equal(await historyCount(), n0);

  // reminders never touch money, and never touch roles / users
  assert.deepEqual((await admin.query("SELECT role FROM users WHERE id = ANY($1)", [[a.id, b.id]])).rows.map((r) => r.role), ['PLAYER', 'PLAYER']);
  assert.equal((await admin.query("SELECT count(*)::int n FROM users WHERE mobile LIKE $1", [`+91${tag}%`])).rows[0].n, 2);
  assert.ok(toCents('0.01') === 1n && statusOf);
});
