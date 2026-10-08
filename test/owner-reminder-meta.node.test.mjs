// Phase 8.2: Meta WhatsApp Cloud API provider. Every Meta call here is MOCKED. A real network call is made nowhere in this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createWhatsAppProvider, DryRunWhatsAppProvider, MetaWhatsAppProvider, NotConfiguredWhatsAppProvider, publicConfig, toMetaRecipient, whatsappConfig } from '../src/providers/whatsapp/index.js';
import { buildTemplateParameters, cleanParameter } from '../src/providers/whatsapp/meta-template.js';
import { buildReminder } from '../src/services/owner-reminder-message.js';

const TOKEN = 'TEST_SECRET_TOKEN_VALUE_123'; // a sentinel: it only ever lives in these tests, and must never appear in any output
const META_ENV = {
  WHATSAPP_MODE: 'meta', META_WHATSAPP_ACCESS_TOKEN: TOKEN, META_WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  META_WHATSAPP_TEMPLATE_NAME: 'fee_reminder_test', META_WHATSAPP_TEMPLATE_LANGUAGE: 'en', META_WHATSAPP_GRAPH_API_VERSION: 'v21.0',
  META_WHATSAPP_BUSINESS_ACCOUNT_ID: '999888777666555', META_WHATSAPP_DISPLAY_PHONE_NUMBER: '15550001111',
};
const REMINDER = { memberName: 'Kumar', academyName: 'Emulator Test Academy', lines: ['October 2026 - Morning Regular - ₹900', 'November 2026 - Evening Coaching - ₹1,500'], total: '₹2,400' };
const send = (provider, over = {}) => provider.sendMessage({ from: '+15550001111', to: '+918939594019', body: 'plain text', reminder: REMINDER, ...over });

// a mock fetch that records every request and answers with a canned response
function mockFetch(respond) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return respond(url, init); };
  fn.calls = calls;
  return fn;
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ok = () => json(200, { messaging_product: 'whatsapp', contacts: [{ input: '918939594019', wa_id: '918939594019' }], messages: [{ id: 'wamid.HBgMOTE4OTM5NTk0MDE5FQIAERgSMDQ4' }] });

// capture anything written to the console while a test runs
async function captureConsole(fn) {
  const out = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }
  try { await fn(); } finally { for (const k of Object.keys(saved)) console[k] = saved[k]; }
  return out.join('\n');
}

test('1: the dry-run provider still works, and is still the default', async () => {
  for (const env of [{ WHATSAPP_SENDER_NUMBER: '9876500001' }, { WHATSAPP_MODE: 'dry-run', WHATSAPP_SENDER_NUMBER: '9876500001' }, { WHATSAPP_MODE: 'dry_run', WHATSAPP_SENDER_NUMBER: '9876500001' }]) {
    const p = createWhatsAppProvider(env);
    assert.ok(p instanceof DryRunWhatsAppProvider);
    assert.deepEqual(await p.sendMessage({ from: '9876500001', to: '+919000011111', body: 'hi' }), { success: true, dryRun: true, provider: 'dry-run' });
  }
  assert.equal(publicConfig({ WHATSAPP_SENDER_NUMBER: '9876500001' }).mode, 'DRY_RUN');
  assert.equal(publicConfig({ WHATSAPP_SENDER_NUMBER: '9876500001' }).realDelivery, false);
});

test('2: provider selection is configuration-driven', () => {
  assert.ok(createWhatsAppProvider(META_ENV) instanceof MetaWhatsAppProvider);
  assert.ok(createWhatsAppProvider({ WHATSAPP_MODE: 'something-else' }) instanceof NotConfiguredWhatsAppProvider);
  const pub = publicConfig(META_ENV);
  assert.deepEqual([pub.mode, pub.ready, pub.realDelivery, pub.senderNumber, pub.setupHint], ['META', true, true, '+15550001111', undefined]);
  assert.equal(whatsappConfig(META_ENV).senderE164, '+15550001111');
  // without a display number the Owner sees a neutral label and the audit identity is the phone number ID
  const noDisplay = { ...META_ENV, META_WHATSAPP_DISPLAY_PHONE_NUMBER: '' };
  assert.deepEqual([whatsappConfig(noDisplay).senderNumber, whatsappConfig(noDisplay).senderE164], ['Meta WhatsApp sender', 'meta:123456789012345']);
  // the dry-run sender variable is not mistaken for the Meta sender
  assert.equal(whatsappConfig({ ...META_ENV, WHATSAPP_SENDER_NUMBER: '9566235342' }).senderNumber, '+15550001111');
});

test('3/4/5 (+language, +version): missing or invalid settings block real sending, name the variable, and never reveal values', async () => {
  for (const name of ['META_WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_PHONE_NUMBER_ID', 'META_WHATSAPP_TEMPLATE_NAME', 'META_WHATSAPP_TEMPLATE_LANGUAGE', 'META_WHATSAPP_GRAPH_API_VERSION']) {
    const env = { ...META_ENV, [name]: '' };
    const cfg = whatsappConfig(env);
    assert.deepEqual([cfg.ready, cfg.realDelivery], [false, false], name);
    assert.match(cfg.notReadyMessage, new RegExp(`${name} \\(missing\\)`));
    assert.doesNotMatch(cfg.notReadyMessage, new RegExp(TOKEN));
    const pub = publicConfig(env);
    assert.deepEqual([pub.mode, pub.ready], ['UNAVAILABLE', false]);
    assert.match(pub.setupHint, new RegExp(name));
    const fetch = mockFetch(ok);
    const p = new MetaWhatsAppProvider(env, { fetch });
    assert.deepEqual(p.missing, [name]);
    const r = await send(p);
    assert.deepEqual([r.success, r.errorCode, fetch.calls.length], [false, 'META_NOT_CONFIGURED', 0], 'no request is made when not configured');
  }
  const bad = whatsappConfig({ ...META_ENV, META_WHATSAPP_GRAPH_API_VERSION: '21', META_WHATSAPP_PHONE_NUMBER_ID: 'abc' });
  assert.equal(bad.ready, false);
  assert.match(bad.notReadyMessage, /META_WHATSAPP_GRAPH_API_VERSION \(invalid format\)/);
  assert.doesNotMatch(bad.notReadyMessage, /abc|\b21\b/, 'invalid values are not echoed');
  assert.equal(whatsappConfig({ WHATSAPP_MODE: 'meta' }).ready, false);
});

test('6/7/8: recipient normalization: Indian local, already international, invalid', () => {
  assert.equal(toMetaRecipient('8939594019'), '918939594019');
  assert.equal(toMetaRecipient('+918939594019'), '918939594019');
  assert.equal(toMetaRecipient('918939594019'), '918939594019');
  assert.equal(toMetaRecipient('08939594019'), '918939594019');
  assert.equal(toMetaRecipient('+91 89395-94019'), '918939594019');
  assert.equal(toMetaRecipient('+14155550123'), '14155550123', 'an explicit international number is kept, not prefixed with 91');
  assert.equal(toMetaRecipient('+447911123456'), '447911123456');
  for (const bad of [null, undefined, '', '  ', '12345', '5939594019', '89395940', '893959401912', '14155550123', 'abc', '+91 12345', '+0123456789', '8939594019x', '+', '++918939594019']) assert.equal(toMetaRecipient(bad), null, String(bad));
});

test('9: a mocked successful response captures the real message id; the request is a template message with the right shape', async () => {
  const fetch = mockFetch(ok);
  const p = new MetaWhatsAppProvider(META_ENV, { fetch });
  const r = await send(p);
  assert.deepEqual(r, { success: true, provider: 'meta', providerMessageId: 'wamid.HBgMOTE4OTM5NTk0MDE5FQIAERgSMDQ4' });
  assert.equal(r.dryRun, undefined, 'a real send is never flagged as a dry run');
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://graph.facebook.com/v21.0/123456789012345/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.ok(init.signal, 'a timeout signal is attached');
  const body = JSON.parse(init.body);
  assert.deepEqual(body, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '918939594019', type: 'template',
    template: { name: 'fee_reminder_test', language: { code: 'en' }, components: [{ type: 'body', parameters: [
      { type: 'text', text: 'Kumar' }, { type: 'text', text: 'Emulator Test Academy' },
      { type: 'text', text: 'October 2026 - Morning Regular - ₹900; November 2026 - Evening Coaching - ₹1,500' }, { type: 'text', text: '₹2,400' }] }] },
  });
  assert.doesNotMatch(init.body, new RegExp(TOKEN), 'the token is only in the header, never in the payload');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(TOKEN));
});

test('configuration values are used, not constants: another phone id / version / template / language changes the request', async () => {
  const fetch = mockFetch(ok);
  await send(new MetaWhatsAppProvider({ ...META_ENV, META_WHATSAPP_PHONE_NUMBER_ID: '55555555555', META_WHATSAPP_GRAPH_API_VERSION: 'v99.1', META_WHATSAPP_TEMPLATE_NAME: 'other_tpl', META_WHATSAPP_TEMPLATE_LANGUAGE: 'en_US' }, { fetch }));
  assert.equal(fetch.calls[0].url, 'https://graph.facebook.com/v99.1/55555555555/messages');
  const t = JSON.parse(fetch.calls[0].init.body).template;
  assert.deepEqual([t.name, t.language.code], ['other_tpl', 'en_US']);
});

test('invalid recipient is rejected before any request; missing reminder data likewise', async () => {
  const fetch = mockFetch(ok);
  const p = new MetaWhatsAppProvider(META_ENV, { fetch });
  assert.equal((await send(p, { to: '12345' })).errorCode, 'INVALID_RECIPIENT');
  assert.equal((await send(p, { to: null })).errorCode, 'INVALID_RECIPIENT');
  assert.equal((await send(p, { reminder: undefined })).errorCode, 'META_TEMPLATE_DATA_MISSING');
  assert.equal((await send(p, { reminder: { ...REMINDER, lines: [] } })).errorCode, 'META_TEMPLATE_DATA_MISSING');
  assert.equal((await send(p, { reminder: { ...REMINDER, memberName: '  ' } })).errorCode, 'META_TEMPLATE_DATA_MISSING');
  assert.equal(fetch.calls.length, 0);
});

test('10-14: Meta failures map to safe results and are never reported as sent', async () => {
  const cases = [
    ['400 bad request', json(400, { error: { message: 'Param error', type: 'OAuthException', code: 100 } }), 'META_REQUEST_REJECTED'],
    ['400 recipient not in test list', json(400, { error: { message: '(#131030) Recipient phone number not in allowed list', code: 131030 } }), 'META_RECIPIENT_NOT_ALLOWED'],
    ['400 template missing', json(404, { error: { message: 'Template name does not exist', code: 132001 } }), 'META_TEMPLATE_NOT_FOUND'],
    ['400 template params', json(400, { error: { message: 'Number of parameters does not match', code: 132000 } }), 'META_TEMPLATE_PARAMS'],
    ['400 unreachable', json(400, { error: { message: 'Message undeliverable', code: 131026 } }), 'META_RECIPIENT_UNREACHABLE'],
    ['401 auth', json(401, { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } }), 'META_AUTH_FAILED'],
    ['403 auth', json(403, { error: { message: 'Forbidden', code: 3 } }), 'META_AUTH_FAILED'],
    ['429', json(429, { error: { message: 'Too many requests', code: 4 } }), 'META_RATE_LIMITED'],
    ['429 no body', json(429, ''), 'META_RATE_LIMITED'],
    ['130429 throughput', json(400, { error: { message: 'Rate limit hit', code: 130429 } }), 'META_RATE_LIMITED'],
    ['500', json(500, { error: { message: 'Internal', code: 2 } }), 'META_SERVER_ERROR'],
    ['503 html', json(503, '<html>Service Unavailable</html>'), 'META_SERVER_ERROR'],
    ['200 not json', json(200, 'OK'), 'META_MALFORMED_RESPONSE'],
    ['200 empty', json(200, ''), 'META_MALFORMED_RESPONSE'],
    ['200 no messages', json(200, { messaging_product: 'whatsapp', contacts: [] }), 'META_MALFORMED_RESPONSE'],
    ['200 blank id', json(200, { messages: [{ id: '  ' }] }), 'META_MALFORMED_RESPONSE'],
    ['200 id wrong type', json(200, { messages: [{ id: 12345 }] }), 'META_MALFORMED_RESPONSE'],
    ['200 array body', json(200, [1, 2]), 'META_MALFORMED_RESPONSE'],
    ['400 not json', json(400, 'Bad Request'), 'META_MALFORMED_RESPONSE'],
  ];
  for (const [label, response, code] of cases) {
    const r = await send(new MetaWhatsAppProvider(META_ENV, { fetch: mockFetch(() => response) }));
    assert.deepEqual([r.success, r.errorCode], [false, code], label);
    assert.equal(r.providerMessageId, undefined, `${label}: no id on failure`);
    assert.equal(r.dryRun, undefined);
    assert.ok(r.errorMessage && r.errorMessage.length < 400, label);
  }
  assert.equal((await send(new MetaWhatsAppProvider(META_ENV, { fetch: mockFetch(() => json(429, '')) }))).retryable, true);
  assert.equal((await send(new MetaWhatsAppProvider(META_ENV, { fetch: mockFetch(() => json(500, '')) }))).retryable, true);
  assert.equal((await send(new MetaWhatsAppProvider(META_ENV, { fetch: mockFetch(() => json(401, '')) }))).retryable, false);
});

test('14: network failure and timeout', async () => {
  const net = await send(new MetaWhatsAppProvider(META_ENV, { fetch: async () => { throw new TypeError('fetch failed: ECONNRESET'); } }));
  assert.deepEqual([net.success, net.errorCode, net.retryable], [false, 'META_NETWORK_ERROR', true]);
  const abort = await send(new MetaWhatsAppProvider(META_ENV, { fetch: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } }));
  assert.equal(abort.errorCode, 'META_TIMEOUT');
  // a request that never answers is cut off by the timeout instead of hanging the reminder
  const hanging = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
  const started = Date.now();
  const slow = await send(new MetaWhatsAppProvider(META_ENV, { fetch: hanging, timeoutMs: 40 }));
  assert.equal(slow.errorCode, 'META_TIMEOUT');
  assert.ok(Date.now() - started < 2000);
});

test('15: no secret leakage: not in results, not in console output, not in echoed Meta errors, not in public config', async () => {
  const echoes = [
    json(401, { error: { message: `Invalid OAuth access token - ${TOKEN}`, code: 190 } }),
    json(400, { error: { message: `Bad request. Authorization: Bearer ${TOKEN} was used`, code: 100 } }),
    json(400, { error: { message: 'token EAAGm0PX4ZCpsBAKZCtoKenLeakCheck1234567890abcdefXYZ is bad', code: 100 } }),
    json(500, `<html>${TOKEN}</html>`),
    json(200, { messages: [{ id: 'wamid.OK' }], debug: TOKEN }),
  ];
  const outputs = [];
  const log = await captureConsole(async () => {
    for (const response of echoes) outputs.push(JSON.stringify(await send(new MetaWhatsAppProvider(META_ENV, { fetch: mockFetch(() => response) }))));
    outputs.push(JSON.stringify(await send(new MetaWhatsAppProvider(META_ENV, { fetch: async () => { throw new Error(`socket error for ${TOKEN}`); } }))));
    outputs.push(JSON.stringify(await send(new MetaWhatsAppProvider({ ...META_ENV, META_WHATSAPP_PHONE_NUMBER_ID: '' }))));
    outputs.push(JSON.stringify(publicConfig(META_ENV)), JSON.stringify(whatsappConfig(META_ENV).notReadyMessage), JSON.stringify(publicConfig({ ...META_ENV, META_WHATSAPP_TEMPLATE_NAME: '' })));
  });
  for (const out of outputs) {
    assert.doesNotMatch(out, new RegExp(TOKEN), out);
    assert.doesNotMatch(out, /EAAGm0PX4ZCpsBAK/, out);
    assert.doesNotMatch(out, /Bearer\s+(?!\[redacted\])\S{6,}/i, out);
  }
  assert.equal(log, '', 'the provider writes nothing to the console');
  // the provider object itself does not expose the token
  const p = new MetaWhatsAppProvider(META_ENV);
  assert.doesNotMatch(JSON.stringify(p) + Object.keys(p).join() + Object.getOwnPropertyNames(p).join(), new RegExp(TOKEN));
  assert.equal(String(p.token), 'undefined');
});

test('15b: source hygiene: no console output, no hard-coded credentials, sender, recipient or Meta ids in the backend source', async () => {
  const dirs = ['../src/providers/whatsapp/', '../src/services/', '../src/repositories/', '../src/routes/', '../src/utils/'].map((d) => new URL(d, import.meta.url));
  for (const dir of dirs) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) continue;
      const src = await readFile(new URL(e.name, dir), 'utf8');
      assert.doesNotMatch(src, /8939594019|9566235342|\bEA[A-Za-z0-9]{20,}\b/, e.name);
    }
  }
  for (const f of ['meta.js', 'config.js', 'meta-template.js', 'index.js']) {
    const src = await readFile(new URL(`../src/providers/whatsapp/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /console\./, `${f} must not log`);
  }
  const meta = await readFile(new URL('../src/providers/whatsapp/meta.js', import.meta.url), 'utf8');
  assert.doesNotMatch(meta, /graph\.facebook\.com\/v\d/, 'the Graph API version is configuration');
  assert.match(meta, /graph\.facebook\.com\/\$\{graphVersion\}\/\$\{phoneNumberId\}\/messages/);
});

test('template parameters: four single-line variables, exact total, long lists are shortened but the total is never changed', () => {
  assert.deepEqual(buildTemplateParameters(REMINDER), ['Kumar', 'Emulator Test Academy', 'October 2026 - Morning Regular - ₹900; November 2026 - Evening Coaching - ₹1,500', '₹2,400']);
  assert.equal(cleanParameter('a\n\nb\tc     d'), 'a b c d');
  const dirty = buildTemplateParameters({ ...REMINDER, memberName: 'Ku\nmar', lines: ['A\n   B   -  ₹1'] });
  assert.ok(dirty.every((p) => !/[\n\r\t]| {2,}/.test(p)));
  const many = Array.from({ length: 60 }, (_, i) => `Month ${i + 1} 2026 - Some Long Batch Name - ₹1,000`);
  const long = buildTemplateParameters({ ...REMINDER, lines: many, total: '₹60,000' });
  assert.ok(long[2].length <= 640);
  assert.match(long[2], / and \d+ more$/);
  assert.equal(long[3], '₹60,000');
  const shownLines = long[2].replace(/ and \d+ more$/, '').split('; ').length;
  assert.equal(Number(long[2].match(/and (\d+) more$/)[1]), 60 - shownLines, 'the "and N more" count is exact');
  assert.equal(buildTemplateParameters(null), null);
  assert.equal(buildTemplateParameters({ ...REMINDER, total: '' }), null);
});

test('19: the engine hands the provider ONE consolidated reminder whose structured fields match the plain-text message', () => {
  const built = buildReminder({ memberName: 'Kumar', academyName: 'Emulator Test Academy', items: [
    { feeMonth: '2026-11-01', batchName: 'Evening Coaching', balance: '1500.00' }, { feeMonth: '2026-10-01', batchName: 'Morning Regular', balance: '900.00' }] });
  assert.deepEqual(built.fields, { memberName: 'Kumar', academyName: 'Emulator Test Academy', lines: ['October 2026 - Morning Regular - ₹900', 'November 2026 - Evening Coaching - ₹1,500'], total: '₹2,400' });
  for (const line of built.fields.lines) assert.ok(built.body.includes(line));
  assert.ok(built.body.includes(`Total Pending: ${built.fields.total}`));
});
