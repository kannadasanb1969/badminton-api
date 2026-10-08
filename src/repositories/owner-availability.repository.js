// Persistence for the Owner availability engine: blockers for one court + calendar date, release exceptions,
// block rows, and the lock used by every write that changes a court's day.
//
// BLOCKING RULES (single source of truth, used by availability, conflict checks, blocks, release/restore):
//   owner_batches          status = ACTIVE, ISO weekday in days_of_week, date inside [effective_from, effective_to]
//                          (NULL bound = unbounded) and NO ACTIVE release exception for that batch/date
//   owner_bookings         status IN (PENDING, CONFIRMED)   -- CANCELLED never blocks
//   owner_court_blocks     status = ACTIVE                  -- CANCELLED never blocks
const HHMM = (col) => `to_char(${col}, 'HH24:MI')`;

const BATCH_APPLIES = `
  b.court_id = $1 AND b.status = 'ACTIVE'
  AND extract(isodow FROM $2::date)::smallint = ANY(b.days_of_week)
  AND (b.effective_from IS NULL OR $2::date >= b.effective_from)
  AND (b.effective_to IS NULL OR $2::date <= b.effective_to)`;

// Lock for any write that changes what is occupied on (court, date): shared lock on the court row (so batch
// writes, which take it FOR UPDATE, are excluded) + a transaction-level advisory lock on court+date (so writers on
// the SAME day serialise while other dates and other courts proceed). Always taken in this order.
export async function lockCourtDay(db, profileId, courtId, date) {
  const court = (await db.query(`
    SELECT c.*, a.status AS academy_status FROM owner_courts c JOIN owner_academies a ON a.id = c.academy_id
    WHERE c.id = $2 AND a.owner_profile_id = $1 FOR SHARE OF c`, [profileId, courtId])).rows[0];
  if (!court) return undefined;
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`owner-court-day:${courtId}:${date}`]);
  return court;
}

export async function findCourtForOwner(db, profileId, courtId) {
  return (await db.query(`
    SELECT c.*, a.status AS academy_status FROM owner_courts c JOIN owner_academies a ON a.id = c.academy_id
    WHERE c.id = $2 AND a.owner_profile_id = $1`, [profileId, courtId])).rows[0];
}

// Everything that occupies the court on `date`, as common blocker rows.
export async function dayBlockers(db, courtId, date) {
  const batches = (await db.query(`
    SELECT b.id, b.batch_type, b.name, ${HHMM("b.start_time")} AS s, ${HHMM("b.end_time")} AS e
    FROM owner_batches b
    WHERE ${BATCH_APPLIES}
      AND NOT EXISTS (SELECT 1 FROM owner_batch_exceptions x WHERE x.batch_id = b.id AND x.exception_date = $2::date AND x.status = 'ACTIVE')
    ORDER BY b.start_time, b.id`, [courtId, date])).rows;
  const bookings = (await db.query(`
    SELECT id, customer_name, ${HHMM("start_time")} AS s, ${HHMM("end_time")} AS e FROM owner_bookings
    WHERE court_id = $1 AND booking_date = $2::date AND status IN ('PENDING', 'CONFIRMED') ORDER BY start_time, id`, [courtId, date])).rows;
  const blocks = (await db.query(`
    SELECT id, reason, ${HHMM("start_time")} AS s, ${HHMM("end_time")} AS e FROM owner_court_blocks
    WHERE court_id = $1 AND block_date = $2::date AND status = 'ACTIVE' ORDER BY start_time, id`, [courtId, date])).rows;
  return { batches, bookings, blocks };
}

// Applicable batches that are currently released on `date` (still ACTIVE batches; only the occurrence is released).
export async function releasedBatches(db, courtId, date) {
  return (await db.query(`
    SELECT b.id, b.batch_type, b.name, ${HHMM("b.start_time")} AS s, ${HHMM("b.end_time")} AS e, x.reason, x.id AS exception_id
    FROM owner_batches b JOIN owner_batch_exceptions x ON x.batch_id = b.id AND x.exception_date = $2::date AND x.status = 'ACTIVE'
    WHERE ${BATCH_APPLIES} ORDER BY b.start_time, b.id`, [courtId, date])).rows;
}

// Booking + block blockers only (used by Restore: a batch occurrence must not be re-imposed over them).
export async function nonBatchBlockers(db, courtId, date) {
  const { bookings, blocks } = await dayBlockers(db, courtId, date);
  return { bookings, blocks };
}

export async function insertBlock(db, v) {
  return (await db.query(`
    INSERT INTO owner_court_blocks (academy_id, court_id, block_date, start_time, end_time, reason, created_by)
    VALUES ($1,$2,$3::date,$4::time,$5::time,$6,$7) RETURNING id`,
  [v.academyId, v.courtId, v.date, v.startTime, v.endTime, v.reason, v.createdBy])).rows[0].id;
}

const BLOCK_SELECT = `
  SELECT k.id, k.academy_id, k.court_id, c.name AS court_name, to_char(k.block_date, 'YYYY-MM-DD') AS block_date,
    ${HHMM("k.start_time")} AS s, ${HHMM("k.end_time")} AS e, k.reason, k.status, k.created_at, k.updated_at, k.cancelled_at
  FROM owner_court_blocks k JOIN owner_courts c ON c.id = k.court_id JOIN owner_academies a ON a.id = k.academy_id`;

export async function findBlockForOwner(db, profileId, blockId) {
  return (await db.query(`${BLOCK_SELECT} WHERE k.id = $2 AND a.owner_profile_id = $1`, [profileId, blockId])).rows[0];
}

export async function listBlocks(db, profileId, f) {
  const values = [profileId];
  const where = ["a.owner_profile_id = $1"];
  const add = (sql, v) => { values.push(v); where.push(sql.replace("?", `$${values.length}`)); };
  if (f.academyId) add("k.academy_id = ?", f.academyId);
  if (f.courtId) add("k.court_id = ?", f.courtId);
  if (f.date) add("k.block_date = ?::date", f.date);
  if (f.from) add("k.block_date >= ?::date", f.from);
  if (f.to) add("k.block_date <= ?::date", f.to);
  if (f.status) add("k.status = ?", f.status);
  return (await db.query(`${BLOCK_SELECT} WHERE ${where.join(" AND ")} ORDER BY k.block_date, k.start_time, k.id`, values)).rows;
}

export async function cancelBlock(db, blockId) {
  await db.query("UPDATE owner_court_blocks SET status = 'CANCELLED', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1", [blockId]);
}

// ----- batch release exceptions -----
export async function findLiveRelease(db, batchId, date) {
  return (await db.query("SELECT * FROM owner_batch_exceptions WHERE batch_id = $1 AND exception_date = $2::date AND status = 'ACTIVE'", [batchId, date])).rows[0];
}
export async function insertRelease(db, v) {
  return (await db.query(`
    INSERT INTO owner_batch_exceptions (academy_id, batch_id, exception_date, reason, created_by)
    VALUES ($1,$2,$3::date,$4,$5) RETURNING id`, [v.academyId, v.batchId, v.date, v.reason, v.createdBy])).rows[0].id;
}
export async function restoreRelease(db, exceptionId) {
  await db.query("UPDATE owner_batch_exceptions SET status = 'RESTORED', restored_at = NOW() WHERE id = $1", [exceptionId]);
}

// A schedule being created/changed for a batch must not silently collide with future court blocks or bookings
// (those only ever coexisted with a batch by being created while it was absent or released).
// Returns the first colliding blocker on or after `fromDate`, honouring this batch's own release exceptions.
export async function findScheduleCollision(db, v) {
  const { courtId, startTime, endTime, daysOfWeek, effectiveFrom, effectiveTo, fromDate, excludeBatchId } = v;
  const common = (dateCol) => `
    ${dateCol} >= GREATEST($6::date, COALESCE($4::date, $6::date)) AND ($5::date IS NULL OR ${dateCol} <= $5::date)
    AND extract(isodow FROM ${dateCol})::smallint = ANY($7::smallint[])`;
  const row = (await db.query(`
    SELECT type, to_char(d, 'YYYY-MM-DD') AS ymd, label, s, e FROM (
      SELECT 'COURT_BLOCK' AS type, k.block_date AS d, COALESCE(k.reason, 'Court block') AS label, ${HHMM("k.start_time")} AS s, ${HHMM("k.end_time")} AS e
      FROM owner_court_blocks k WHERE k.court_id = $1 AND k.status = 'ACTIVE' AND ${common("k.block_date")}
        AND k.start_time < $3::time AND k.end_time > $2::time
      UNION ALL
      SELECT 'BOOKING', o.booking_date, 'Booking', ${HHMM("o.start_time")}, ${HHMM("o.end_time")}
      FROM owner_bookings o WHERE o.court_id = $1 AND o.status IN ('PENDING','CONFIRMED') AND ${common("o.booking_date")}
        AND o.start_time < $3::time AND o.end_time > $2::time
    ) u WHERE NOT EXISTS (SELECT 1 FROM owner_batch_exceptions x WHERE x.batch_id = $8::text AND x.exception_date = u.d AND x.status = 'ACTIVE')
    ORDER BY d LIMIT 1`, [courtId, startTime, endTime, effectiveFrom, effectiveTo, fromDate, daysOfWeek, excludeBatchId])).rows[0];
  return row;
}
