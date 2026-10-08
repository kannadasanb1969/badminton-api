// Phase 8.2: the Meta provider through the REAL reminder engine, REAL Phase 8.1 daily guard and the q2-friendly-test database.
// Only the outbound HTTP call to Meta is mocked (globalThis.fetch). No real WhatsApp message is ever sent from this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { currentMonthIST, todayIST } from '../src/utils/owner-dates.js';
import * as reminders from '../src/services/owner-reminder.service.js';
import { OwnerError } from '../src/services/owner.service.js';

const REQUIRED_ENDPOINT = 'ep-weathered-meadow-b3ot536q';
let enabled = true;
let config;
try { config = getSafeDatabaseConfig(); } catch { enabled = false; }
if (enabled && !new URL(config.connectionString).hostname.startsWith(REQUIRED_ENDPOINT)) throw new Error('Refusing: database endpoint is not the verified q2-friendly-test endpoint');
const skip = !enabled && 'set DB_ENV, ALLOW_DB_INTEGRATION_TESTS and DATABASE_URL_DEV';

const TOKEN = 'TEST_SECRET_TOKEN_VALUE_123'; // sentinel: must never appear in any response, history row or log
const base = enabled ? {
  AUTH_TOKEN_SECRET: 'integration-secret',
  HYPERDRIVE: { connectionString: config.connectionString },
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.connectionString,
} : {};
const metaEnv = { ...base, WHATSAPP_MODE: 'meta', META_WHATSAPP_ACCESS_TOKEN: TOKEN, META_WHATSAPP_PHONE_NUMBER_ID: '123456789012345', META_WHATSAPP_TEMPLATE_NAME: 'fee_reminder_test',
  META_WHATSAPP_TEMPLATE_LANGUAGE: 'en', META_WHATSAPP_GRAPH_API_VERSION: 'v21.0', META_WHATSAPP_DISPLAY_PHONE_NUMBER: '15550001111' };
const dryEnv = { ...base, WHATSAPP_MODE: 'dry-run', WHATSAPP_SENDER_NUMBER: '9876500001' };
const tag = String(Math.floor(Math.random() * 9e7) + 1e7);
const users = {};
let admin;

const M0 = currentMonthIST();
const shift = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10); };
const day = (m, n) => `${m.slice(0, 8)}${String(n).padStart(2, '0')}`;
const plusDays = (n) => new Date(new Date(`${todayIST()}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);
const on = (n) => ({ today: () => plusDays(n) });
const idOf = (u) => ({ sub: u.id, role: u.role });
const statusOf = async (p) => { try { await p; return 200; } catch (e) { if (e instanceof OwnerError) return e.status; throw e; } };

// ---- the mocked Meta endpoint -----------------------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const meta = { calls: [], handler: null, delayMs: 0 };
const ok = (id) => ({ ok: true, status: 200, text: async () => JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ wa_id: 'x' }], messages: [{ id }] }) });
const err = (status, code, message = 'error') => ({ ok: false, status, text: async () => JSON.stringify({ error: { message, code } }) });
function installMeta(handler) {
  meta.calls = []; meta.handler = handler;
  globalThis.fetch = async (url, init) => {
    // Hard guard: only a Graph API messages URL for the configured phone number id is acceptable, and only ever the mock answers.
    assert.match(String(url), /^https:\/\/graph\.facebook\.com\/v21\.0\/123456789012345\/messages$/, 'unexpected outbound URL');
    const body = JSON.parse(init.body);
    meta.calls.push({ to: body.to, params: body.template.components[0].parameters.map((p) => p.text), template: body.template.name, auth: init.headers.Authorization });
    if (meta.delayMs) await new Promise((r) => setTimeout(r, meta.delayMs));
    return meta.handler(body, meta.calls.length);
  };
}

async function api(user, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (user) headers.authorization = `Bearer ${await issueAccessToken(base, user)}`;
  const res = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), base);
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
  globalThis.fetch = realFetch;
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
      `DELETE FROM owner_fee_reminder_daily_claims WHERE academy_id IN ${academies}`, `DELETE FROM owner_fee_reminders WHERE academy_id IN ${academies}`,
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

test('Meta provider through the real reminder engine (Meta HTTP mocked)', { skip }, async () => {
  const { a } = users;
  const A = idOf(a);
  await api(a, 'POST', '/profile');
  const academy = (await api(a, 'POST', '/academies', { name: 'Meta Reminder Academy' })).data;
  const court = (await api(a, 'POST', `/academies/${academy.id}/courts`, { name: 'MC1' })).data;
  const batch = async (type, name, fee, s, e) => (await api(a, 'POST', '/batches', { academyId: academy.id, courtId: court.id, type, name, startTime: s, endTime: e, feePerPerson: fee })).data;
  const reg = await batch('REGULAR', 'Meta Regular', '1000', '06:00', '07:00');
  const coach = await batch('COACHING', 'Meta Coaching', '2000', '18:00', '19:00');
  const member = async (name, mobile) => (await api(a, 'POST', '/members', { academyId: academy.id, name, ...(mobile ? { mobile } : {}) })).data;
  const join = async (m, bt) => { const r = await api(a, 'POST', `/members/${m.id}/memberships`, { batchId: bt.id, startDate: M0 }); assert.equal(r.status, 201, JSON.stringify(r)); return r.data; };
  const [kumar, anil, priya, leena, dan, raj, sita] = [await member('Kumar', '8939594019'), await member('Anil', '9100000002'), await member('Priya', '9100000003'),
    await member('Leena', '9100000004'), await member('Dan', '9100000006'), await member('Raj', '9100000009'), await member('Sita', '9100000010')];
  const missy = await member('Missy');
  await join(kumar, reg); await join(kumar, coach); await join(anil, reg); await join(priya, coach); const leenaMs = await join(leena, reg);
  await join(dan, reg); await join(raj, reg); await join(sita, reg); await join(missy, reg);
  assert.equal((await api(a, 'POST', `/memberships/${leenaMs.id}/leaves`, { feeMonth: M0 })).status, 201);
  assert.equal((await api(a, 'POST', '/monthly-fees/generate', { academyId: academy.id, feeMonth: M0 })).status, 200);
  const feeId = async (who, batchName) => (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}`)).data.items.find((i) => i.memberName === who && i.batchName === batchName).id;
  const pay = (m, amount, fid) => api(a, 'POST', '/payments', { memberId: m.id, amount, paymentMode: 'CASH', paymentDate: todayIST(), allocationMode: 'MANUAL', allocations: [{ monthlyFeeId: fid, amount }] });
  assert.equal((await pay(anil, '400', await feeId('Anil', 'Meta Regular'))).status, 201); // 1000 - 400 = 600 left
  assert.equal((await pay(priya, '2000', await feeId('Priya', 'Meta Coaching'))).status, 201);

  const q = { academyId: academy.id, scope: 'MONTH', feeMonth: M0 };
  const summary = async () => (await api(a, 'GET', `/monthly-fees?academyId=${academy.id}&feeMonth=${M0}`)).data.summary;
  const moneyRows = async () => (await admin.query(`SELECT (SELECT count(*)::int FROM owner_payments WHERE academy_id=$1) p, (SELECT count(*)::int FROM owner_payment_allocations al JOIN owner_payments p ON p.id=al.payment_id WHERE p.academy_id=$1) a,
    (SELECT COALESCE(SUM(f.applicable_fee),0)::text FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id WHERE m.academy_id=$1) fees`, [academy.id])).rows[0];
  const money0 = { summary: await summary(), rows: await moneyRows() };
  const histCount = async () => (await admin.query('SELECT count(*)::int n FROM owner_fee_reminders WHERE academy_id=$1', [academy.id])).rows[0].n;
  const rowsFor = async (m) => (await admin.query('SELECT * FROM owner_fee_reminders WHERE member_id=$1 ORDER BY created_at, id', [m.id])).rows;
  const liveFor = async (m, date) => (await admin.query("SELECT count(*)::int n FROM owner_fee_reminders WHERE member_id=$1 AND reminder_date=$2 AND status IN ('SENDING','SENT','DRY_RUN')", [m.id, date])).rows[0].n;
  const outputs = [];

  // ---- not fully configured: nothing is claimed, recorded or sent
  installMeta(() => { throw new Error('must not be called'); });
  const unready = { ...metaEnv, META_WHATSAPP_ACCESS_TOKEN: '' };
  const e1 = await reminders.sendReminder(unready, A, { memberId: kumar.id, ...q }, on(0)).catch((e) => e);
  assert.equal(e1.status, 409); assert.match(e1.message, /META_WHATSAPP_ACCESS_TOKEN \(missing\)/); assert.doesNotMatch(e1.message, new RegExp(TOKEN));
  assert.equal(await statusOf(reminders.sendBulk({ ...metaEnv, META_WHATSAPP_TEMPLATE_NAME: '' }, A, q, on(0))), 409);
  const pvUnready = await reminders.previewReminder(unready, A, { memberId: kumar.id, ...q }, on(0));
  assert.deepEqual([pvUnready.eligible, pvUnready.reason, pvUnready.config.mode, pvUnready.config.ready], [false, 'SENDER_NOT_CONFIGURED', 'UNAVAILABLE', false]);
  assert.deepEqual([meta.calls.length, await histCount()], [0, 0]);

  // ---- 19 + success: one consolidated WhatsApp reminder for two dues; SENT with the real (mock) message id
  installMeta(() => ok('wamid.KUMAR1'));
  const pv = await reminders.previewReminder(metaEnv, A, { memberId: kumar.id, ...q }, on(0));
  assert.deepEqual([pv.eligible, pv.config.mode, pv.config.realDelivery, pv.sender, pv.recipient, pv.total], [true, 'META', true, '+15550001111', '8939594019', '3000.00']);
  assert.equal(meta.calls.length, 0, 'preview never calls Meta');
  const k = await reminders.sendReminder(metaEnv, A, { memberId: kumar.id, ...q }, on(0));
  outputs.push(JSON.stringify(k));
  assert.deepEqual([k.result, k.reminder.status, k.reminder.delivered, k.reminder.provider, k.reminder.providerMessageId], ['SENT', 'SENT', true, 'meta', 'wamid.KUMAR1']);
  assert.equal(meta.calls.length, 1, 'ONE WhatsApp message for two dues');
  assert.deepEqual([meta.calls[0].to, meta.calls[0].template, meta.calls[0].auth], ['918939594019', 'fee_reminder_test', `Bearer ${TOKEN}`]);
  assert.equal(meta.calls[0].params.length, 4, 'the template has four variables');
  assert.deepEqual([meta.calls[0].params[0], meta.calls[0].params[1]], ['Kumar', 'Meta Reminder Academy']);
  assert.match(meta.calls[0].params[2], /Meta Coaching - ₹2,000; .*Meta Regular - ₹1,000|Meta Regular - ₹1,000; .*Meta Coaching - ₹2,000/, 'both dues in the one item line');
  assert.ok(meta.calls[0].params.every((x) => !/[\n\r\t]/.test(x)), 'no newlines inside template variables');
  assert.equal(meta.calls[0].params[3], '₹3,000');
  const row = (await rowsFor(kumar))[0];
  assert.deepEqual([row.status, row.provider, row.provider_message_id, row.sender_number, row.recipient_number, row.total_outstanding, row.item_count, row.scope_key, row.failure_code],
    ['SENT', 'meta', 'wamid.KUMAR1', '+15550001111', '+918939594019', '3000.00', 2, `MONTH:${M0}`, null]);
  assert.ok(row.sent_at && row.completed_at);
  assert.doesNotMatch(JSON.stringify(row), new RegExp(TOKEN), 'the token is never stored');

  // ---- 17: the daily guard still holds: same day, same or different scope -> no second Meta call, no second live row
  const again = await reminders.sendReminder(metaEnv, A, { memberId: kumar.id, ...q }, on(0));
  const otherScope = await reminders.sendReminder(metaEnv, A, { memberId: kumar.id, academyId: academy.id, scope: 'ALL_OUTSTANDING' }, on(0));
  const otherType = await reminders.sendReminder(metaEnv, A, { memberId: kumar.id, ...q, type: 'COACHING' }, on(0));
  for (const r of [again, otherScope, otherType]) assert.deepEqual([r.result, r.reason], ['SKIPPED', 'ALREADY_REMINDED_TODAY']);
  assert.deepEqual([meta.calls.length, (await rowsFor(kumar)).length, await liveFor(kumar, plusDays(0))], [1, 1, 1]);
  const next = await reminders.sendReminder(metaEnv, A, { memberId: kumar.id, ...q }, on(1));
  assert.equal(next.result, 'SENT', 'a new local day is a new day'); assert.equal(meta.calls.length, 2);

  // ---- 22 partial payment asks only for the remaining balance; 20/21 paid and on-leave are never sent
  installMeta(() => ok('wamid.ANIL1'));
  const an = await reminders.sendReminder(metaEnv, A, { memberId: anil.id, ...q }, on(0));
  assert.equal(an.result, 'SENT');
  assert.match(meta.calls[0].params[2], /₹600$/); assert.doesNotMatch(meta.calls[0].params[2], /₹1,000/); assert.equal(meta.calls[0].params[3], '₹600');
  assert.equal(an.reminder.totalOutstanding, '600.00');
  for (const [m, reason] of [[priya, 'PAID'], [leena, 'ON_LEAVE']]) {
    assert.equal((await reminders.previewReminder(metaEnv, A, { memberId: m.id, ...q }, on(0))).reason, reason);
    const r = await reminders.sendReminder(metaEnv, A, { memberId: m.id, ...q }, on(0));
    assert.deepEqual([r.result, r.reason], ['SKIPPED', reason]);
  }
  assert.equal(meta.calls.length, 1, 'no Meta call for paid / on-leave members');
  const mm = await reminders.sendReminder(metaEnv, A, { memberId: missy.id, ...q }, on(0));
  assert.deepEqual([mm.result, mm.reason, meta.calls.length], ['SKIPPED', 'MISSING_MOBILE', 1]);

  // ---- 16: failures are FAILED (never SENT), keep the real reason, never block the day, and a retry can succeed
  const attempts = [() => err(429, 4, 'Too many'), () => err(401, 190, `Invalid token ${TOKEN}`), () => err(500, 2, 'boom'), () => ok('wamid.DAN1')];
  installMeta((body, n) => attempts[n - 1]());
  const dan1 = await reminders.sendReminder(metaEnv, A, { memberId: dan.id, ...q }, on(2));
  const dan2 = await reminders.sendReminder(metaEnv, A, { memberId: dan.id, ...q }, on(2));
  const dan3 = await reminders.sendReminder(metaEnv, A, { memberId: dan.id, ...q }, on(2));
  outputs.push(JSON.stringify([dan1, dan2, dan3]));
  assert.deepEqual([dan1.result, dan1.reminder.failureCode, dan1.reminder.delivered, dan1.reminder.providerMessageId], ['FAILED', 'META_RATE_LIMITED', false, null]);
  assert.deepEqual([dan2.result, dan2.reminder.failureCode], ['FAILED', 'META_AUTH_FAILED']);
  assert.deepEqual([dan3.result, dan3.reminder.failureCode], ['FAILED', 'META_SERVER_ERROR']);
  assert.equal(await liveFor(dan, plusDays(2)), 0, 'failed attempts hold no slot');
  const dan4 = await reminders.sendReminder(metaEnv, A, { memberId: dan.id, ...q }, on(2));
  assert.deepEqual([dan4.result, dan4.reminder.providerMessageId], ['SENT', 'wamid.DAN1']);
  assert.equal(meta.calls.length, 4);
  assert.equal(await liveFor(dan, plusDays(2)), 1);
  const danRows = await rowsFor(dan);
  assert.deepEqual(danRows.map((r) => r.status), ['FAILED', 'FAILED', 'FAILED', 'SENT']);
  assert.ok(danRows.slice(0, 3).every((r) => r.sent_at === null && r.provider_message_id === null && r.failure_code && r.failure_message));
  assert.doesNotMatch(JSON.stringify(danRows), new RegExp(TOKEN), 'an error that echoed the token was redacted before it was stored');
  assert.equal((await reminders.sendReminder(metaEnv, A, { memberId: dan.id, ...q }, on(2))).reason, 'ALREADY_REMINDED_TODAY');
  assert.equal(meta.calls.length, 4);

  // ---- network failure / malformed answer are FAILED too
  installMeta(() => { throw new TypeError('fetch failed'); });
  const net = await reminders.sendReminder(metaEnv, A, { memberId: sita.id, ...q }, on(3));
  assert.deepEqual([net.result, net.reminder.failureCode], ['FAILED', 'META_NETWORK_ERROR']);
  installMeta(() => ({ ok: true, status: 200, text: async () => '{"messages":[]}' }));
  const bad = await reminders.sendReminder(metaEnv, A, { memberId: sita.id, ...q }, on(3));
  assert.deepEqual([bad.result, bad.reminder.failureCode, bad.reminder.delivered], ['FAILED', 'META_MALFORMED_RESPONSE', false]);
  installMeta(() => ok('wamid.SITA1'));
  assert.equal((await reminders.sendReminder(metaEnv, A, { memberId: sita.id, ...q }, on(3))).result, 'SENT');

  // ---- 18: six concurrent sends -> at most ONE Meta call and ONE live reminder
  installMeta(() => ok('wamid.RAJ1'));
  meta.delayMs = 60;
  const race = await Promise.all(Array.from({ length: 6 }, () => reminders.sendReminder(metaEnv, A, { memberId: raj.id, ...q }, on(4))));
  meta.delayMs = 0;
  assert.deepEqual([race.filter((r) => r.result === 'SENT').length, race.filter((r) => r.reason === 'ALREADY_REMINDED_TODAY').length], [1, 5]);
  assert.equal(meta.calls.length, 1, 'exactly one provider call');
  assert.equal(await liveFor(raj, plusDays(4)), 1);
  assert.equal((await rowsFor(raj)).length, 1, 'and exactly one history row');
  // concurrency across different scopes on the same day is guarded too
  installMeta(() => ok('wamid.ANIL2'));
  const mixed = await Promise.all([{ ...q }, { academyId: academy.id, scope: 'ALL_OUTSTANDING' }, { ...q, type: 'REGULAR' }, { ...q, courtId: court.id }].map((s) => reminders.sendReminder(metaEnv, A, { memberId: anil.id, ...s }, on(5))));
  assert.deepEqual([mixed.filter((r) => r.result === 'SENT').length, meta.calls.length, await liveFor(anil, plusDays(5))], [1, 1, 1]);

  // ---- bulk through Meta: one message per member, failures isolated, retry later the same day
  installMeta((body) => (body.to === '919100000009' ? err(503, 2, 'down') : ok(`wamid.${body.to}`)));
  const bulk = await reminders.sendBulk(metaEnv, A, q, on(6));
  outputs.push(JSON.stringify(bulk));
  assert.deepEqual([bulk.sent, bulk.failed, bulk.missingMobile, bulk.skippedPaid, bulk.skippedLeave, bulk.alreadyRemindedToday], [4, 1, 1, 1, 1, 0]);
  assert.equal(meta.calls.length, 5, 'one message per member with a mobile and a balance');
  assert.equal(new Set(meta.calls.map((c) => c.to)).size, 5);
  installMeta((body) => ok(`wamid.RETRY${body.to}`));
  const bulk2 = await reminders.sendBulk(metaEnv, A, q, on(6));
  assert.deepEqual([bulk2.sent, bulk2.alreadyRemindedToday, meta.calls.length], [1, 4, 1], 'only the failed member is retried');

  // ---- 1: dry-run mode is untouched and never calls Meta
  installMeta(() => { throw new Error('dry run must not call Meta'); });
  const dry = await reminders.sendReminder(dryEnv, A, { memberId: dan.id, ...q }, on(7));
  assert.deepEqual([dry.result, dry.reminder.provider, dry.reminder.delivered, dry.reminder.providerMessageId], ['DRY_RUN', 'dry-run', false, null]);
  assert.equal(meta.calls.length, 0);

  // ---- money is untouched by any provider outcome; nothing leaks the token anywhere
  assert.deepEqual({ summary: await summary(), rows: await moneyRows() }, money0, 'WhatsApp success and failure never change a financial record');
  const hist = await reminders.listReminders(metaEnv, A, { academyId: academy.id });
  outputs.push(JSON.stringify(hist));
  const everything = (await admin.query("SELECT row_to_json(r)::text t FROM owner_fee_reminders r WHERE academy_id=$1", [academy.id])).rows.map((x) => x.t).join('\n');
  for (const out of [...outputs, everything]) { assert.doesNotMatch(out, new RegExp(TOKEN)); assert.doesNotMatch(out, /Bearer\s+\S/i); }
  assert.ok(hist.items.some((r) => r.provider === 'meta' && r.status === 'SENT' && r.providerMessageId));
  assert.ok(hist.items.every((r) => r.status !== 'SENT' || (r.provider === 'meta' && r.providerMessageId)), 'every SENT row here came from Meta with a real id');
  assert.deepEqual(hist.config, { mode: 'META', modeLabel: 'Live WhatsApp via Meta: messages are sent as an approved template', senderNumber: '+15550001111', senderConfigured: true, ready: true, realDelivery: true });
  assert.deepEqual((await admin.query("SELECT role FROM users WHERE id=$1", [a.id])).rows.map((r) => r.role), ['PLAYER']);
});
