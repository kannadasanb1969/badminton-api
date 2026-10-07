// Owner booking persistence. Every read joins booking -> academy -> owner profile, so an id alone never reaches
// another Owner's data. Writes that change a court's day must already hold repo.lockCourtDay (owner-availability).
const SELECT = `
  SELECT o.id, o.academy_id, o.court_id, c.name AS court_name, to_char(o.booking_date, 'YYYY-MM-DD') AS booking_date,
    to_char(o.start_time, 'HH24:MI') AS s, to_char(o.end_time, 'HH24:MI') AS e, o.customer_name, o.customer_mobile,
    o.booking_amount::text AS booking_amount,
    COALESCE((SELECT SUM(bp.amount) FROM owner_booking_payments bp WHERE bp.booking_id = o.id), 0)::numeric(12, 2)::text AS total_paid, o.status, o.created_at, o.updated_at, o.cancelled_at, o.cancellation_reason
  FROM owner_bookings o JOIN owner_courts c ON c.id = o.court_id JOIN owner_academies a ON a.id = o.academy_id`;

export async function insertBooking(db, v) {
  return (await db.query(`
    INSERT INTO owner_bookings (academy_id, court_id, booking_date, start_time, end_time, status, customer_name, customer_mobile, booking_amount, created_by)
    VALUES ($1,$2,$3::date,$4::time,$5::time,'CONFIRMED',$6,$7,$8::numeric,$9) RETURNING id`,
  [v.academyId, v.courtId, v.date, v.startTime, v.endTime, v.customerName, v.customerMobile, v.amount, v.createdBy])).rows[0].id;
}

export async function findForOwner(db, profileId, bookingId) {
  return (await db.query(`${SELECT} WHERE o.id = $2 AND a.owner_profile_id = $1`, [profileId, bookingId])).rows[0];
}

// view: upcoming = PENDING/CONFIRMED not yet ended; history = PENDING/CONFIRMED already ended; cancelled = CANCELLED.
export async function list(db, profileId, f, nowYmd, nowHhmm) {
  const values = [profileId, nowYmd, nowHhmm];
  // $2/$3 (Owner "now") are always referenced so Postgres can type them even when no view filter is used.
  const where = ["a.owner_profile_id = $1", "$2::date IS NOT NULL AND $3::time IS NOT NULL"];
  const add = (sql, v) => { values.push(v); where.push(sql.replace("?", `$${values.length}`)); };
  if (f.academyId) add("o.academy_id = ?", f.academyId);
  if (f.courtId) add("o.court_id = ?", f.courtId);
  if (f.date) add("o.booking_date = ?::date", f.date);
  if (f.fromDate) add("o.booking_date >= ?::date", f.fromDate);
  if (f.toDate) add("o.booking_date <= ?::date", f.toDate);
  if (f.status) add("o.status = ?", f.status);
  const notEnded = "(o.booking_date > $2::date OR (o.booking_date = $2::date AND o.end_time > $3::time))";
  if (f.view === "upcoming") where.push(`o.status IN ('PENDING','CONFIRMED') AND ${notEnded}`);
  if (f.view === "history") where.push(`o.status IN ('PENDING','CONFIRMED') AND NOT ${notEnded}`);
  if (f.view === "cancelled") where.push("o.status = 'CANCELLED'");
  const order = f.view === "upcoming" ? "o.booking_date, o.start_time, o.id" : "o.booking_date DESC, o.start_time DESC, o.id";
  return (await db.query(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT 500`, values)).rows;
}

export async function cancel(db, bookingId, profileId, reason) {
  await db.query(`
    UPDATE owner_bookings SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2, cancellation_reason = $3, updated_at = NOW()
    WHERE id = $1`, [bookingId, profileId, reason]);
}
