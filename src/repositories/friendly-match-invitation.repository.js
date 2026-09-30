export async function insert(db, matchId, inviterId, invitedId) {
  return (await db.query(
    'INSERT INTO friendly_match_invitations(friendly_match_id,inviter_player_id,invited_player_id) VALUES($1,$2,$3) RETURNING *',
    [matchId, inviterId, invitedId],
  )).rows[0];
}
export async function active(db, matchId, invitedId) {
  return (await db.query(
    "SELECT * FROM friendly_match_invitations WHERE friendly_match_id=$1 AND invited_player_id=$2 AND status='PENDING'",
    [matchId, invitedId],
  )).rows[0];
}
export async function byId(db, id, lock = false) {
  return (await db.query(`SELECT * FROM friendly_match_invitations WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
}
export async function updateStatus(db, id, status) {
  return (await db.query(
    'UPDATE friendly_match_invitations SET status=$2,updated_at=NOW(),responded_at=NOW() WHERE id=$1 RETURNING *',
    [id, status],
  )).rows[0];
}
export async function forMatch(db, matchId) {
  return (await db.query(
    `SELECT i.*,p.full_name,p.player_code FROM friendly_match_invitations i
     JOIN player_profiles p ON p.id=i.invited_player_id
     WHERE i.friendly_match_id=$1 ORDER BY i.created_at DESC`,
    [matchId],
  )).rows;
}
