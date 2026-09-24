export async function registrations(db, tournamentId, categoryId) { return (await db.query("SELECT * FROM registrations WHERE tournament_id=$1 AND category_id=$2 AND status IN ('REGISTERED','CONFIRMED') ORDER BY created_at", [tournamentId, categoryId])).rows; }
export async function tournament(db, id) { return (await db.query('SELECT * FROM tournaments WHERE id=$1',[id])).rows[0]; }
export async function category(db, id) { return (await db.query('SELECT * FROM tournament_categories WHERE id=$1',[id])).rows[0]; }
export async function existingFixture(db,t,c) { return (await db.query('SELECT * FROM fixtures WHERE tournament_id=$1 AND category_id=$2 LIMIT 1',[t,c])).rows[0]; }
export async function nextCode(db,prefix,table,column) { return (await db.query(`SELECT COALESCE(MAX(substring(${column} FROM ${prefix.length+1})::numeric),0)::text AS n FROM ${table} WHERE ${column} ~ $1`, [`^${prefix}[0-9]+$`])).rows[0].n; }
export async function users(db,id) { return (await db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0]; }
export async function playerProfilesByIds(db,ids) {
  if(!ids.length) return new Map();
  const rows=(await db.query('SELECT id,full_name,player_code FROM player_profiles WHERE id=ANY($1::text[])',[ids])).rows;
  return new Map(rows.map(r=>[r.id,r]));
}
export async function teams(db,t,c) { return (await db.query('SELECT * FROM teams WHERE ($1::text IS NULL OR tournament_id=$1) AND ($2::text IS NULL OR category_id=$2) ORDER BY created_at',[t??null,c??null])).rows; }
export async function teamById(db,id) { return (await db.query('SELECT * FROM teams WHERE id=$1',[id])).rows[0]; }
export async function insertTeam(db,t,c,a,at,b,bt,code) { return (await db.query("INSERT INTO teams (team_code,tournament_id,category_id,player1_id,player1_type,player2_id,player2_type,partner_status,status,confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'NOT_REQUIRED','CONFIRMED',NOW()) RETURNING *",[code,t,c,a,at,b,bt])).rows[0]; }
// The app DB role does not own fixtures/matches/fixture_participants (confirmed live: ALTER fails with
// "must be owner of table ..." / "permission denied for table ..."), so pool/qualification data cannot live
// as columns on those tables. It lives in new side-tables this role owns (fixture_pools,
// fixture_pool_participants, fixture_pool_matches, fixture_qualification — see the 20260919_fixture_pools.sql
// migration) and is joined back onto participants/matches in JS (see fixture.service.js `mapped()`), while
// every INSERT into fixtures/fixture_participants/matches stays byte-for-byte the same as before pools existed.
export async function insertFixture(db,t,c,format,event,actor,code) { return (await db.query("INSERT INTO fixtures (fixture_code,tournament_id,category_id,format,status,event_type,generated_by) VALUES ($1,$2,$3,$4,'DRAFT',$5,$6) RETURNING *",[code,t,c,format,event,actor])).rows[0]; }
export async function insertQualificationConfig(db,fixtureId,qualification) { return (await db.query('INSERT INTO fixture_qualification (fixture_id,qualifiers_per_pool,wildcard_count,best_third_place_count,target_knockout_bracket_size) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (fixture_id) DO UPDATE SET qualifiers_per_pool=EXCLUDED.qualifiers_per_pool,wildcard_count=EXCLUDED.wildcard_count,best_third_place_count=EXCLUDED.best_third_place_count,target_knockout_bracket_size=EXCLUDED.target_knockout_bracket_size,updated_at=NOW() RETURNING *',[fixtureId,qualification?.qualifiersPerPool??1,qualification?.wildcardCount??0,qualification?.bestThirdPlaceCount??0,qualification?.targetKnockoutBracketSize??null])).rows[0]; }
export async function qualificationConfig(db,fixtureId) { return (await db.query('SELECT * FROM fixture_qualification WHERE fixture_id=$1',[fixtureId])).rows[0]; }
export async function markPromoted(db,fixtureId,knockoutFixtureId) { return (await db.query('UPDATE fixture_qualification SET promoted_to_fixture_id=$2,updated_at=NOW() WHERE fixture_id=$1 RETURNING *',[fixtureId,knockoutFixtureId])).rows[0]; }
export async function insertParticipant(db,f,id,type,seed,name,code) { return (await db.query('INSERT INTO fixture_participants (fixture_id,participant_id,participant_type,seed_number,display_name,display_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',[f,id,type,seed,name,code])).rows[0]; }
export async function linkParticipantToPool(db,poolId,fixtureId,participantId,participantType,seed) { return (await db.query('INSERT INTO fixture_pool_participants (pool_id,fixture_id,participant_id,participant_type,seed_number) VALUES ($1,$2,$3,$4,$5) RETURNING *',[poolId,fixtureId,participantId,participantType,seed])).rows[0]; }
export async function insertMatch(db,f,t,c,n,p1,pt1,p2,pt2,round=1) { return (await db.query("INSERT INTO matches (match_code,fixture_id,tournament_id,category_id,round_number,round_name,match_number,participant1_id,participant1_type,participant2_id,participant2_type,status,winning_points) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'SCHEDULED',NULL) RETURNING *",[`M${f.slice(0,6)}${n}`,f,t,c,round,round===1?'ROUND_1':`ROUND_${round}`,n,p1,pt1,p2,pt2])).rows[0]; }
export async function linkMatchToPool(db,poolId,fixtureId,matchId) { return (await db.query('INSERT INTO fixture_pool_matches (pool_id,fixture_id,match_id) VALUES ($1,$2,$3) RETURNING *',[poolId,fixtureId,matchId])).rows[0]; }
export async function linkNextMatch(db,sourceId,nextId,slot) { return (await db.query('UPDATE matches SET next_match_id=$2,next_match_slot=$3,updated_at=NOW() WHERE id=$1 RETURNING *',[sourceId,nextId,slot])).rows[0]; }
export async function fixtureParticipants(db,id) { return (await db.query('SELECT * FROM fixture_participants WHERE fixture_id=$1 ORDER BY seed_number',[id])).rows; }
export async function fixtureMatches(db,id) { return (await db.query('SELECT * FROM matches WHERE fixture_id=$1 ORDER BY round_number,match_number',[id])).rows; }
export async function insertPool(db,f,t,c,name,order) { return (await db.query('INSERT INTO fixture_pools (fixture_id,tournament_id,category_id,name,pool_order) VALUES ($1,$2,$3,$4,$5) RETURNING *',[f,t,c,name,order])).rows[0]; }
export async function fixturePools(db,id) { return (await db.query('SELECT * FROM fixture_pools WHERE fixture_id=$1 ORDER BY pool_order',[id])).rows; }
// Used only to rebuild a LEGACY League fixture (generated before pools existed: zero fixture_pools rows,
// zero completed/live matches — see generate()'s existingFixture branch) into the current pooled structure.
// Deleting fixture_pools cascades to fixture_pool_participants/fixture_pool_matches for this fixture.
export async function deleteFixtureMatches(db,fixtureId) { await db.query('DELETE FROM matches WHERE fixture_id=$1',[fixtureId]); }
export async function deleteFixturePools(db,fixtureId) { await db.query('DELETE FROM fixture_pools WHERE fixture_id=$1',[fixtureId]); }
export async function poolParticipantLinks(db,fixtureId) { return (await db.query('SELECT pool_id,participant_id FROM fixture_pool_participants WHERE fixture_id=$1',[fixtureId])).rows; }
export async function poolMatchLinks(db,fixtureId) { return (await db.query('SELECT pool_id,match_id FROM fixture_pool_matches WHERE fixture_id=$1',[fixtureId])).rows; }
export async function listFixtures(db,filters={}) { return (await db.query('SELECT * FROM fixtures WHERE ($1::text IS NULL OR tournament_id=$1) AND ($2::text IS NULL OR category_id=$2) ORDER BY created_at DESC',[filters.tournamentId??null,filters.categoryId??null])).rows; }
export async function findFixture(db,id) { return (await db.query('SELECT * FROM fixtures WHERE id=$1',[id])).rows[0]; }
export async function publishFixture(db,id,userId) { return (await db.query("UPDATE fixtures SET status='PUBLISHED',published_by=$2,published_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='DRAFT' RETURNING *",[id,userId])).rows[0]; }
