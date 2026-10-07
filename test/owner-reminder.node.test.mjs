import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { buildReminder, monthName } from '../src/services/owner-reminder-message.js';
import { reminderScope } from '../src/services/owner-reminder.service.js';
import { createWhatsAppProvider, normalizeIndianMobile, publicConfig, toE164India, whatsappConfig } from '../src/providers/whatsapp/index.js';
import { OwnerError } from '../src/services/owner.service.js';

const env = { AUTH_TOKEN_SECRET: 'unit-test-secret' };
const SENDER = '9876500001'; // arbitrary test value: the real test sender is configuration, never a constant in code

test('AD: unauthenticated reminder routes are rejected', async () => {
  for (const [method, path] of [['GET', '/api/owner/reminders'], ['GET', '/api/owner/reminders/eligible'], ['POST', '/api/owner/reminders/preview'],
    ['POST', '/api/owner/reminders/send'], ['POST', '/api/owner/reminders/send-bulk'], ['GET', '/api/owner/reminders/abc']]) {
    assert.equal((await handleOwnerRoutes(new Request(`http://x${path}`, { method }), env)).status, 401, `${method} ${path}`);
  }
});

test('AF: reminder history is an audit trail: no edit / delete routes', async () => {
  const token = await issueAccessToken(env, { id: 'u1', role: 'PLAYER' });
  for (const method of ['PATCH', 'PUT', 'DELETE']) for (const path of ['/api/owner/reminders', '/api/owner/reminders/abc', '/api/owner/reminders/send']) {
    const res = await handleOwnerRoutes(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' }), env);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
});

test('J: stored 10-digit mobiles convert to +91 only at the provider boundary; invalid numbers never convert', () => {
  assert.equal(toE164India('9876543210'), '+919876543210');
  assert.equal(toE164India('09876543210'), '+919876543210');
  assert.equal(toE164India('+91 98765-43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('919876543210'), '9876543210');
  for (const bad of [null, undefined, '', '12345', '5876543210', '98765432100', 'abcdefghij']) assert.equal(toE164India(bad), null, String(bad));
});

test('S: sender comes from configuration only; missing or invalid sender is reported, never defaulted', () => {
  assert.equal(whatsappConfig({ WHATSAPP_SENDER_NUMBER: SENDER }).senderE164, `+91${SENDER}`);
  assert.equal(whatsappConfig({ WHATSAPP_SENDER_NUMBER: '+91 98765 00001' }).senderNumber, SENDER);
  for (const c of [{}, { WHATSAPP_SENDER_NUMBER: '' }, { WHATSAPP_SENDER_NUMBER: '123' }]) {
    const cfg = whatsappConfig(c);
    assert.deepEqual([cfg.senderConfigured, cfg.senderNumber, cfg.senderE164], [false, null, null]);
  }
  assert.equal(whatsappConfig({}).mode, 'dry-run', 'safe default');
  assert.equal(whatsappConfig({ WHATSAPP_SENDER_NUMBER: SENDER }).realDelivery, false, 'no real provider exists');
  const pub = publicConfig({ WHATSAPP_MODE: 'dry-run', WHATSAPP_SENDER_NUMBER: SENDER });
  assert.deepEqual(Object.keys(pub).sort(), ['modeLabel', 'mode', 'ready', 'realDelivery', 'senderConfigured', 'senderNumber'].sort()); // Phase 8.2 added `ready`
  assert.equal(pub.mode, 'DRY_RUN');
});

test('provider adapters: dry-run accepts and delivers nothing; an unconfigured real mode fails honestly; no network is used', async () => {
  const dry = createWhatsAppProvider({ WHATSAPP_MODE: 'dry-run' });
  assert.equal(dry.name, 'dry-run');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network must not be used'); };
  try {
    const ok = await dry.sendMessage({ from: SENDER, to: '+919000011111', body: 'hello' });
    assert.deepEqual(ok, { success: true, dryRun: true, provider: 'dry-run' });
    assert.equal(ok.providerMessageId, undefined, 'no fake provider id');
    assert.equal((await dry.sendMessage({ from: '1', to: '+919000011111', body: 'x' })).errorCode, 'INVALID_SENDER');
    assert.equal((await dry.sendMessage({ from: SENDER, to: '12', body: 'x' })).errorCode, 'INVALID_RECIPIENT');
    assert.equal((await dry.sendMessage({ from: SENDER, to: '9000011111', body: '  ' })).errorCode, 'EMPTY_MESSAGE');
    const live = createWhatsAppProvider({ WHATSAPP_MODE: 'meta-cloud' });
    const r = await live.sendMessage({ from: SENDER, to: '9000011111', body: 'x' });
    assert.deepEqual([r.success, r.errorCode, r.dryRun], [false, 'PROVIDER_NOT_CONFIGURED', undefined]);
  } finally { globalThis.fetch = realFetch; }
});

test('F/G/H/AE/AJ: one consolidated message, oldest month first, exact total, partial balance only, no internal ids', () => {
  const items = [
    { feeMonth: '2026-11-01', batchName: 'Evening Coaching', balance: '1500.00' },
    { feeMonth: '2026-10-01', batchName: 'Morning Regular', balance: '800.50' }, // fee 2,500, paid 1,699.50 -> only the remaining balance is asked
    { feeMonth: '2026-11-01', batchName: 'Alpha Regular', balance: '0.10' },
  ];
  const built = buildReminder({ memberName: 'Kumar', academyName: 'Emulator Test Academy', items });
  assert.equal(built.total, '2300.60');
  assert.equal(built.itemCount, 3);
  assert.deepEqual(built.items.map((i) => i.batchName), ['Morning Regular', 'Alpha Regular', 'Evening Coaching']);
  assert.match(built.body, /^Hello Kumar,/);
  assert.match(built.body, /fee reminder from Emulator Test Academy/);
  assert.match(built.body, /October 2026 - Morning Regular - ₹800\.50/);
  assert.match(built.body, /November 2026 - Evening Coaching - ₹1,500\n/);
  assert.match(built.body, /Total Pending: ₹2,300\.60/);
  assert.doesNotMatch(built.body, /₹2,500|[0-9a-f]{8}-[0-9a-f]{4}|PENDING|PARTIALLY_PAID|ON_LEAVE|\bstatus\b|\bid:/); // case-sensitive: "Pending" is natural wording, the codes are not
  assert.equal((built.body.match(/Total Pending/g) ?? []).length, 1, 'one message, one total');
  assert.equal(buildReminder({ memberName: 'A', academyName: 'B', items: [{ feeMonth: '2026-10-01', batchName: 'X', balance: '0.30' }] }).total, '0.30');
  assert.equal(buildReminder({ memberName: 'A', academyName: 'B', items: [{ feeMonth: '2026-10-01', batchName: 'X', balance: '1250.50' }, { feeMonth: '2026-10-01', batchName: 'Y', balance: '0.10' }] }).total, '1250.60');
  assert.match(buildReminder({ memberName: 'A', academyName: 'B', items: [{ feeMonth: '2026-10-01', batchName: 'X', balance: '5' }] }).body, /Pending fee:/);
  assert.equal(monthName('2027-01-01'), 'January 2027');
});

test('scope keys preserve message coverage and filters in history', () => {
  assert.equal(reminderScope({ feeMonth: '2026-10' }).scopeKey, 'MONTH:2026-10-01');
  assert.equal(reminderScope({ scope: 'MONTH', feeMonth: '2026-10-01' }).scopeKey, 'MONTH:2026-10-01', 'same request, same key');
  assert.equal(reminderScope({ scope: 'ALL_OUTSTANDING' }).scopeKey, 'ALL_OUTSTANDING');
  assert.equal(reminderScope({ scope: 'ALL_OUTSTANDING', feeMonth: '2026-10' }).scopeKey, 'ALL_OUTSTANDING', 'a month does not change the all-outstanding scope');
  assert.equal(reminderScope({ feeMonth: '2026-10', courtId: 'c1', type: 'COACHING' }).scopeKey, 'MONTH:2026-10-01|court:c1|type:COACHING');
  assert.notEqual(reminderScope({ feeMonth: '2026-10' }).scopeKey, reminderScope({ feeMonth: '2026-11' }).scopeKey);
  assert.throws(() => reminderScope({ scope: 'EVERYTHING' }), OwnerError);
  assert.throws(() => reminderScope({ feeMonth: '2026-10-15' }), OwnerError);
  assert.throws(() => reminderScope({ type: 'MONTHLY' }), OwnerError);
});

test('T: the sender number is not hard-coded anywhere in backend source', async () => {
  const walk = async (dir) => (await readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [new URL(e.name, dir)]));
  const dirs = ['../src/providers/whatsapp/', '../src/services/', '../src/repositories/', '../src/routes/', '../src/utils/'].map((d) => new URL(d, import.meta.url));
  for (const dir of dirs) {
    for (const file of await walk(dir)) assert.doesNotMatch(await readFile(file, 'utf8'), /9566235342/, file.pathname);
  }
});

test('migration is additive: one new table, no ALTER / DROP / data change, references only owner tables and users', async () => {
  const code = (await readFile(new URL('../migrations/20261003_owner_fee_reminders.sql', import.meta.url), 'utf8')).replace(/--.*$/gm, '');
  assert.deepEqual([...code.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]), ['owner_fee_reminders']);
  assert.doesNotMatch(code, /\b(ALTER|DROP|TRUNCATE|EXTENSION)\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(code, /REFERENCES (?!owner_|users\()/);
  assert.match(code, /WHERE status IN \('SENDING', 'SENT', 'DRY_RUN'\)/, 'failed attempts do not hold the day slot');
  assert.match(code, /numeric\(10, 2\)/);
  assert.doesNotMatch(code, /\b(float|double precision|real)\b/i);
  assert.doesNotMatch(code, /token|secret|api_key|password/i, 'no provider secrets are stored');
});

test('the reminder engine does not duplicate fee maths: it reuses the Fees repository', async () => {
  const src = await readFile(new URL('../src/services/owner-reminder.service.js', import.meta.url), 'utf8');
  assert.match(src, /fees\.listFees/);
  assert.doesNotMatch(src, /owner_monthly_fees|owner_payment_allocations|SUM\(/i, 'no independent fee / balance SQL');
});
