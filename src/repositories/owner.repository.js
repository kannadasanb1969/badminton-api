// Owner domain persistence. Every academy/court read is scoped by the owning profile so callers
// cannot reach another Owner's rows even when they know an id.

export async function findProfileByUserId(db, userId) {
  return (await db.query("SELECT * FROM owner_profiles WHERE user_id = $1", [userId])).rows[0];
}

// ON CONFLICT keeps creation idempotent: a second call returns the existing profile unchanged.
export async function insertProfile(db, userId) {
  const created = (await db.query(
    "INSERT INTO owner_profiles (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING *",
    [userId])).rows[0];
  return created ?? findProfileByUserId(db, userId);
}

export async function listAcademies(db, profileId) {
  return (await db.query(`
    SELECT a.*, (SELECT COUNT(*)::int FROM owner_courts c WHERE c.academy_id = a.id AND c.status = 'ACTIVE') AS active_court_count,
      (SELECT COUNT(*)::int FROM owner_courts c WHERE c.academy_id = a.id) AS court_count,
      (SELECT COUNT(*)::int FROM owner_batches b WHERE b.academy_id = a.id AND b.status = 'ACTIVE' AND b.batch_type = 'REGULAR') AS active_regular_batch_count,
      (SELECT COUNT(*)::int FROM owner_batches b WHERE b.academy_id = a.id AND b.status = 'ACTIVE' AND b.batch_type = 'COACHING') AS active_coaching_batch_count,
      (SELECT COUNT(*)::int FROM owner_members mm WHERE mm.academy_id = a.id AND mm.status = 'ACTIVE') AS active_member_count
    FROM owner_academies a WHERE a.owner_profile_id = $1 ORDER BY a.created_at, a.id`, [profileId])).rows;
}

export async function findAcademy(db, profileId, academyId, lock = false) {
  return (await db.query(`
    SELECT a.*, (SELECT COUNT(*)::int FROM owner_courts c WHERE c.academy_id = a.id AND c.status = 'ACTIVE') AS active_court_count,
      (SELECT COUNT(*)::int FROM owner_courts c WHERE c.academy_id = a.id) AS court_count,
      (SELECT COUNT(*)::int FROM owner_batches b WHERE b.academy_id = a.id AND b.status = 'ACTIVE' AND b.batch_type = 'REGULAR') AS active_regular_batch_count,
      (SELECT COUNT(*)::int FROM owner_batches b WHERE b.academy_id = a.id AND b.status = 'ACTIVE' AND b.batch_type = 'COACHING') AS active_coaching_batch_count,
      (SELECT COUNT(*)::int FROM owner_members mm WHERE mm.academy_id = a.id AND mm.status = 'ACTIVE') AS active_member_count
    FROM owner_academies a WHERE a.id = $2 AND a.owner_profile_id = $1${lock ? " FOR UPDATE OF a" : ""}`,
    [profileId, academyId])).rows[0];
}

export async function insertAcademy(db, profileId, v) {
  return (await db.query(`
    INSERT INTO owner_academies (owner_profile_id, name, mobile, address, area, city, state, pincode)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [profileId, v.name, v.mobile ?? null, v.address ?? null, v.area ?? null, v.city ?? null, v.state ?? null, v.pincode ?? null])).rows[0];
}

const ACADEMY_COLUMNS = { name: "name", mobile: "mobile", address: "address", area: "area", city: "city", state: "state", pincode: "pincode", status: "status" };

export async function updateAcademy(db, profileId, academyId, patch) {
  const sets = [];
  const values = [profileId, academyId];
  for (const [key, column] of Object.entries(ACADEMY_COLUMNS)) {
    if (Object.hasOwn(patch, key)) { values.push(patch[key]); sets.push(`${column} = $${values.length}`); }
  }
  if (!sets.length) return findAcademy(db, profileId, academyId);
  await db.query(`UPDATE owner_academies SET ${sets.join(", ")}, updated_at = NOW() WHERE owner_profile_id = $1 AND id = $2`, values);
  return findAcademy(db, profileId, academyId);
}

export async function listCourts(db, academyId) {
  return (await db.query("SELECT * FROM owner_courts WHERE academy_id = $1 ORDER BY display_order, created_at, id", [academyId])).rows;
}

export async function insertCourt(db, academyId, name) {
  return (await db.query(`
    INSERT INTO owner_courts (academy_id, name, display_order)
    VALUES ($1, $2, COALESCE((SELECT MAX(display_order) + 1 FROM owner_courts WHERE academy_id = $1), 0))
    RETURNING *`, [academyId, name])).rows[0];
}

// Joins through academy -> profile so a court id alone never grants access.
export async function findCourtForOwner(db, profileId, courtId, lock = false) {
  return (await db.query(`
    SELECT c.* FROM owner_courts c JOIN owner_academies a ON a.id = c.academy_id
    WHERE c.id = $2 AND a.owner_profile_id = $1${lock ? " FOR UPDATE OF c" : ""}`, [profileId, courtId])).rows[0];
}

export async function updateCourt(db, courtId, patch) {
  const sets = [];
  const values = [courtId];
  for (const key of ["name", "status"]) {
    if (Object.hasOwn(patch, key)) { values.push(patch[key]); sets.push(`${key} = $${values.length}`); }
  }
  return (await db.query(`UPDATE owner_courts SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, values)).rows[0];
}
