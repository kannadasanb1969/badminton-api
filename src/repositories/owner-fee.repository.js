// Fee-engine persistence (rates, leave, monthly obligations). Every read/write that takes a profileId joins through
// academy -> owner profile, so an id alone never grants access to another Owner's financial records.

const YMD = (col) => `to_char(${col}, 'YYYY-MM-DD')`;

// Serialises every Phase-5 write for one academy (generate / leave / rate change). Always taken FIRST.
export async function lockAcademy(db, profileId, academyId) {
  return (await db.query("SELECT * FROM owner_academies WHERE id = $2 AND owner_profile_id = $1 FOR UPDATE", [profileId, academyId])).rows[0];
}

export async function batchForOwner(db, profileId, batchId, lock = false) {
  return (await db.query(`
    SELECT b.* FROM owner_batches b JOIN owner_academies a ON a.id = b.academy_id
    WHERE b.id = $2 AND a.owner_profile_id = $1${lock ? " FOR UPDATE OF b" : ""}`, [profileId, batchId])).rows[0];
}

const RATE_COLS = `r.id, r.batch_id, r.fee_amount::text AS fee_amount, ${YMD("r.effective_from")} AS effective_from, ${YMD("r.effective_to")} AS effective_to`;

export async function listRates(db, batchId) {
  return (await db.query(`SELECT ${RATE_COLS} FROM owner_fee_rates r WHERE r.batch_id = $1 ORDER BY r.effective_from DESC`, [batchId])).rows;
}

// The rate in force on a given date (callers pass the FIRST DAY of the fee month). Periods never overlap, so <= 1 row.
export async function rateAt(db, batchId, ymd) {
  return (await db.query(`
    SELECT ${RATE_COLS} FROM owner_fee_rates r
    WHERE r.batch_id = $1 AND r.effective_from <= $2::date AND (r.effective_to IS NULL OR r.effective_to >= $2::date)`, [batchId, ymd])).rows[0];
}

export async function insertRate(db, batchId, feeAmount, effectiveFrom, effectiveTo = null) {
  return (await db.query(`
    INSERT INTO owner_fee_rates (batch_id, fee_amount, effective_from, effective_to) VALUES ($1, $2::numeric, $3::date, $4::date)
    RETURNING id`, [batchId, feeAmount, effectiveFrom, effectiveTo])).rows[0].id;
}

export async function closeRate(db, rateId, effectiveTo) {
  await db.query("UPDATE owner_fee_rates SET effective_to = $2::date, updated_at = NOW() WHERE id = $1", [rateId, effectiveTo]);
}

// ---- memberships / leave -------------------------------------------------------------------------------------------

export async function membershipForOwner(db, profileId, membershipId) {
  return (await db.query(`
    SELECT ms.id, ms.batch_id, ms.status, ${YMD("ms.start_date")} AS start_ymd, ${YMD("ms.end_date")} AS end_ymd,
      m.id AS member_id, m.name AS member_name, m.academy_id, b.name AS batch_name, b.batch_type
    FROM owner_memberships ms JOIN owner_members m ON m.id = ms.member_id JOIN owner_batches b ON b.id = ms.batch_id
    JOIN owner_academies a ON a.id = m.academy_id
    WHERE ms.id = $2 AND a.owner_profile_id = $1`, [profileId, membershipId])).rows[0];
}

export async function listLeaves(db, membershipId) {
  return (await db.query(`
    SELECT id, membership_id, ${YMD("fee_month")} AS fee_month, note FROM owner_monthly_leaves
    WHERE membership_id = $1 ORDER BY fee_month DESC`, [membershipId])).rows;
}

export async function leavesForMember(db, memberId) {
  return (await db.query(`
    SELECT l.membership_id, ${YMD("l.fee_month")} AS fee_month FROM owner_monthly_leaves l
    JOIN owner_memberships ms ON ms.id = l.membership_id WHERE ms.member_id = $1 ORDER BY l.fee_month`, [memberId])).rows;
}

export async function findLeave(db, membershipId, feeMonth) {
  return (await db.query("SELECT id FROM owner_monthly_leaves WHERE membership_id = $1 AND fee_month = $2::date", [membershipId, feeMonth])).rows[0];
}

export async function insertLeave(db, membershipId, feeMonth, note) {
  return (await db.query(`
    INSERT INTO owner_monthly_leaves (membership_id, fee_month, note) VALUES ($1, $2::date, $3)
    RETURNING id, membership_id, ${YMD("fee_month")} AS fee_month, note`, [membershipId, feeMonth, note])).rows[0];
}

export async function deleteLeave(db, leaveId) {
  await db.query("DELETE FROM owner_monthly_leaves WHERE id = $1", [leaveId]);
}

// ---- monthly fees --------------------------------------------------------------------------------------------------

export async function findFee(db, membershipId, feeMonth, lock = false) {
  return (await db.query(`
    SELECT id, membership_id, applicable_fee::text AS applicable_fee, status FROM owner_monthly_fees
    WHERE membership_id = $1 AND fee_month = $2::date${lock ? " FOR UPDATE" : ""}`, [membershipId, feeMonth])).rows[0];
}

// A monthly fee is financially locked as soon as ANY payment allocation exists for it. Locked fees are never rewritten
// (leave, recalculation, regeneration or fee-rate changes). Callers hold the academy lock and the fee row lock, and
// the allocation guard trigger serialises on the same fee row, so the answer cannot change under the caller.
export async function isFeeLocked(db, feeId) {
  return (await db.query("SELECT EXISTS (SELECT 1 FROM owner_payment_allocations WHERE monthly_fee_id = $1) AS locked", [feeId])).rows[0].locked;
}

export async function reconcileFee(db, feeId, { applicableFee, status, feeRateId }) {
  // Second line of defence behind isFeeLocked(): the statement itself refuses to touch a fee that has allocations.
  const res = await db.query(`
    UPDATE owner_monthly_fees SET applicable_fee = $2::numeric, status = $3, fee_rate_id = $4, updated_at = NOW()
    WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM owner_payment_allocations a WHERE a.monthly_fee_id = $1)`,
    [feeId, applicableFee, status, feeRateId]);
  if (res.rowCount !== 1) throw new Error("monthly fee is financially locked");
}

// Membership/month intersection, shared by generation and reporting: started on or before the month's last day AND not
// ended before the month's first day. Parameters: $2 = first day of month, $3 = last day of month.
const ELIGIBLE_SQL = "ms.start_date <= $3::date AND (ms.end_date IS NULL OR ms.end_date >= $2::date)";

// Everything needed to decide, per membership, what generation must do for one academy-month. Membership/month
// intersection: started on or before the month's last day AND not ended before the month's first day.
export async function generationCandidates(db, academyId, monthStart, monthEnd) {
  return (await db.query(`
    SELECT ms.id AS membership_id, m.name AS member_name, b.name AS batch_name, b.batch_type,
      (f.id IS NOT NULL) AS has_fee, (l.id IS NOT NULL) AS has_leave, r.id AS rate_id, r.fee_amount::text AS fee_amount
    FROM owner_memberships ms
    JOIN owner_members m ON m.id = ms.member_id
    JOIN owner_batches b ON b.id = ms.batch_id
    LEFT JOIN owner_monthly_fees f ON f.membership_id = ms.id AND f.fee_month = $2::date
    LEFT JOIN owner_monthly_leaves l ON l.membership_id = ms.id AND l.fee_month = $2::date
    LEFT JOIN owner_fee_rates r ON r.batch_id = b.id AND r.effective_from <= $2::date AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
    WHERE m.academy_id = $1 AND ${ELIGIBLE_SQL}
    ORDER BY m.name, b.name, ms.id`, [academyId, monthStart, monthEnd])).rows;
}

// Set-based insert; ON CONFLICT is the final guard against duplicates (the academy lock normally prevents them).
export async function insertFees(db, feeMonth, rows) {
  if (!rows.length) return 0;
  const res = await db.query(`
    INSERT INTO owner_monthly_fees (membership_id, fee_month, applicable_fee, status, fee_rate_id)
    SELECT t.membership_id, $1::date, t.fee::numeric, t.status, t.rate_id
    FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(membership_id, fee, status, rate_id)
    ON CONFLICT (membership_id, fee_month) DO NOTHING`,
  [feeMonth, rows.map((r) => r.membershipId), rows.map((r) => r.applicableFee), rows.map((r) => r.status), rows.map((r) => r.feeRateId)]);
  return res.rowCount;
}

const PAID_SQL = "COALESCE((SELECT SUM(a.amount) FROM owner_payment_allocations a WHERE a.monthly_fee_id = f.id), 0)";

// Scope filters (month, court, batch, type, member) apply to BOTH the summary and the list, so a filtered list never sits next to
// global totals. View filters (status, outstanding) narrow only the list: the summary keeps showing every status count.
function feeFilters(profileId, f, { view }) {
  const values = [profileId];
  let where = "a.owner_profile_id = $1";
  const scope = [["m.academy_id", "academyId", ""], ["f.fee_month", "feeMonth", "::date"], ["m.id", "memberId", ""], ["b.id", "batchId", ""],
    ["c.id", "courtId", ""], ["b.batch_type", "type", ""]];
  const narrow = view ? [["f.status", "status", ""]] : [];
  for (const [column, key, cast] of [...scope, ...narrow]) {
    if (f[key]) { values.push(f[key]); where += ` AND ${column} = $${values.length}${cast}`; }
  }
  // outstanding = still owes money: not on leave, not fully paid
  if (view && f.outstanding) where += ` AND f.status IN ('PENDING', 'PARTIALLY_PAID') AND f.applicable_fee > ${PAID_SQL}`;
  return { where, values };
}
const FEE_FROM = `FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id = f.membership_id JOIN owner_members m ON m.id = ms.member_id
  JOIN owner_academies a ON a.id = m.academy_id JOIN owner_batches b ON b.id = ms.batch_id JOIN owner_courts c ON c.id = b.court_id`;

// Oldest fee month first, then member name, then a stable tiebreak. `limit` is optional (dashboard "needs attention").
export async function listFees(db, profileId, filters, { limit = null } = {}) {
  const { where, values } = feeFilters(profileId, filters, { view: true });
  let tail = "";
  if (limit) { values.push(limit); tail = ` LIMIT $${values.length}`; }
  return (await db.query(`
    SELECT f.id, f.membership_id, ${YMD("f.fee_month")} AS fee_month, f.applicable_fee::text AS applicable_fee, f.status,
      (${PAID_SQL})::numeric(12, 2)::text AS paid_amount, (f.applicable_fee - ${PAID_SQL})::numeric(12, 2)::text AS balance,
      m.id AS member_id, m.name AS member_name, m.mobile AS member_mobile, b.id AS batch_id, b.name AS batch_name, b.batch_type,
      c.id AS court_id, c.name AS court_name
    ${FEE_FROM} WHERE ${where} ORDER BY f.fee_month, lower(m.name), b.name, f.id${tail}`, values)).rows;
}

// Expected Collection = SUM(applicable_fee) (ON_LEAVE rows are 0). Collected = SUM of allocations applied to these fees:
// unused member credit is NOT collected for a month until it is allocated to that month's obligation.
// Outstanding = Expected - Collected.
export async function summarizeFees(db, profileId, filters) {
  const { where, values } = feeFilters(profileId, filters, { view: false });
  return (await db.query(`
    WITH x AS (SELECT f.applicable_fee, f.status, ${PAID_SQL} AS paid ${FEE_FROM} WHERE ${where})
    SELECT COALESCE(SUM(applicable_fee), 0)::numeric(14, 2)::text AS expected_collection,
      COALESCE(SUM(paid), 0)::numeric(14, 2)::text AS collected,
      (COALESCE(SUM(applicable_fee), 0) - COALESCE(SUM(paid), 0))::numeric(14, 2)::text AS outstanding,
      COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending_count,
      COUNT(*) FILTER (WHERE status = 'PARTIALLY_PAID')::int AS partially_paid_count,
      COUNT(*) FILTER (WHERE status = 'PAID')::int AS paid_count,
      COUNT(*) FILTER (WHERE status = 'ON_LEAVE')::int AS on_leave_count, COUNT(*)::int AS total_count
    FROM x`, values)).rows[0];
}

// Eligible memberships that have no monthly obligation yet. Derived from membership dates (never today's status) minus the
// canonical fee rows, so history is not rewritten. `missing_rate` = nothing can be generated for them: no leave and no
// Owner-defined fee rate in force on the 1st. Scope filters: court / batch / type / member (academy and month are required).
export async function notGenerated(db, academyId, monthStart, monthEnd, f = {}, { limit = 10 } = {}) {
  const values = [academyId, monthStart, monthEnd];
  let where = `m.academy_id = $1 AND ${ELIGIBLE_SQL} AND f.id IS NULL`;
  for (const [column, key] of [["c.id", "courtId"], ["b.id", "batchId"], ["b.batch_type", "type"], ["m.id", "memberId"]]) {
    if (f[key]) { values.push(f[key]); where += ` AND ${column} = $${values.length}`; }
  }
  const from = `FROM owner_memberships ms JOIN owner_members m ON m.id = ms.member_id JOIN owner_batches b ON b.id = ms.batch_id
    JOIN owner_courts c ON c.id = b.court_id
    LEFT JOIN owner_monthly_fees f ON f.membership_id = ms.id AND f.fee_month = $2::date
    LEFT JOIN owner_monthly_leaves l ON l.membership_id = ms.id AND l.fee_month = $2::date
    LEFT JOIN owner_fee_rates r ON r.batch_id = b.id AND r.effective_from <= $2::date AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
    WHERE ${where}`;
  const counts = (await db.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE l.id IS NULL AND r.id IS NULL)::int AS missing_rate ${from}`, values)).rows[0];
  const lim = [...values, limit];
  // Always issued (even when empty) so the dashboard runs a fixed number of queries.
  const items = (await db.query(`
    SELECT ms.id AS membership_id, m.id AS member_id, m.name AS member_name, m.mobile AS member_mobile, b.id AS batch_id, b.name AS batch_name,
      b.batch_type, c.name AS court_name, (l.id IS NULL AND r.id IS NULL) AS missing_rate
    ${from} ORDER BY lower(m.name), b.name, ms.id LIMIT $${lim.length}`, lim)).rows;
  return { ...counts, items };
}

// Per-member roll-up for the same scope as the Fees list (month / court / batch / type). Used to tell "nothing to remind because it is
// paid" from "because it is on leave" without loading every obligation.
export async function memberFeeStates(db, profileId, filters) {
  const { where, values } = feeFilters(profileId, filters, { view: false });
  return (await db.query(`
    WITH x AS (SELECT m.id AS member_id, f.status, f.applicable_fee, ${PAID_SQL} AS paid ${FEE_FROM} WHERE ${where})
    SELECT member_id,
      bool_or(status IN ('PENDING', 'PARTIALLY_PAID') AND applicable_fee > paid) AS has_outstanding,
      bool_or(status = 'ON_LEAVE') AS has_leave
    FROM x GROUP BY member_id`, values)).rows;
}
