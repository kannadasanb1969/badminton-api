// Phase 8.1 local-only validation runner. Never logs credentials and never accepts a production target.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';

export async function localEnvironment() {
  const vars = Object.fromEntries((await readFile(new URL('../.dev.vars', import.meta.url), 'utf8')).split('\n')
    .filter((l) => /^\w+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const url = new URL(vars.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE);
  // q2's pooler is the same endpoint; use its direct hostname for validation connections.
  url.hostname = url.hostname.replace('-pooler.', '.');
  if (url.hostname.split('.')[0] !== 'ep-weathered-meadow-b3ot536q') throw Error('STOP: endpoint is not q2-friendly-test');
  if (vars.WHATSAPP_MODE !== 'dry-run' || vars.WHATSAPP_SENDER_NUMBER !== '9566235342') throw Error('STOP: expected Phase-8 dry-run configuration');
  return { ...vars, DB_ENV: 'test', ALLOW_DB_INTEGRATION_TESTS: 'true', DATABASE_URL_TEST: url.toString(), DATABASE_URL_DEV: url.toString() };
}
export async function safeClient(env) {
  // Check the actual connection target immediately before EVERY connection opened by this runner.
  const host = new URL(env.DATABASE_URL_TEST).hostname;
  if (host.split('.')[0] !== 'ep-weathered-meadow-b3ot536q') throw Error('STOP: wrong actual host');
  const client = new pg.Client({ connectionString: env.DATABASE_URL_TEST });
  await client.connect(); return client;
}
const hash = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export async function historySnapshot(db) {
  return (await db.query('SELECT row_to_json(r) AS row FROM owner_fee_reminders r ORDER BY id')).rows;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const action = process.argv[2];
  const env = await localEnvironment();
  console.log(JSON.stringify({ target: new URL(env.DATABASE_URL_TEST).hostname, mode: env.WHATSAPP_MODE, sender: env.WHATSAPP_SENDER_NUMBER, action }));
  if (action === 'migrate') {
    const db = await safeClient(env);
    try {
      const before = await historySnapshot(db);
      const indexes = (await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='owner_fee_reminders'")).rows;
      if (!indexes.some((r) => r.indexname === 'owner_fee_reminders_one_live_per_day_uidx' && r.indexdef.includes('scope_key'))) throw Error('Unexpected Phase-8 index: inspect before proceeding');
      await db.query(await readFile(new URL('../migrations/20261003_owner_fee_reminder_daily_guard.sql', import.meta.url), 'utf8'));
      const after = await historySnapshot(db);
      if (hash(before) !== hash(after)) throw Error('History changed during migration');
      const claims = (await db.query('SELECT academy_id,member_id,reminder_date::text,reminder_id FROM owner_fee_reminder_daily_claims ORDER BY academy_id,member_id,reminder_date')).rows;
      const evidence = { target: new URL(env.DATABASE_URL_TEST).hostname, historyBefore: before, historyAfter: after, historyHash: hash(before), historyPreserved: true, indexes, claims };
      await mkdir(new URL('../docs/validation/', import.meta.url), { recursive: true });
      await writeFile(new URL('../docs/validation/phase-8.1-migration.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
      console.log(JSON.stringify({ historyRows: before.length, historyPreserved: true, dailyClaims: claims.length }));
    } finally { await db.end(); }
  } else if (action === 'test') {
    const files = process.argv.slice(3);
    if (!files.length) throw Error('Pass explicit test paths');
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { env: { ...process.env, ...env }, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  } else throw Error('Use migrate or test');
}
