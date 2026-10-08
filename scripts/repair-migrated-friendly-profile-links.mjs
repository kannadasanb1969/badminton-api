import fs from 'node:fs';
import { Client } from 'pg';

const vars = fs.readFileSync('./.dev.vars', 'utf8');
const line = vars.split(/\r?\n/).find((value) => value.startsWith('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='));
if (!line) throw new Error('Missing local Hyperdrive connection string');
const connectionString = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
const client = new Client({ connectionString });

await client.connect();
try {
  await client.query('BEGIN');
  const rows = (await client.query(`
    SELECT p.id AS profile_id, p.mobile, u.id AS user_id
    FROM player_profiles p
    JOIN friendly_matches fm ON fm.title='Mobile Doubles Test - 12 Players (Migrated)'
    JOIN users u ON u.mobile=p.mobile AND u.role='PLAYER' AND u.is_active=true
    WHERE (p.id=fm.creator_player_id OR EXISTS (SELECT 1 FROM friendly_match_participants fp WHERE fp.friendly_match_id=fm.id AND fp.player_id=p.id))
      AND p.user_id IS NULL
    GROUP BY p.id,p.mobile,u.id
  `)).rows;
  if (rows.length !== 1) throw new Error(`Expected exactly one unlinked migrated profile, found ${rows.length}`);
  await client.query('UPDATE player_profiles SET user_id=$2,updated_at=NOW() WHERE id=$1 AND user_id IS NULL', [rows[0].profile_id, rows[0].user_id]);
  await client.query('COMMIT');
  console.log(JSON.stringify({ repaired: rows[0] }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
