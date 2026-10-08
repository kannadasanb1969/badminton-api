// Explicit, idempotent bootstrap of the INITIAL fee rate for Owner batches that have none.
//
//   node scripts/bootstrap-owner-fee-rates.mjs            -> dry run (prints exactly what would be inserted)
//   node scripts/bootstrap-owner-fee-rates.mjs --apply    -> inserts the missing initial rates
//
// Decision (documented): the initial rate copies owner_batches.fee_per_person EXACTLY (the Owner-entered amount) and
// is effective from the first day of the month in which the batch was created (Asia/Kolkata). That is the earliest
// month in which the Owner-defined fee can have applied, so no history is invented. owner_batches is never modified.
//
// Safety: reads the LOCAL development connection from .dev.vars and REFUSES to run unless the host is exactly the
// verified q2-friendly-test endpoint. Credentials are never printed.
import pg from 'pg';
import { readFile } from 'node:fs/promises';

const REQUIRED_ENDPOINT = 'ep-weathered-meadow-b3ot536q';
const apply = process.argv.includes('--apply');

const vars = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
const connectionString = vars.match(/CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=(.*)/)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!connectionString) throw new Error('No local connection string in .dev.vars');
const endpoint = new URL(connectionString).hostname.split('.')[0].replace(/-pooler$/, '');
if (endpoint !== REQUIRED_ENDPOINT) throw new Error(`Refusing: database endpoint is not ${REQUIRED_ENDPOINT}`);
console.log(`target endpoint verified: ${REQUIRED_ENDPOINT}  mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const { rows } = await client.query(`
    SELECT b.id, b.name, b.batch_type, b.fee_per_person::text AS fee,
           to_char(date_trunc('month', b.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS effective_from
    FROM owner_batches b
    WHERE NOT EXISTS (SELECT 1 FROM owner_fee_rates r WHERE r.batch_id = b.id)
    ORDER BY b.created_at`);
  console.log(`${rows.length} batch(es) without an initial fee rate:`);
  for (const r of rows) console.log(`  ${r.name} (${r.batch_type})  fee ${r.fee}  effective_from ${r.effective_from}  effective_to NULL`);
  if (apply && rows.length) {
    await client.query('BEGIN');
    try {
      let inserted = 0;
      for (const r of rows) {
        const res = await client.query(
          `INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from, effective_to)
           SELECT $1, $2::numeric, $3::date, NULL
           WHERE NOT EXISTS (SELECT 1 FROM owner_fee_rates WHERE batch_id = $1)`,
          [r.id, r.fee, r.effective_from]);
        inserted += res.rowCount;
      }
      await client.query('COMMIT');
      console.log(`inserted ${inserted} fee rate row(s); owner_batches untouched`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
