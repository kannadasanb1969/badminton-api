export async function lockGuests(db) {
  // Serialize writes without adding schema objects; reads remain available.
  await db.query("LOCK TABLE player_profiles IN SHARE ROW EXCLUSIVE MODE");
  await db.query("LOCK TABLE guest_players IN SHARE ROW EXCLUSIVE MODE");
}

export async function findAll(db) {
  return (await db.query("SELECT * FROM guest_players ORDER BY created_at DESC")).rows;
}

export async function findById(db, id) {
  return (await db.query("SELECT * FROM guest_players WHERE id = $1", [id])).rows[0];
}

export async function findByCode(db, code) {
  return (await db.query("SELECT * FROM guest_players WHERE guest_code = $1", [code])).rows[0];
}

export async function findDuplicate(db, name, mobile, excludedId = null) {
  return (await db.query(`
    SELECT id FROM guest_players
    WHERE lower(btrim(full_name)) = lower(btrim($1)) AND btrim(mobile) = $2
      AND ($3::text IS NULL OR id <> $3)
    LIMIT 1`, [name, mobile, excludedId])).rows[0];
}

export async function highestCodeNumber(db) {
  return (await db.query(`
    SELECT COALESCE(MAX(substring(guest_code FROM 4)::numeric), 0)::text AS number
    FROM guest_players WHERE guest_code ~ '^GST[0-9]+$'`)).rows[0].number;
}

function values(player) {
  return [player.fullName, player.mobile, player.gender, player.dob, player.location,
    player.playingSince, player.regularPlayer, player.courtAcademy];
}

export async function insert(db, player, code) {
  return (await db.query(`
    INSERT INTO guest_players
      (full_name, mobile, gender, dob, location, playing_since, regular_player,
       court_academy, guest_code)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [...values(player), code])).rows[0];
}

export async function update(db, id, player) {
  return (await db.query(`
    UPDATE guest_players SET full_name=$1, mobile=$2, gender=$3, dob=$4,
      location=$5, playing_since=$6, regular_player=$7, court_academy=$8, updated_at=NOW()
    WHERE id=$9 RETURNING *`, [...values(player), id])).rows[0];
}

export async function findRegisteredPlayer(db, name, mobile) {
  return (await db.query(`
    SELECT id, player_code FROM player_profiles
    WHERE lower(btrim(full_name)) = lower(btrim($1)) AND btrim(mobile) = $2
    LIMIT 1`, [name, mobile])).rows[0];
}
