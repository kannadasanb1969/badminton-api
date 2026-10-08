// Booking-payment persistence (Phase 9.3). Reads join payment -> academy -> owner profile, so an id alone never reaches another
// Owner's money. Writes only INSERT: rows are immutable (also enforced by triggers). Separate from the Phase 6 member-fee tables.
const YMD = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const HHMM = (col) => `to_char(${col}, 'HH24:MI')`;

// Lock a booking row (scoped to the Owner). FIRST lock of every payment write; the receipt counter is taken after it.
// Cancellation takes court-day lock -> this row, and never the counter, so the two orders cannot form a cycle.
export async function lockBooking(db, profileId, bookingId) {
  return (await db.query(`
    SELECT o.id FROM owner_bookings o JOIN owner_academies a ON a.id = o.academy_id
    WHERE o.id = $2 AND a.owner_profile_id = $1 FOR UPDATE OF o`, [profileId, bookingId])).rows[0];
}

// Gapless per-academy, per-year receipt counter (booking receipts: SPB-). The upsert row lock is held until commit, so a
// rolled-back payment releases its number and concurrent issuers are serialised.
export async function nextReceiptNumber(db, academyId, year) {
  const n = (await db.query(`
    INSERT INTO owner_booking_receipt_counters (academy_id, receipt_year, last_number) VALUES ($1, $2, 1)
    ON CONFLICT (academy_id, receipt_year) DO UPDATE SET last_number = owner_booking_receipt_counters.last_number + 1
    RETURNING last_number`, [academyId, year])).rows[0].last_number;
  return `SPB-${year}-${String(n).padStart(6, "0")}`;
}

// The snapshot columns are computed by the DB guard trigger; only the facts of the payment are passed in.
export async function insertPayment(db, p) {
  return (await db.query(`
    INSERT INTO owner_booking_payments (academy_id, booking_id, receipt_number, amount, payment_mode, payment_date, reference_number, note, created_by_user_id)
    VALUES ($1, $2, $3, $4::numeric, $5, $6::date, $7, $8, $9) RETURNING id`,
  [p.academyId, p.bookingId, p.receiptNumber, p.amount, p.paymentMode, p.paymentDate, p.referenceNumber, p.note, p.userId])).rows[0].id;
}

const COLS = `p.id, p.booking_id, p.academy_id, p.receipt_number, p.amount::text AS amount, p.payment_mode, ${YMD("p.payment_date")} AS payment_date,
  p.reference_number, p.note, p.booking_amount_snapshot::text AS booking_amount, p.total_paid_after::text AS total_paid_after,
  p.balance_after::text AS balance_after, p.payment_status_after, p.created_at,
  o.customer_name, o.customer_mobile, ${YMD("o.booking_date")} AS booking_date, ${HHMM("o.start_time")} AS s, ${HHMM("o.end_time")} AS e,
  o.status AS booking_status, c.name AS court_name, a.name AS academy_name`;
const FROM = `FROM owner_booking_payments p JOIN owner_bookings o ON o.id = p.booking_id JOIN owner_courts c ON c.id = o.court_id
  JOIN owner_academies a ON a.id = p.academy_id`;

export async function getForOwner(db, profileId, paymentId) {
  return (await db.query(`SELECT ${COLS} ${FROM} WHERE p.id = $2 AND a.owner_profile_id = $1`, [profileId, paymentId])).rows[0];
}

// Newest first (created_at, then id as a stable tie-break).
export async function listForBooking(db, profileId, bookingId) {
  return (await db.query(`SELECT ${COLS} ${FROM} WHERE p.booking_id = $2 AND a.owner_profile_id = $1 ORDER BY p.created_at DESC, p.id DESC`, [profileId, bookingId])).rows;
}
