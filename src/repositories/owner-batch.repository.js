// Batch persistence. Every read/write that takes a profileId joins batch -> academy -> owner profile,
// so a batch id alone never grants access to another Owner's data.

const SELECT = `
  SELECT b.*, c.name AS court_name, to_char(b.start_time, 'HH24:MI') AS start_hhmm, to_char(b.end_time, 'HH24:MI') AS end_hhmm,
    to_char(b.effective_from, 'YYYY-MM-DD') AS effective_from_ymd, to_char(b.effective_to, 'YYYY-MM-DD') AS effective_to_ymd,
    cur.fee_amount::text AS current_fee
  FROM owner_batches b
  JOIN owner_academies a ON a.id = b.academy_id
  JOIN owner_courts c ON c.id = b.court_id
  LEFT JOIN LATERAL (
    SELECT r.fee_amount FROM owner_fee_rates r
    WHERE r.batch_id = b.id AND r.effective_from <= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date
      AND (r.effective_to IS NULL OR r.effective_to >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date)
  ) cur ON true`;

export async function list(db, profileId, filters = {}) {
  const values = [profileId];
  const where = ["a.owner_profile_id = $1"];
  for (const [column, key] of [["b.academy_id", "academyId"], ["b.court_id", "courtId"], ["b.batch_type", "type"], ["b.status", "status"]]) {
    if (filters[key]) { values.push(filters[key]); where.push(`${column} = $${values.length}`); }
  }
  return (await db.query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY c.display_order, c.name, b.start_time, b.id`, values)).rows;
}

export async function findForOwner(db, profileId, batchId, lock = false) {
  return (await db.query(`${SELECT} WHERE b.id = $2 AND a.owner_profile_id = $1${lock ? " FOR UPDATE OF b" : ""}`, [profileId, batchId])).rows[0];
}

export async function insert(db, v) {
  const { id } = (await db.query(`
    INSERT INTO owner_batches (academy_id, court_id, batch_type, name, start_time, end_time, fee_per_person, days_of_week, effective_from, effective_to)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::smallint[],$9::date,$10::date) RETURNING id`,
    [v.academyId, v.courtId, v.type, v.name, v.startTime, v.endTime, v.feePerPerson, v.daysOfWeek, v.effectiveFrom, v.effectiveTo])).rows[0];
  return id;
}

export async function update(db, batchId, v) {
  await db.query(`
    UPDATE owner_batches SET court_id = $2, batch_type = $3, name = $4, start_time = $5, end_time = $6,
      status = $7, days_of_week = $8::smallint[], effective_from = $9::date, effective_to = $10::date, updated_at = NOW() WHERE id = $1`,
    [batchId, v.courtId, v.type, v.name, v.startTime, v.endTime, v.status, v.daysOfWeek, v.effectiveFrom, v.effectiveTo]);
}

// Two ACTIVE batches on one court conflict only when ALL hold: time ranges overlap (new_start < existing_end AND
// new_end > existing_start; touching ends allowed), their weekday sets intersect, and their effective date ranges
// intersect (NULL bound = unbounded). Callers must hold the court-row lock.
export async function findActiveOverlap(db, courtId, startTime, endTime, excludeBatchId = null, schedule = {}) {
  const { daysOfWeek = [1, 2, 3, 4, 5, 6, 7], effectiveFrom = null, effectiveTo = null } = schedule;
  return (await db.query(`
    SELECT id, name, batch_type, to_char(start_time, 'HH24:MI') AS start_hhmm, to_char(end_time, 'HH24:MI') AS end_hhmm
    FROM owner_batches
    WHERE court_id = $1 AND status = 'ACTIVE' AND ($4::text IS NULL OR id <> $4)
      AND start_time < $3::time AND end_time > $2::time
      AND days_of_week && $5::smallint[]
      AND ($7::date IS NULL OR effective_from IS NULL OR effective_from <= $7::date)
      AND ($6::date IS NULL OR effective_to IS NULL OR effective_to >= $6::date)
    ORDER BY start_time LIMIT 1`, [courtId, startTime, endTime, excludeBatchId, daysOfWeek, effectiveFrom, effectiveTo])).rows[0];
}

export async function countActiveOnCourt(db, courtId) {
  return (await db.query("SELECT COUNT(*)::int AS n FROM owner_batches WHERE court_id = $1 AND status = 'ACTIVE'", [courtId])).rows[0].n;
}

export async function lockCourt(db, profileId, courtId) {
  return (await db.query(`
    SELECT c.* FROM owner_courts c JOIN owner_academies a ON a.id = c.academy_id
    WHERE c.id = $2 AND a.owner_profile_id = $1 FOR UPDATE OF c`, [profileId, courtId])).rows[0];
}
