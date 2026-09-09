export async function lockPlayers(db) {
  // Serialize writes without adding schema objects; reads remain available.
  await db.query("LOCK TABLE player_profiles IN SHARE ROW EXCLUSIVE MODE");
}

export async function findAll(db) {
  return (await db.query("SELECT * FROM player_profiles ORDER BY created_at DESC")).rows;
}

export async function findById(db, id) {
  return (await db.query("SELECT * FROM player_profiles WHERE id = $1", [id])).rows[0];
}

export async function findByCode(db, code) {
  return (await db.query("SELECT * FROM player_profiles WHERE player_code = $1", [code])).rows[0];
}
export async function findUser(db,id){return (await db.query('SELECT * FROM users WHERE id=$1',[id])).rows[0];}
export async function findByUserId(db,id){return (await db.query('SELECT * FROM player_profiles WHERE user_id=$1',[id])).rows[0];}
export async function linkUser(db,playerId,userId){return (await db.query('UPDATE player_profiles SET user_id=$2,updated_at=NOW() WHERE id=$1 RETURNING *',[playerId,userId])).rows[0];}

export async function findDuplicate(db, name, mobile, excludedId = null) {
  return (await db.query(`
    SELECT id FROM player_profiles
    WHERE lower(btrim(full_name)) = lower(btrim($1)) AND btrim(mobile) = $2
      AND ($3::text IS NULL OR id <> $3)
    LIMIT 1`, [name, mobile, excludedId])).rows[0];
}

export async function highestCodeNumber(db) {
  return (await db.query(`
    SELECT COALESCE(MAX(substring(player_code FROM 4)::numeric), 0)::text AS number
    FROM player_profiles WHERE player_code ~ '^PLR[0-9]+$'`)).rows[0].number;
}

function values(player) {
  return [player.fullName, player.mobile, player.gender, player.dob, player.location,
    player.playingSince, player.regularPlayer, player.courtAcademy,
    player.profilePhotoUrl, player.profileStatus];
}

export async function insert(db, player, code) {
  return (await db.query(`
    INSERT INTO player_profiles
      (full_name, mobile, gender, dob, location, playing_since, regular_player,
       court_academy, profile_photo_url, profile_status, player_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [...values(player), code])).rows[0];
}

export async function update(db, id, player) {
  return (await db.query(`
    UPDATE player_profiles SET full_name=$1, mobile=$2, gender=$3, dob=$4,
      location=$5, playing_since=$6, regular_player=$7, court_academy=$8,
      profile_photo_url=$9, profile_status=$10, updated_at=NOW()
    WHERE id=$11 RETURNING *`, [...values(player), id])).rows[0];
}

export async function remove(db, id) {
  // TODO: Production must soft-delete with profile_status = 'INACTIVE' to retain
  // tournament, match, result and medal history.
  return (await db.query("DELETE FROM player_profiles WHERE id = $1 RETURNING *", [id])).rows[0];
}
