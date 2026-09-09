export async function lockWrites(db) {
  // Serialize code generation and participant checks across registration writes.
  await db.query('LOCK TABLE registrations IN SHARE ROW EXCLUSIVE MODE');
}
export async function context(db,input) {
  const tournament=(await db.query('SELECT *, CURRENT_DATE::text AS today FROM tournaments WHERE id=$1 FOR SHARE',[input.tournamentId])).rows[0];
  const category=(await db.query('SELECT * FROM tournament_categories WHERE id=$1 FOR SHARE',[input.categoryId])).rows[0];
  const player=(await db.query('SELECT * FROM player_profiles WHERE id=$1 FOR SHARE',[input.playerId])).rows[0];
  let partner=null;
  if(input.partner?.id && ['PLAYER','GUEST'].includes(input.partner.type)) {
    partner=(await db.query(input.partner.type==='PLAYER'?'SELECT * FROM player_profiles WHERE id=$1 FOR SHARE':'SELECT * FROM guest_players WHERE id=$1 FOR SHARE',[input.partner.id])).rows[0];
  }
  return {tournament,category,player,partner};
}
export async function participation(db,tournamentId,categoryId,id,type) {
  return (await db.query(`SELECT id,status,player_id FROM registrations WHERE tournament_id=$1 AND category_id=$2
    AND status IN ('PENDING','REGISTERED','CONFIRMED')
    AND (($4::text='PLAYER' AND player_id=$3) OR (partner_id=$3 AND partner_type=CASE WHEN $4::text='PLAYER' THEN 'FULL' ELSE 'GUEST' END)) LIMIT 1`,[tournamentId,categoryId,id,type])).rows[0];
}
export async function existingHistory(db,categoryId,playerId) {
  return (await db.query('SELECT id,status FROM registrations WHERE category_id=$1 AND player_id=$2',[categoryId,playerId])).rows[0];
}
export async function medalist(db,id,type) {
  return (await db.query(`SELECT id FROM medal_history WHERE medal_type IS DISTINCT FROM 'NONE'
    AND (($2::text='PLAYER' AND (player_id=$1 OR guest_player_id IN (SELECT id FROM guest_players WHERE linked_player_id=$1)))
      OR ($2::text='GUEST' AND guest_player_id=$1)) LIMIT 1`,[id,type])).rows.length>0;
}
export async function countActive(db,categoryId) {
  return (await db.query("SELECT count(*)::int AS count FROM registrations WHERE category_id=$1 AND status IN ('PENDING','REGISTERED','CONFIRMED')",[categoryId])).rows[0].count;
}
export async function nextNumber(db) {
  return (await db.query("SELECT COALESCE(MAX(substring(registration_code FROM 4)::numeric),0)::text AS number FROM registrations WHERE registration_code ~ '^REG[0-9]+$'")).rows[0].number;
}
export async function insert(db,input,eventType,code) {
  return (await db.query(`INSERT INTO registrations (registration_code,tournament_id,category_id,player_id,event_type,partner_id,partner_type,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'REGISTERED') RETURNING *`,[code,input.tournamentId,input.categoryId,input.playerId,eventType,input.partner?.id??null,input.partner?(input.partner.type==='PLAYER'?'FULL':'GUEST'):null])).rows[0];
}
export async function findById(db,id) {
  return (await db.query('SELECT * FROM registrations WHERE id=$1',[id])).rows[0];
}
export async function list(db,filters={}) {
  return (await db.query(`SELECT * FROM registrations WHERE ($1::text IS NULL OR tournament_id=$1)
    AND ($2::text IS NULL OR player_id=$2 OR (partner_type='FULL' AND partner_id=$2))
    AND ($3::text IS NULL OR status=$3) ORDER BY created_at DESC`,[filters.tournamentId??null,filters.playerId??null,filters.status??null])).rows;
}
export async function cancel(db,id) {
  return (await db.query("UPDATE registrations SET status='CANCELLED',cancelled_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[id])).rows[0];
}
