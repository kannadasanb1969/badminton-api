import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { DATABASE_MODE } from '../dbConfig.js';

// Refuses to run unless the repo's own LOCAL/PRODUCTION selector is set to LOCAL — this is a
// belt-and-braces guard on top of using the .dev.vars local Hyperdrive override below, so this
// script can never be accidentally pointed at production by a stale DATABASE_MODE.
if (DATABASE_MODE !== 'LOCAL') {
  throw new Error('Refusing to run migration: dbConfig.js DATABASE_MODE must be LOCAL');
}

const devVars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const match = devVars.match(/^CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE\s*=\s*"?([^"\n]+)"?\s*$/m);
if (!match) throw new Error('Missing CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE in .dev.vars');
const connectionString = match[1];

const migrationFile = process.env.MIGRATION_FILE || '../migrations/20260926_tournament_prize_and_fee.sql';
const sql = await readFile(new URL(migrationFile, import.meta.url), 'utf8');

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  // The app's runtime DB role doesn't own `tournaments` (owned by neondb_owner) but is already a
  // granted member of neon_superuser on this LOCAL branch, which does — assume it for this ALTER
  // TABLE only, scoped to this transaction.
  await client.query('SET LOCAL ROLE neon_superuser');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('Tournament prize/fee migration applied to LOCAL database target.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
