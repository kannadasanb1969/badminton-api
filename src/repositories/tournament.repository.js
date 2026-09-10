// Identifiers come only from these internal allowlists, never request keys.
const fields = ['name','description','tournament_date','reporting_time','registration_close_date','registration_close_time','venue_name','venue_address','map_link','format','prizes','shuttle','scoring_format'];
const categoryFields = ['name','event_type','gender_eligibility','min_age','max_age','max_teams','medalists_allowed','open_players_allowed','beginner_only','pure_beginner_only','additional_rule_notes'];
export async function lockCreation(db) {
  await db.query('LOCK TABLE tournaments IN SHARE ROW EXCLUSIVE MODE');
}
export async function highestCode(db) {
  return (await db.query("SELECT COALESCE(MAX(substring(tournament_code FROM 4)::numeric),0)::text AS number FROM tournaments WHERE tournament_code ~ '^TRN[0-9]+$'")).rows[0].number;
}
export async function findAll(db, filters) {
  return (await db.query(`SELECT t.* FROM tournaments t WHERE ($1::text IS NULL OR t.status=$1)
    AND ($2::text IS NULL OR t.organizer_id=$2)
    AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM tournament_categories c WHERE c.tournament_id=t.id AND c.event_type=$3))
    ORDER BY t.created_at DESC`, [filters.status??null,filters.organizerId??null,filters.eventType??null])).rows;
}
export async function findById(db,id,lock=false) {
  return (await db.query(lock?'SELECT * FROM tournaments WHERE id=$1 FOR UPDATE':'SELECT * FROM tournaments WHERE id=$1',[id])).rows[0];
}
export async function findByCode(db,code) {
  return (await db.query('SELECT * FROM tournaments WHERE tournament_code=$1',[code])).rows[0];
}
export async function categories(db,id) {
  return (await db.query('SELECT * FROM tournament_categories WHERE tournament_id=$1 ORDER BY created_at,id',[id])).rows;
}
export async function rules(db,id) {
  return (await db.query('SELECT * FROM tournament_rules WHERE tournament_id=$1 ORDER BY sort_order,id',[id])).rows;
}
export async function registrationCounts(db,tournamentIds) {
  if(!tournamentIds.length)return {tournaments:new Map(),categories:new Map()};
  const params=[tournamentIds];
  const categories=await db.query(`WITH active AS (SELECT * FROM registrations WHERE tournament_id=ANY($1::text[]) AND status IN ('PENDING','REGISTERED','CONFIRMED')),
    participants AS (SELECT tournament_id,category_id,'PLAYER:'||player_id AS participant FROM active UNION ALL SELECT tournament_id,category_id,CASE WHEN partner_type='FULL' THEN 'PLAYER:'||partner_id ELSE 'GUEST:'||partner_id END FROM active WHERE event_type='DOUBLES' AND partner_id IS NOT NULL),
    entries AS (SELECT tournament_id,category_id,COUNT(*)::int registered_entry_count,COUNT(*) FILTER (WHERE event_type='DOUBLES' AND partner_id IS NOT NULL)::int registered_team_count FROM active GROUP BY tournament_id,category_id), people AS (SELECT tournament_id,category_id,COUNT(DISTINCT participant)::int registered_player_count FROM participants GROUP BY tournament_id,category_id)
    SELECT e.tournament_id,e.category_id,e.registered_entry_count,e.registered_team_count,COALESCE(p.registered_player_count,0)::int registered_player_count FROM entries e LEFT JOIN people p USING (tournament_id,category_id)`,params);
  const tournaments=await db.query(`WITH active AS (SELECT * FROM registrations WHERE tournament_id=ANY($1::text[]) AND status IN ('PENDING','REGISTERED','CONFIRMED')),
    participants AS (SELECT tournament_id,'PLAYER:'||player_id AS participant FROM active UNION ALL SELECT tournament_id,CASE WHEN partner_type='FULL' THEN 'PLAYER:'||partner_id ELSE 'GUEST:'||partner_id END FROM active WHERE event_type='DOUBLES' AND partner_id IS NOT NULL),
    entries AS (SELECT tournament_id,COUNT(*)::int registered_entry_count,COUNT(*) FILTER (WHERE event_type='DOUBLES' AND partner_id IS NOT NULL)::int registered_team_count FROM active GROUP BY tournament_id), people AS (SELECT tournament_id,COUNT(DISTINCT participant)::int registered_player_count FROM participants GROUP BY tournament_id)
    SELECT e.tournament_id,e.registered_entry_count,e.registered_team_count,COALESCE(p.registered_player_count,0)::int registered_player_count FROM entries e LEFT JOIN people p USING (tournament_id)`,params);
  return {categories:new Map(categories.rows.map(r=>[r.category_id,r])),tournaments:new Map(tournaments.rows.map(r=>[r.tournament_id,r]))};
}
export async function insert(db,data,code,organizer) {
  const columns=[...fields,'tournament_code','organizer_id','organizer_mobile','organizer_name'];
  return (await db.query(`INSERT INTO tournaments (${columns.join(',')}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,[...fields.map(k=>data[k]),code,organizer.id,organizer.mobile,organizer.display_name])).rows[0];
}
export async function update(db,id,data) {
  return (await db.query(`UPDATE tournaments SET ${fields.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=NOW() WHERE id=$${fields.length+1} RETURNING *`,[...fields.map(k=>data[k]),id])).rows[0];
}
export async function saveCategory(db,tournamentId,data) {
  if(data.id) {
    return (await db.query(`UPDATE tournament_categories SET ${categoryFields.map((k,i)=>`${k}=$${i+1}`).join(',')},updated_at=NOW() WHERE id=$12 AND tournament_id=$13 RETURNING *`,[...categoryFields.map(k=>data[k]),data.id,tournamentId])).rows[0];
  }
  return (await db.query(`INSERT INTO tournament_categories (${categoryFields.join(',')},tournament_id) VALUES (${categoryFields.map((_,i)=>'$'+(i+1)).join(',')},$12) RETURNING *`,[...categoryFields.map(k=>data[k]),tournamentId])).rows[0];
}
export async function closeCategory(db,tournamentId,categoryId) {
  return (await db.query("UPDATE tournament_categories SET registration_phase='CLOSED',registration_closed_at=NOW(),updated_at=NOW() WHERE id=$1 AND tournament_id=$2 AND registration_phase='OPEN' RETURNING *",[categoryId,tournamentId])).rows[0];
}
export async function replaceRules(db,id,rules) {
  await db.query('DELETE FROM tournament_rules WHERE tournament_id=$1',[id]);
  for(let i=0;i<rules.length;i++) await db.query('INSERT INTO tournament_rules (tournament_id,rule_text,sort_order) VALUES ($1,$2,$3)',[id,rules[i],i]);
}
export async function transition(db,id,action,actor,reason) {
  const statements={
    submit:"UPDATE tournaments SET status='PENDING_ADMIN_APPROVAL',submitted_at=NOW(),rejection_reason=NULL,rejected_at=NULL,rejected_by=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",
    approve:"UPDATE tournaments SET status='APPROVED',approved_by=$2,approved_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",
    reject:"UPDATE tournaments SET status='REJECTED',rejected_by=$2,rejected_at=NOW(),rejection_reason=$3,updated_at=NOW() WHERE id=$1 RETURNING *",
    publish:"UPDATE tournaments SET status='PUBLISHED',published_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",
  };
  const values=action==='reject'?[id,actor,reason]:action==='approve'?[id,actor]:[id];
  return (await db.query(statements[action],values)).rows[0];
}
