import { withDatabase, withTransaction } from "../db/database.js";
import * as repo from "../repositories/owner-availability.repository.js";
import * as batches from "../repositories/owner-batch.repository.js";
import { complementOfDay, DAY_END, overlaps, toMinutes } from "../utils/owner-intervals.js";
import { OwnerError, activeProfile } from "./owner.service.js";

// ---------------------------------------------------------------------------------------------------------------
// Owner availability + conflict engine (Phase 9.1). ONE implementation of "what occupies a court on a date" that
// court blocks, batch release/restore and (Phase 9.2) bookings all go through.
//
//   unavailable(court, date) = applicable ACTIVE batches (minus RELEASED occurrences)
//                              + PENDING/CONFIRMED bookings + ACTIVE court blocks
//   available(court, date)   = full day 00:00-24:00 minus the merged unavailable intervals
//
// Authoritative checks run inside the write transaction after repo.lockCourtDay(), so stale client availability can
// never produce an overlap. Phase 9.2 booking creation must call lockCourtDay -> assertWindowFree -> insert.
// ---------------------------------------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function dateValue(v, label = "date") {
  if (typeof v !== "string" || !DATE_RE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
    throw new OwnerError(`${label} must be a valid calendar date (YYYY-MM-DD)`);
  }
  return v;
}
// Start: 00:00-23:59. End: 00:01-23:59 or 24:00 (end of the same calendar day). Any minute is allowed; no slots.
export function windowValue(startTime, endTime) {
  if (typeof startTime !== "string" || !TIME_RE.test(startTime)) throw new OwnerError("Start time must be a time in HH:MM (24-hour) format");
  if (typeof endTime !== "string" || !(TIME_RE.test(endTime) || endTime === DAY_END)) throw new OwnerError("End time must be a time in HH:MM (24-hour) format (24:00 = end of day)");
  if (toMinutes(startTime) >= toMinutes(endTime)) throw new OwnerError("Start time must be before end time (same calendar day)");
  return { startTime, endTime };
}
export const isoWeekday = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay() || 7;

const label = (v) => (v == null ? null : String(v));
export function toBlockers({ batches: b, bookings, blocks }) {
  return [
    ...b.map((r) => ({ type: `${r.batch_type}_BATCH`, startTime: r.s, endTime: r.e, label: r.name, batchId: r.id })),
    ...bookings.map((r) => ({ type: "BOOKING", startTime: r.s, endTime: r.e, label: r.customer_name ?? "Booking", bookingId: r.id })),
    ...blocks.map((r) => ({ type: "COURT_BLOCK", startTime: r.s, endTime: r.e, label: label(r.reason) ?? "Court block", blockId: r.id })),
  ].sort((x, y) => toMinutes(x.startTime) - toMinutes(y.startTime) || toMinutes(x.endTime) - toMinutes(y.endTime));
}

// Pure shared conflict decision over already-loaded blockers.
export function evaluateWindow(blockers, startTime, endTime) {
  const conflicts = blockers.filter((b) => overlaps({ startTime, endTime }, b));
  return { available: conflicts.length === 0, conflicts };
}

export async function checkWindow(db, courtId, date, startTime, endTime) {
  return evaluateWindow(toBlockers(await repo.dayBlockers(db, courtId, date)), startTime, endTime);
}

function conflictError(prefix, conflicts) {
  const first = conflicts[0];
  return new OwnerError(`${prefix}: overlaps ${first.label} (${first.startTime}-${first.endTime})`, 409, { available: false, conflicts });
}

// Reusable by Phase 9.2 booking creation. Caller MUST already hold repo.lockCourtDay() for this court + date.
export async function assertWindowFree(db, courtId, date, startTime, endTime, what = "Cannot reserve this time") {
  const result = await checkWindow(db, courtId, date, startTime, endTime);
  if (!result.available) throw conflictError(what, result.conflicts);
}

const mapBlock = (r) => ({
  id: r.id, academyId: r.academy_id, courtId: r.court_id, courtName: r.court_name, date: r.block_date,
  startTime: r.s, endTime: r.e, reason: r.reason ?? null, status: r.status,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  cancelledAt: r.cancelled_at instanceof Date ? r.cancelled_at.toISOString() : r.cancelled_at ?? null,
});

// ----- availability -----
export async function getAvailability(env, identity, courtId, query = {}) {
  const date = dateValue(query.date);
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const court = await repo.findCourtForOwner(db, profile.id, courtId);
    if (!court) throw new OwnerError("Court not found", 404);
    // one snapshot-consistent read is not required: the write paths re-check under lock.
    const blockers = toBlockers(await repo.dayBlockers(db, courtId, date));
    const released = (await repo.releasedBatches(db, courtId, date)).map((r) => ({
      type: `${r.batch_type}_BATCH`, batchId: r.id, startTime: r.s, endTime: r.e, label: r.name, reason: r.reason ?? null,
    }));
    return {
      date, court: { id: court.id, name: court.name, status: court.status, academyId: court.academy_id },
      unavailable: blockers, releasedBatches: released, available: complementOfDay(blockers),
    };
  });
}

// ----- court blocks -----
export async function createBlock(env, identity, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  const courtId = typeof input.courtId === "string" && input.courtId ? input.courtId : null;
  if (!courtId) throw new OwnerError("courtId is required");
  const date = dateValue(input.date);
  const { startTime, endTime } = windowValue(input.startTime, input.endTime);
  let reason = null;
  if (input.reason != null && input.reason !== "") {
    if (typeof input.reason !== "string") throw new OwnerError("reason must be text");
    reason = input.reason.trim().replace(/\s+/g, " ");
    if (reason.length > 200) throw new OwnerError("reason must be at most 200 characters");
    reason = reason || null;
  }
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const court = await repo.lockCourtDay(db, profile.id, courtId, date);
    if (!court) throw new OwnerError("Court not found", 404);
    if (court.status !== "ACTIVE") throw new OwnerError("Court is inactive", 409);
    if (court.academy_status !== "ACTIVE") throw new OwnerError("Academy is inactive", 409);
    await assertWindowFree(db, courtId, date, startTime, endTime, "Cannot block this time");
    const id = await repo.insertBlock(db, { academyId: court.academy_id, courtId, date, startTime, endTime, reason, createdBy: profile.id });
    return mapBlock(await repo.findBlockForOwner(db, profile.id, id));
  });
}

export async function listBlocks(env, identity, query = {}) {
  const f = {};
  for (const key of ["academyId", "courtId"]) if (query[key]) f[key] = String(query[key]);
  for (const key of ["date", "from", "to"]) if (query[key]) f[key] = dateValue(query[key], key);
  if (query.status) {
    if (!["ACTIVE", "CANCELLED"].includes(query.status)) throw new OwnerError("status must be ACTIVE or CANCELLED");
    f.status = query.status;
  }
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return (await repo.listBlocks(db, profile.id, f)).map(mapBlock);
  });
}

// History-preserving: the row stays, status becomes CANCELLED and the time is free again.
export async function cancelBlock(env, identity, blockId) {
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const found = await repo.findBlockForOwner(db, profile.id, blockId);
    if (!found) throw new OwnerError("Court block not found", 404);
    // same lock as creation so cancel cannot interleave with a conflicting write on that day
    await repo.lockCourtDay(db, profile.id, found.court_id, found.block_date);
    const current = await repo.findBlockForOwner(db, profile.id, blockId);
    if (current.status === "CANCELLED") throw new OwnerError("Court block is already cancelled", 409);
    await repo.cancelBlock(db, blockId);
    return mapBlock(await repo.findBlockForOwner(db, profile.id, blockId));
  });
}

// ----- one-day batch release / restore -----
async function loadReleasable(db, profile, batchId, date) {
  const batch = await batches.findForOwner(db, profile.id, batchId);
  if (!batch) throw new OwnerError("Batch not found", 404);
  return batch;
}
function assertScheduledOn(batch, date) {
  if (batch.status !== "ACTIVE") throw new OwnerError("Only an ACTIVE batch can be released", 409);
  if (!batch.days_of_week.includes(isoWeekday(date))) throw new OwnerError("This batch is not scheduled on that date", 409);
  if ((batch.effective_from_ymd && date < batch.effective_from_ymd) || (batch.effective_to_ymd && date > batch.effective_to_ymd)) {
    throw new OwnerError("That date is outside the batch's effective dates", 409);
  }
}
const mapRelease = (batch, date, row) => ({
  id: row.id, batchId: batch.id, batchName: batch.name, courtId: batch.court_id, date,
  startTime: batch.start_hhmm, endTime: batch.end_hhmm, status: row.status, reason: row.reason ?? null,
});

// Lock (court, date) then re-read the batch: if it moved courts meanwhile, the caller retries.
async function lockForBatch(db, profile, batchId, date) {
  const first = await loadReleasable(db, profile, batchId, date);
  await repo.lockCourtDay(db, profile.id, first.court_id, date);
  const batch = await loadReleasable(db, profile, batchId, date);
  if (batch.court_id !== first.court_id) throw new OwnerError("Batch was moved to another court. Please retry", 409);
  return batch;
}

export async function releaseBatch(env, identity, batchId, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  const date = dateValue(input.date);
  let reason = null;
  if (input.reason != null && input.reason !== "") {
    if (typeof input.reason !== "string") throw new OwnerError("reason must be text");
    reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 201);
    if (reason.length > 200) throw new OwnerError("reason must be at most 200 characters");
    reason = reason || null;
  }
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const batch = await lockForBatch(db, profile, batchId, date);
    assertScheduledOn(batch, date);
    if (await repo.findLiveRelease(db, batchId, date)) throw new OwnerError("This batch occurrence is already released", 409);
    const id = await repo.insertRelease(db, { academyId: batch.academy_id, batchId, date, reason, createdBy: profile.id });
    return mapRelease(batch, date, { id, status: "ACTIVE", reason });
  });
}

export async function restoreBatch(env, identity, batchId, dateInput) {
  const date = dateValue(dateInput);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const batch = await lockForBatch(db, profile, batchId, date);
    const live = await repo.findLiveRelease(db, batchId, date);
    if (!live) throw new OwnerError("This batch occurrence is not released", 409);
    const startTime = batch.start_hhmm, endTime = batch.end_hhmm;
    if (batch.status === "ACTIVE") {
      // Never re-impose the batch over a booking / block that now occupies the time: reject, change nothing.
      const { bookings, blocks } = await repo.nonBatchBlockers(db, batch.court_id, date);
      const others = toBlockers({ batches: [], bookings, blocks });
      const result = evaluateWindow(others, startTime, endTime);
      if (!result.available) throw conflictError("Cannot restore batch", result.conflicts);
    }
    await repo.restoreRelease(db, live.id);
    return mapRelease(batch, date, { id: live.id, status: "RESTORED", reason: live.reason });
  });
}
