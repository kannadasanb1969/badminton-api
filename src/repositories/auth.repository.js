export async function lockMobile(db, mobile) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [mobile]);
}
export async function createOtp(db, mobile, hash) {
  await db.query("UPDATE otp_requests SET status='CANCELLED' WHERE mobile=$1 AND status='PENDING'", [mobile]);
  await db.query("INSERT INTO otp_requests (mobile,otp_hash,expires_at) VALUES ($1,$2,NOW()+INTERVAL '5 minutes')", [mobile,hash]);
}
export async function latestOtp(db, mobile) {
  return (await db.query("SELECT *, expires_at > NOW() AS unexpired FROM otp_requests WHERE mobile=$1 AND purpose='LOGIN' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [mobile])).rows[0];
}
export async function setStatus(db, id, status) {
  await db.query("UPDATE otp_requests SET status=$2::varchar, verified_at=CASE WHEN $2::varchar='VERIFIED' THEN NOW() ELSE verified_at END WHERE id=$1", [id,status]);
}
export async function failedAttempt(db, id) {
  await db.query("UPDATE otp_requests SET attempt_count=attempt_count+1, status=CASE WHEN attempt_count+1>=5 THEN 'CANCELLED' ELSE status END WHERE id=$1", [id]);
}
