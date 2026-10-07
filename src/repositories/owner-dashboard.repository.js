// Read-only operational reporting. Financial totals and the fee list come from owner-fee.repository (summarizeFees / listFees /
// notGenerated) so the dashboard and the Fees screen can never disagree; this file only adds what is specific to the dashboard.
// All counts are PostgreSQL aggregates: nothing is loaded into JavaScript and summed there.

// People, not membership rows: a member with a Regular and a Coaching membership counts once in activeMembers and once in each
// category. "Active" = ACTIVE member with at least one ACTIVE membership.
export async function operations(db, academyId) {
  return (await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM owner_courts WHERE academy_id = $1 AND status = 'ACTIVE') AS active_courts,
      (SELECT COUNT(*)::int FROM owner_batches WHERE academy_id = $1 AND status = 'ACTIVE') AS active_batches,
      COUNT(DISTINCT m.id)::int AS active_members,
      COUNT(DISTINCT m.id) FILTER (WHERE b.batch_type = 'REGULAR')::int AS regular_players,
      COUNT(DISTINCT m.id) FILTER (WHERE b.batch_type = 'COACHING')::int AS coaching_students,
      COUNT(ms.id)::int AS active_memberships
    FROM owner_members m
    JOIN owner_memberships ms ON ms.member_id = m.id AND ms.status = 'ACTIVE'
    JOIN owner_batches b ON b.id = ms.batch_id
    WHERE m.academy_id = $1 AND m.status = 'ACTIVE'`, [academyId])).rows[0];
}

// Credit is derived (payment amount minus its allocations); no balance is stored. One query returns the totals (window
// aggregates over all members with credit) and the largest balances.
export async function creditSummary(db, academyId, { limit = 10 } = {}) {
  const rows = (await db.query(`
    WITH per_member AS (
      SELECT p.member_id, SUM(p.amount - COALESCE(t.used, 0)) AS credit
      FROM owner_payments p
      LEFT JOIN (SELECT payment_id, SUM(amount) AS used FROM owner_payment_allocations GROUP BY payment_id) t ON t.payment_id = p.id
      WHERE p.academy_id = $1
      GROUP BY p.member_id HAVING SUM(p.amount - COALESCE(t.used, 0)) > 0)
    SELECT m.id AS member_id, m.name AS member_name, m.mobile AS member_mobile, pm.credit::numeric(14, 2)::text AS credit,
      COUNT(*) OVER ()::int AS members_with_credit, (SUM(pm.credit) OVER ())::numeric(14, 2)::text AS total_credit
    FROM per_member pm JOIN owner_members m ON m.id = pm.member_id
    ORDER BY pm.credit DESC, lower(m.name), m.id LIMIT $2`, [academyId, limit])).rows;
  return {
    membersWithCredit: rows[0]?.members_with_credit ?? 0,
    totalAvailableCredit: rows[0]?.total_credit ?? "0.00",
    members: rows.map((r) => ({ memberId: r.member_id, memberName: r.member_name, memberMobile: r.member_mobile ?? null, availableCredit: r.credit })),
  };
}

// Newest payment transactions (actual money received; not the same thing as monthly Collected).
export async function recentPayments(db, academyId, limit) {
  return (await db.query(`
    SELECT p.id, p.receipt_number, p.amount::text AS amount, p.payment_mode, to_char(p.payment_date, 'YYYY-MM-DD') AS payment_date,
      p.created_at, m.id AS member_id, m.name AS member_name
    FROM owner_payments p JOIN owner_members m ON m.id = p.member_id
    WHERE p.academy_id = $1 ORDER BY p.payment_date DESC, p.created_at DESC, p.id LIMIT $2`, [academyId, limit])).rows;
}

// Court / batch pick-lists for the filters, limited to this academy.
export async function filterOptions(db, academyId) {
  const [courts, batches] = await Promise.all([
    db.query("SELECT id, name, status FROM owner_courts WHERE academy_id = $1 ORDER BY display_order, name, id", [academyId]),
    db.query("SELECT id, court_id, name, batch_type, status FROM owner_batches WHERE academy_id = $1 ORDER BY name, id", [academyId]),
  ]);
  return { courts: courts.rows, batches: batches.rows };
}

// Which batches still have money to collect in the selected month (scope filters applied), largest balance first.
export async function pendingByBatch(db, academyId, monthStart, f = {}, { limit = 10 } = {}) {
  const values = [academyId, monthStart];
  let where = "m.academy_id = $1 AND fe.fee_month = $2::date AND fe.status IN ('PENDING', 'PARTIALLY_PAID')";
  for (const [column, key] of [["c.id", "courtId"], ["b.id", "batchId"], ["b.batch_type", "type"]]) {
    if (f[key]) { values.push(f[key]); where += ` AND ${column} = $${values.length}`; }
  }
  values.push(limit);
  return (await db.query(`
    SELECT b.id AS batch_id, b.name AS batch_name, b.batch_type, c.name AS court_name, COUNT(*)::int AS fee_count,
      SUM(fe.applicable_fee - COALESCE(t.paid, 0))::numeric(14, 2)::text AS outstanding
    FROM owner_monthly_fees fe JOIN owner_memberships ms ON ms.id = fe.membership_id JOIN owner_members m ON m.id = ms.member_id
    JOIN owner_batches b ON b.id = ms.batch_id JOIN owner_courts c ON c.id = b.court_id
    LEFT JOIN (SELECT monthly_fee_id, SUM(amount) AS paid FROM owner_payment_allocations GROUP BY monthly_fee_id) t ON t.monthly_fee_id = fe.id
    WHERE ${where} AND fe.applicable_fee > COALESCE(t.paid, 0)
    GROUP BY b.id, b.name, b.batch_type, c.name
    ORDER BY SUM(fe.applicable_fee - COALESCE(t.paid, 0)) DESC, b.name, b.id LIMIT $${values.length}`, values)).rows;
}
