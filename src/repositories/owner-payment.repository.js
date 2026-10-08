// Payment persistence. Reads that take a profileId join through academy -> owner profile, so an id alone never grants
// access to another Owner's money. Writes only INSERT: payments and allocations are immutable (also enforced by triggers).

const YMD = (col) => `to_char(${col}, 'YYYY-MM-DD')`;
const ALLOCATED = "COALESCE((SELECT SUM(al.amount) FROM owner_payment_allocations al WHERE al.payment_id = p.id), 0)";
const PAID = "COALESCE((SELECT SUM(a.amount) FROM owner_payment_allocations a WHERE a.monthly_fee_id = f.id), 0)";

// ---- locking (two statements on purpose: rows are locked first, then read with a FRESH snapshot, so balances are
// never evaluated against a stale snapshot after waiting on a lock) --------------------------------------------------

// Lock every monthly fee of a member in a deterministic order (fee_month, id).
export async function lockMemberFees(db, memberId) {
  await db.query(`
    SELECT f.id FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id
    WHERE ms.member_id = $1 ORDER BY f.fee_month, f.id FOR UPDATE OF f`, [memberId]);
}

// Lock every payment of a member in a deterministic order (payment_date, created_at, id): oldest credit is consumed first.
export async function lockMemberPayments(db, memberId) {
  await db.query("SELECT id FROM owner_payments WHERE member_id = $1 ORDER BY payment_date, created_at, id FOR UPDATE", [memberId]);
}

export async function memberFeeBalances(db, memberId) {
  return (await db.query(`
    SELECT f.id, ${YMD("f.fee_month")} AS fee_month, f.applicable_fee::text AS applicable_fee, f.status, (${PAID})::numeric(12, 2)::text AS paid,
      b.name AS batch_name, b.batch_type
    FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id JOIN owner_batches b ON b.id = ms.batch_id
    WHERE ms.member_id = $1 ORDER BY f.fee_month, f.id`, [memberId])).rows;
}

// Scope check used to tell "not yours" (404) apart from "yours but another member's" (409).
export async function feeOwnerScope(db, profileId, feeId) {
  return (await db.query(`
    SELECT ms.member_id FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id
    JOIN owner_members m ON m.id = ms.member_id JOIN owner_academies a ON a.id = m.academy_id
    WHERE f.id = $2 AND a.owner_profile_id = $1`, [profileId, feeId])).rows[0];
}

// Payments of a member that still hold unallocated money, oldest first.
export async function creditSources(db, memberId) {
  return (await db.query(`
    SELECT p.id, p.receipt_number, ${YMD("p.payment_date")} AS payment_date, (p.amount - ${ALLOCATED})::text AS unallocated
    FROM owner_payments p WHERE p.member_id = $1 AND p.amount > ${ALLOCATED}
    ORDER BY p.payment_date, p.created_at, p.id`, [memberId])).rows;
}

// ---- writes -------------------------------------------------------------------------------------------------------

// Gapless per-academy, per-year receipt counter. The upsert takes a row lock held until the payment transaction ends.
export async function nextReceiptNumber(db, academyId, year) {
  const n = (await db.query(`
    INSERT INTO owner_receipt_counters (academy_id, receipt_year, last_number) VALUES ($1, $2, 1)
    ON CONFLICT (academy_id, receipt_year) DO UPDATE SET last_number = owner_receipt_counters.last_number + 1
    RETURNING last_number`, [academyId, year])).rows[0].last_number;
  return `SPO-${year}-${String(n).padStart(6, "0")}`;
}

export async function insertPayment(db, p) {
  await db.query(`
    INSERT INTO owner_payments (id, academy_id, member_id, receipt_number, amount, payment_mode, payment_date, reference, note, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::date, $8, $9, $10)`,
  [p.id, p.academyId, p.memberId, p.receiptNumber, p.amount, p.paymentMode, p.paymentDate, p.reference, p.note, p.userId]);
}

// One statement; the allocation guard/status triggers run per row, in array order. Returns the new allocation ids.
export async function insertAllocations(db, rows) {
  if (!rows.length) return [];
  const res = await db.query(`
    INSERT INTO owner_payment_allocations (payment_id, monthly_fee_id, amount)
    SELECT t.payment_id, t.fee_id, t.amount::numeric
    FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS t(payment_id, fee_id, amount, ord) ORDER BY t.ord
    RETURNING id`,
  [rows.map((r) => r.paymentId), rows.map((r) => r.feeId), rows.map((r) => r.amount)]);
  return res.rows.map((r) => r.id);
}

// ---- reads --------------------------------------------------------------------------------------------------------

const PAYMENT_COLS = `p.id, p.academy_id, p.member_id, p.receipt_number, p.amount::text AS amount, p.payment_mode,
  ${YMD("p.payment_date")} AS payment_date, p.reference, p.note, p.created_at,
  (${ALLOCATED})::numeric(12, 2)::text AS allocated_amount, (p.amount - ${ALLOCATED})::text AS credit_remaining,
  m.name AS member_name, m.mobile AS member_mobile, a.name AS academy_name, a.mobile AS academy_mobile`;
const PAYMENT_FROM = "FROM owner_payments p JOIN owner_members m ON m.id = p.member_id JOIN owner_academies a ON a.id = p.academy_id";

export async function getPayment(db, profileId, paymentId) {
  return (await db.query(`SELECT ${PAYMENT_COLS} ${PAYMENT_FROM} WHERE p.id = $2 AND a.owner_profile_id = $1`, [profileId, paymentId])).rows[0];
}

export async function listPayments(db, profileId, filters = {}, limit = 100) {
  const values = [profileId];
  let where = "a.owner_profile_id = $1";
  for (const [column, key] of [["p.academy_id", "academyId"], ["p.member_id", "memberId"]]) {
    if (filters[key]) { values.push(filters[key]); where += ` AND ${column} = $${values.length}`; }
  }
  values.push(limit);
  return (await db.query(`SELECT ${PAYMENT_COLS} ${PAYMENT_FROM} WHERE ${where} ORDER BY p.payment_date DESC, p.created_at DESC, p.id LIMIT $${values.length}`, values)).rows;
}

// Allocation breakdown with the fee's CURRENT paid/balance/status. Select by payment ids or by allocation ids.
const ALLOCATION_SELECT = `
    SELECT al.id, al.payment_id, al.monthly_fee_id, al.amount::text AS amount, al.created_at, ${YMD("f.fee_month")} AS fee_month,
      f.applicable_fee::text AS applicable_fee, f.status AS fee_status, (f.applicable_fee - ${PAID})::text AS remaining_balance,
      b.name AS batch_name, b.batch_type, p.receipt_number
    FROM owner_payment_allocations al JOIN owner_monthly_fees f ON f.id = al.monthly_fee_id
    JOIN owner_memberships ms ON ms.id = f.membership_id JOIN owner_batches b ON b.id = ms.batch_id
    JOIN owner_payments p ON p.id = al.payment_id`;

export async function allocationsFor(db, paymentIds) {
  if (!paymentIds.length) return [];
  return (await db.query(`${ALLOCATION_SELECT} WHERE al.payment_id = ANY($1) ORDER BY f.fee_month, al.created_at, al.id`, [paymentIds])).rows;
}

export async function allocationsByIds(db, ids) {
  if (!ids.length) return [];
  return (await db.query(`${ALLOCATION_SELECT} WHERE al.id = ANY($1) ORDER BY f.fee_month, al.created_at, al.id`, [ids])).rows;
}

export async function allocationsForFee(db, feeId) {
  return (await db.query(`
    SELECT al.id, al.payment_id, al.amount::text AS amount, p.receipt_number, ${YMD("p.payment_date")} AS payment_date, p.payment_mode
    FROM owner_payment_allocations al JOIN owner_payments p ON p.id = al.payment_id
    WHERE al.monthly_fee_id = $1 ORDER BY al.created_at, al.id`, [feeId])).rows;
}

export async function feeDetail(db, profileId, feeId) {
  return (await db.query(`
    SELECT f.id, f.membership_id, ${YMD("f.fee_month")} AS fee_month, f.applicable_fee::text AS applicable_fee, f.status,
      (${PAID})::numeric(12, 2)::text AS paid_amount, (f.applicable_fee - ${PAID})::text AS balance,
      m.id AS member_id, m.name AS member_name, b.id AS batch_id, b.name AS batch_name, b.batch_type, c.name AS court_name
    FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id JOIN owner_members m ON m.id = ms.member_id
    JOIN owner_academies a ON a.id = m.academy_id JOIN owner_batches b ON b.id = ms.batch_id JOIN owner_courts c ON c.id = b.court_id
    WHERE f.id = $2 AND a.owner_profile_id = $1`, [profileId, feeId])).rows[0];
}

export async function memberOutstanding(db, memberId) {
  return (await db.query(`
    SELECT COALESCE(SUM(f.applicable_fee - ${PAID}), 0)::numeric(14, 2)::text AS outstanding
    FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id
    WHERE ms.member_id = $1 AND f.status IN ('PENDING', 'PARTIALLY_PAID')`, [memberId])).rows[0].outstanding;
}

export async function memberCredit(db, memberId) {
  return (await db.query(`
    SELECT COALESCE(SUM(p.amount - ${ALLOCATED}), 0)::numeric(14, 2)::text AS credit FROM owner_payments p WHERE p.member_id = $1`, [memberId])).rows[0].credit;
}
