// Member / membership persistence. Reads that take a profileId join through academy -> owner profile, so an id
// alone never grants access to another Owner's rows.

const MEMBER_SCOPE = `FROM owner_members m JOIN owner_academies a ON a.id = m.academy_id WHERE a.owner_profile_id = $1`;

// One query, no N+1: active membership summaries are aggregated per member.
export async function listMembers(db, profileId, filters = {}) {
  const values = [profileId];
  let extra = "";
  for (const [column, key] of [["m.academy_id", "academyId"], ["m.status", "status"]]) {
    if (filters[key]) { values.push(filters[key]); extra += ` AND ${column} = $${values.length}`; }
  }
  return (await db.query(`
    SELECT m.*, COALESCE((
      SELECT json_agg(json_build_object('membershipId', ms.id, 'batchId', b.id, 'batchName', b.name, 'type', b.batch_type, 'courtName', c.name)
                      ORDER BY b.start_time, b.name)
      FROM owner_memberships ms JOIN owner_batches b ON b.id = ms.batch_id JOIN owner_courts c ON c.id = b.court_id
      WHERE ms.member_id = m.id AND ms.status = 'ACTIVE'), '[]'::json) AS active_memberships
    ${MEMBER_SCOPE}${extra} ORDER BY lower(m.name), m.id`, values)).rows;
}

export async function findMemberForOwner(db, profileId, memberId, lock = false) {
  return (await db.query(`SELECT m.* ${MEMBER_SCOPE} AND m.id = $2${lock ? " FOR UPDATE OF m" : ""}`, [profileId, memberId])).rows[0];
}

export async function insertMember(db, academyId, name, mobile) {
  return (await db.query("INSERT INTO owner_members (academy_id, name, mobile) VALUES ($1,$2,$3) RETURNING *", [academyId, name, mobile])).rows[0];
}

export async function updateMember(db, memberId, patch) {
  const sets = [];
  const values = [memberId];
  for (const key of ["name", "mobile", "status"]) {
    if (Object.hasOwn(patch, key)) { values.push(patch[key]); sets.push(`${key} = $${values.length}`); }
  }
  return (await db.query(`UPDATE owner_members SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1 RETURNING *`, values)).rows[0];
}

export async function countActiveForMember(db, memberId) {
  return (await db.query("SELECT COUNT(*)::int AS n FROM owner_memberships WHERE member_id = $1 AND status = 'ACTIVE'", [memberId])).rows[0].n;
}

export async function countActiveForBatch(db, batchId) {
  return (await db.query("SELECT COUNT(*)::int AS n FROM owner_memberships WHERE batch_id = $1 AND status = 'ACTIVE'", [batchId])).rows[0].n;
}

const MEMBERSHIP_SELECT = `
  SELECT ms.*, to_char(ms.start_date, 'YYYY-MM-DD') AS start_ymd, to_char(ms.end_date, 'YYYY-MM-DD') AS end_ymd,
    b.name AS batch_name, b.batch_type, b.status AS batch_status, b.fee_per_person,
    to_char(b.start_time, 'HH24:MI') AS batch_start, to_char(b.end_time, 'HH24:MI') AS batch_end, c.name AS court_name
  FROM owner_memberships ms JOIN owner_batches b ON b.id = ms.batch_id JOIN owner_courts c ON c.id = b.court_id`;

export async function listMemberships(db, memberId) {
  return (await db.query(`${MEMBERSHIP_SELECT} WHERE ms.member_id = $1 ORDER BY (ms.status = 'ACTIVE') DESC, ms.start_date DESC, ms.created_at DESC, ms.id`, [memberId])).rows;
}

export async function getMembership(db, membershipId) {
  return (await db.query(`${MEMBERSHIP_SELECT} WHERE ms.id = $1`, [membershipId])).rows[0];
}

// Ownership: membership -> member -> academy -> owner profile.
export async function findMembershipOwner(db, profileId, membershipId, lock = false) {
  return (await db.query(`
    SELECT ms.*, to_char(ms.start_date, 'YYYY-MM-DD') AS start_ymd, m.academy_id
    FROM owner_memberships ms JOIN owner_members m ON m.id = ms.member_id JOIN owner_academies a ON a.id = m.academy_id
    WHERE ms.id = $2 AND a.owner_profile_id = $1${lock ? " FOR UPDATE OF ms" : ""}`, [profileId, membershipId])).rows[0];
}

// FOR SHARE blocks a concurrent batch deactivation (which takes FOR UPDATE on the same row) until we commit.
export async function lockBatchShare(db, profileId, batchId) {
  return (await db.query(`
    SELECT b.*, c.status AS court_status FROM owner_batches b
    JOIN owner_courts c ON c.id = b.court_id JOIN owner_academies a ON a.id = b.academy_id
    WHERE b.id = $2 AND a.owner_profile_id = $1 FOR SHARE OF b`, [profileId, batchId])).rows[0];
}

export async function insertMembership(db, memberId, batchId, startDate) {
  return (await db.query("INSERT INTO owner_memberships (member_id, batch_id, start_date) VALUES ($1,$2,$3) RETURNING id", [memberId, batchId, startDate])).rows[0].id;
}

export async function endMembership(db, membershipId, endDate) {
  await db.query("UPDATE owner_memberships SET status = 'ENDED', end_date = $2, updated_at = NOW() WHERE id = $1", [membershipId, endDate]);
}
