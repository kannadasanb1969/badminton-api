import { Client } from 'pg';
import { generate } from '../src/services/fixture.service.js';
import { readFile } from 'node:fs/promises';

const vars = await readFile('.dev.vars', 'utf8').catch(() => '');
const localValue = vars.match(/^CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=(.*)$/m)?.[1];
const connectionString = process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE || localValue;
if (!connectionString) throw new Error('Set CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE before running this development seed.');
const client = new Client({ connectionString });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('ALTER TABLE matches ADD COLUMN IF NOT EXISTS is_auto_advanced boolean NOT NULL DEFAULT false');
  const organizer = (await client.query("INSERT INTO users(id,mobile,role,display_name,is_active) VALUES('dev-organizer-10ko','9999900010','ORGANIZER','Development Organizer',true) ON CONFLICT (id) DO UPDATE SET is_active=true RETURNING *")).rows[0];
  const tournament = (await client.query(`INSERT INTO tournaments(tournament_code,organizer_id,organizer_mobile,organizer_name,name,description,tournament_date,format,status)
    VALUES('TRN990010',$1,$2,$3,'10 Team Knockout Test','Development-only doubles knockout test',CURRENT_DATE,'KNOCKOUT','PUBLISHED')
    ON CONFLICT (tournament_code) DO UPDATE SET status='PUBLISHED' RETURNING *`,[organizer.id,organizer.mobile,organizer.display_name])).rows[0];
  let category=(await client.query("SELECT * FROM tournament_categories WHERE tournament_id=$1 AND name='Seed Doubles' LIMIT 1",[tournament.id])).rows[0];
  if(!category) category=(await client.query(`INSERT INTO tournament_categories(name,event_type,tournament_id) VALUES('Seed Doubles','DOUBLES',$1) RETURNING *`,[tournament.id])).rows[0];
  for(let i=1;i<=20;i++){
    const code=`DEV9900${String(i).padStart(2,'0')}`, id=`dev-player-10ko-${String(i).padStart(2,'0')}`;
    await client.query("INSERT INTO users(id,mobile,role,display_name,is_active) VALUES($1,$2,'PLAYER',$3,true) ON CONFLICT (id) DO UPDATE SET is_active=true",[id,`999991${String(i).padStart(4,'0')}`,`Seed Player ${String(Math.ceil(i/2)).padStart(2,'0')}${i%2?'A':'B'}`]);
    await client.query("INSERT INTO player_profiles(id,player_code,user_id,full_name,mobile,regular_player,profile_status) VALUES($1,$2,$3,$4,$5,true,'ACTIVE') ON CONFLICT (id) DO NOTHING",[id,code,id,`Seed Player ${String(Math.ceil(i/2)).padStart(2,'0')}${i%2?'A':'B'}`,`999991${String(i).padStart(4,'0')}`]);
  }
  for(let i=0;i<10;i++) await client.query(`INSERT INTO registrations(registration_code,tournament_id,category_id,player_id,event_type,partner_id,partner_type,status)
    VALUES($1,$2,$3,$4,'DOUBLES',$5,'FULL','REGISTERED') ON CONFLICT DO NOTHING`,[`REG990${String(i+1).padStart(3,'0')}`,tournament.id,category.id,`dev-player-10ko-${String(i*2+1).padStart(2,'0')}`,`dev-player-10ko-${String(i*2+2).padStart(2,'0')}`]);
  await client.query('COMMIT');
  const existing=(await client.query('SELECT id FROM fixtures WHERE tournament_id=$1 AND category_id=$2 LIMIT 1',[tournament.id,category.id])).rows[0];
  const result=existing?{id:existing.id}:{...(await generate({HYPERDRIVE:{connectionString}},{tournamentId:tournament.id,categoryId:category.id,format:'KNOCKOUT',organizerUserId:organizer.id}))};
  console.log(JSON.stringify({tournamentId:tournament.id,categoryId:category.id,fixtureId:result.id,generated:!existing},null,2));
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
