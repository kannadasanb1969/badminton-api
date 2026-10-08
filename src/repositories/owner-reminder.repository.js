// Reminder history. Reads join through academy -> owner profile so an id alone never reveals another Owner's history.
// Rows are only ever INSERTed (as SENDING) and then completed once; the database trigger enforces that.

const YMD = "to_char(r.reminder_date, 'YYYY-MM-DD')";
const COLS = `r.id, r.academy_id, r.member_id, r.scope_key, ${YMD} AS reminder_date, r.sender_number, r.recipient_number, r.message_body,
  r.total_outstanding::numeric(12, 2)::text AS total_outstanding, r.item_count, r.status, r.provider, r.provider_message_id,
  r.failure_code, r.failure_message, r.sent_at, r.completed_at, r.created_at, m.name AS member_name`;
const LIVE = "('SENDING', 'SENT', 'DRY_RUN')";

// A claim that never completed (worker crash, timeout) must not block the member for the rest of the day.
export async function abandonStaleClaims(db, academyId, memberId, reminderDate, olderThanMinutes = 5) {
  await db.query(`
    UPDATE owner_fee_reminders SET status = 'FAILED', failure_code = 'ABANDONED', failure_message = 'The attempt did not complete', completed_at = NOW()
    WHERE academy_id = $1 AND member_id = $2 AND reminder_date = $3::date AND status = 'SENDING'
      AND created_at < NOW() - make_interval(mins => $4)`, [academyId, memberId, reminderDate, olderThanMinutes]);
}

// The daily-guard trigger atomically reserves (academy, member, local day). A loser inserts no history row.
// scope_key records coverage only; the original Phase-8 index remains as a secondary history guard.
export async function claim(db, c) {
  return (await db.query(`
    INSERT INTO owner_fee_reminders (academy_id, member_id, scope_key, reminder_date, sender_number, recipient_number, message_body,
      total_outstanding, item_count, status, provider, created_by_user_id)
    VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8::numeric, $9, 'SENDING', $10, $11)
    RETURNING id`,
  [c.academyId, c.memberId, c.scopeKey, c.reminderDate, c.sender, c.recipient, c.body, c.total, c.itemCount, c.provider, c.userId])).rows[0];
}

export async function complete(db, id, o) {
  await db.query(`
    UPDATE owner_fee_reminders SET status = $2, provider_message_id = $3, failure_code = $4, failure_message = $5,
      sent_at = CASE WHEN $2 = 'SENT' THEN NOW() ELSE NULL END, completed_at = NOW() WHERE id = $1 AND status = 'SENDING'`,
  [id, o.status, o.providerMessageId ?? null, o.failureCode ?? null, o.failureMessage ? String(o.failureMessage).slice(0, 300) : null]);
}

export async function liveForDay(db, academyId, reminderDate) {
  return (await db.query(`
    SELECT r.member_id, r.status, r.created_at, r.id FROM owner_fee_reminders r
    WHERE r.academy_id = $1 AND r.reminder_date = $2::date AND r.status IN ${LIVE}
      AND (r.status <> 'SENDING' OR r.created_at >= NOW() - INTERVAL '5 minutes')`, [academyId, reminderDate])).rows;
}

export async function findLive(db, academyId, memberId, reminderDate) {
  return (await db.query(`
    SELECT r.id, r.status FROM owner_fee_reminders r
    WHERE r.academy_id = $1 AND r.member_id = $2 AND r.reminder_date = $3::date AND r.status IN ${LIVE}
      AND (r.status <> 'SENDING' OR r.created_at >= NOW() - INTERVAL '5 minutes')`, [academyId, memberId, reminderDate])).rows[0];
}

export async function getForOwner(db, profileId, id) {
  return (await db.query(`
    SELECT ${COLS} FROM owner_fee_reminders r JOIN owner_members m ON m.id = r.member_id JOIN owner_academies a ON a.id = r.academy_id
    WHERE r.id = $2 AND a.owner_profile_id = $1`, [profileId, id])).rows[0];
}

export async function list(db, profileId, f = {}, limit = 100) {
  const values = [profileId];
  let where = "a.owner_profile_id = $1";
  for (const [column, key, cast] of [["r.academy_id", "academyId", ""], ["r.member_id", "memberId", ""], ["r.reminder_date", "date", "::date"], ["r.status", "status", ""]]) {
    if (f[key]) { values.push(f[key]); where += ` AND ${column} = $${values.length}${cast}`; }
  }
  values.push(limit);
  return (await db.query(`
    SELECT ${COLS} FROM owner_fee_reminders r JOIN owner_members m ON m.id = r.member_id JOIN owner_academies a ON a.id = r.academy_id
    WHERE ${where} ORDER BY r.created_at DESC, r.id LIMIT $${values.length}`, values)).rows;
}
