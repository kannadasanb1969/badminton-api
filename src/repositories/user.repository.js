export async function findById(db, id) {
  return (await db.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];
}
export async function findByMobile(db, mobile, role = null) {
  return (await db.query('SELECT * FROM users WHERE mobile=$1 AND ($2::text IS NULL OR role=$2) ORDER BY created_at', [mobile,role])).rows;
}
export async function createPlayerUser(db, mobile) {
  return (await db.query("INSERT INTO users (mobile,role) VALUES ($1,'PLAYER') ON CONFLICT (mobile,role) DO UPDATE SET mobile=EXCLUDED.mobile RETURNING *", [mobile])).rows[0];
}
export async function linkedProfiles(db, userId) {
  return (await db.query('SELECT * FROM player_profiles WHERE user_id=$1', [userId])).rows;
}
export async function userLinkedToPlayerMobile(db,mobile){return (await db.query('SELECT u.* FROM users u JOIN player_profiles p ON p.user_id=u.id WHERE p.mobile=$1 AND u.role=\'PLAYER\' AND u.is_active=true ORDER BY u.created_at LIMIT 1',[mobile])).rows[0];}
// Mobile alone is not sufficient evidence to assign ownership. Profile linking
// and guest claiming remain explicit future workflows.
