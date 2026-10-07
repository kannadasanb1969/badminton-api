import { withDatabase, withTransaction } from "../db/database.js";
import * as batches from "../repositories/owner-batch.repository.js";
import * as owner from "../repositories/owner.repository.js";
import { countActiveForBatch } from "../repositories/owner-member.repository.js";
import { insertRate } from "../repositories/owner-fee.repository.js";
import { currentMonthIST, todayIST } from "../utils/owner-dates.js";
import { findScheduleCollision } from "../repositories/owner-availability.repository.js";
import { OwnerError, activeProfile } from "./owner.service.js";

const TYPES = ["REGULAR", "COACHING"];
const STATUSES = ["ACTIVE", "INACTIVE"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const FEE_RE = /^\d{1,8}(\.\d{1,2})?$/;

function body(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  return input;
}
const has = (o, k) => Object.hasOwn(o, k);

export function typeValue(v) {
  if (!TYPES.includes(v)) throw new OwnerError("type must be REGULAR or COACHING");
  return v;
}
export function statusValue(v) {
  if (!STATUSES.includes(v)) throw new OwnerError("status must be ACTIVE or INACTIVE");
  return v;
}
export function nameValue(v) {
  if (typeof v !== "string" || !v.trim()) throw new OwnerError("Batch name is required");
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length > 100) throw new OwnerError("Batch name must be at most 100 characters");
  return name;
}
// 24-hour "HH:MM" within one calendar day (00:00-23:59). Any minute is allowed: no fixed slots.
export function timeValue(v, label) {
  if (typeof v !== "string" || !TIME_RE.test(v)) throw new OwnerError(`${label} must be a time in HH:MM (24-hour) format`);
  return v;
}
// Exact money: accepts a decimal string or a number with at most 2 decimals; returns a canonical string
// that goes straight into numeric(10,2). Floats never touch the database.
export function feeValue(v) {
  if (v == null || v === "" || typeof v === "boolean") throw new OwnerError("Fee per person is required");
  const text = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  if (!FEE_RE.test(text)) throw new OwnerError(text.startsWith("-") ? "Fee per person cannot be negative" : "Fee per person must be a number with at most 2 decimals");
  return text;
}
// ISO weekdays 1=Mon..7=Sun. Input must be a non-empty array of distinct integers 1-7; stored sorted ascending.
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
export function daysValue(v) {
  if (!Array.isArray(v) || v.length === 0) throw new OwnerError("Select at least one weekday (1=Monday ... 7=Sunday)");
  if (!v.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) throw new OwnerError("Weekdays must be integers 1 (Monday) to 7 (Sunday)");
  if (new Set(v).size !== v.length) throw new OwnerError("Weekdays must not contain duplicates");
  return [...v].sort((a, b) => a - b);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function ymdValue(v, label) {
  if (typeof v !== "string" || !DATE_RE.test(v) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new OwnerError(`${label} must be a calendar date (YYYY-MM-DD)`);
  return v;
}
export function orderedDates(from, to) {
  if (from && to && to < from) throw new OwnerError("Effective until cannot be before effective from");
}
export function orderedTimes(start, end) {
  if (start >= end) throw new OwnerError("Start time must be before end time (same calendar day)");
}

export const hhmm12 = (t) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export function createInput(input) {
  const d = body(input);
  const v = {
    academyId: typeof d.academyId === "string" && d.academyId ? d.academyId : null,
    courtId: typeof d.courtId === "string" && d.courtId ? d.courtId : null,
    type: typeValue(d.type), name: nameValue(d.name),
    startTime: timeValue(d.startTime, "Start time"), endTime: timeValue(d.endTime, "End time"),
    feePerPerson: feeValue(d.feePerPerson),
    // New batches: days default to every day; Effective From defaults to TODAY (IST) so a new batch never blocks
    // past dates; Effective Until is optional (omitted/null = continues indefinitely).
    daysOfWeek: has(d, "daysOfWeek") ? daysValue(d.daysOfWeek) : ALL_DAYS,
    effectiveFrom: d.effectiveFrom == null ? todayIST() : ymdValue(d.effectiveFrom, "Effective from"),
    effectiveTo: d.effectiveTo == null ? null : ymdValue(d.effectiveTo, "Effective until"),
  };
  orderedDates(v.effectiveFrom, v.effectiveTo);
  if (!v.academyId) throw new OwnerError("academyId is required");
  if (!v.courtId) throw new OwnerError("courtId is required");
  orderedTimes(v.startTime, v.endTime);
  return v;
}

export function patchInput(input) {
  const d = body(input);
  const p = {};
  if (has(d, "courtId")) { if (typeof d.courtId !== "string" || !d.courtId) throw new OwnerError("courtId is invalid"); p.courtId = d.courtId; }
  if (has(d, "type")) p.type = typeValue(d.type);
  if (has(d, "name")) p.name = nameValue(d.name);
  if (has(d, "startTime")) p.startTime = timeValue(d.startTime, "Start time");
  if (has(d, "endTime")) p.endTime = timeValue(d.endTime, "End time");
  if (has(d, "feePerPerson")) p.feePerPerson = feeValue(d.feePerPerson);
  if (has(d, "status")) p.status = statusValue(d.status);
  if (has(d, "daysOfWeek")) p.daysOfWeek = daysValue(d.daysOfWeek);
  if (has(d, "effectiveFrom")) p.effectiveFrom = d.effectiveFrom == null ? null : ymdValue(d.effectiveFrom, "Effective from");
  if (has(d, "effectiveTo")) p.effectiveTo = d.effectiveTo == null ? null : ymdValue(d.effectiveTo, "Effective until");
  if (!Object.keys(p).length) throw new OwnerError("No updatable fields supplied");
  return p;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
export function mapBatch(row) {
  return {
    id: row.id, academyId: row.academy_id, courtId: row.court_id, courtName: row.court_name ?? null,
    type: row.batch_type, name: row.name, startTime: row.start_hhmm, endTime: row.end_hhmm,
    // feePerPerson is the legacy value captured at creation. The authoritative fee is the effective-dated rate; currentFee
    // is the rate in force this month (null when none is set). Fee changes go through /batches/:id/fee-rates.
    daysOfWeek: row.days_of_week, effectiveFrom: row.effective_from_ymd ?? null, effectiveTo: row.effective_to_ymd ?? null,
    feePerPerson: row.fee_per_person, currentFee: row.current_fee ?? null, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

async function assertNoConflict(db, v, excludeId) {
  const schedule = { daysOfWeek: v.daysOfWeek, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo };
  const clash = await batches.findActiveOverlap(db, v.courtId, v.startTime, v.endTime, excludeId, schedule);
  if (clash) {
    throw new OwnerError(
      `Overlaps with "${clash.name}" (${hhmm12(clash.start_hhmm)} - ${hhmm12(clash.end_hhmm)}) on this court`, 409,
      { batchId: clash.id, name: clash.name, type: clash.batch_type, startTime: clash.start_hhmm, endTime: clash.end_hhmm });
  }
  // A batch must not silently cover a future court block / booking (those exist only where no batch applied).
  const hit = await findScheduleCollision(db, { ...v, fromDate: todayIST(), excludeBatchId: excludeId });
  if (hit) {
    const d = hit.ymd;
    throw new OwnerError(`Overlaps a ${hit.type === "BOOKING" ? "booking" : "court block"} on ${d} (${hhmm12(hit.s)} - ${hhmm12(hit.e)}). Cancel it first`, 409,
      { type: hit.type, date: d, startTime: hit.s, endTime: hit.e });
  }
}

export async function listBatches(env, identity, filters = {}) {
  const f = {};
  if (filters.academyId) f.academyId = filters.academyId;
  if (filters.courtId) f.courtId = filters.courtId;
  if (filters.type) f.type = typeValue(filters.type);
  if (filters.status) f.status = statusValue(filters.status);
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return (await batches.list(db, profile.id, f)).map(mapBatch);
  });
}

export async function getBatch(env, identity, batchId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const row = await batches.findForOwner(db, profile.id, batchId);
    if (!row) throw new OwnerError("Batch not found", 404);
    return mapBatch(row);
  });
}

export async function createBatch(env, identity, input) {
  const v = createInput(input);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const academy = await owner.findAcademy(db, profile.id, v.academyId);
    if (!academy) throw new OwnerError("Academy not found", 404);
    if (academy.status !== "ACTIVE") throw new OwnerError("Academy is inactive", 409);
    // The court row lock serialises every schedule write on this court, so the overlap check below is race-free.
    const court = await batches.lockCourt(db, profile.id, v.courtId);
    if (!court || court.academy_id !== v.academyId) throw new OwnerError("Court not found", 404);
    if (court.status !== "ACTIVE") throw new OwnerError("Court is inactive", 409);
    await assertNoConflict(db, v, null);
    const id = await batches.insert(db, v);
    // The Owner-entered fee is the batch's first effective-dated rate, effective from the current month.
    await insertRate(db, id, v.feePerPerson, currentMonthIST(), null);
    return mapBatch(await batches.findForOwner(db, profile.id, id));
  });
}

export async function updateBatch(env, identity, batchId, input) {
  const patch = patchInput(input);
  // One source of truth for money: the fee is changed only by creating an effective-dated rate.
  if (patch.feePerPerson !== undefined) throw new OwnerError("The batch fee is changed with a new effective-dated fee rate (POST /api/owner/batches/:id/fee-rates)", 409);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const current = await batches.findForOwner(db, profile.id, batchId);
    if (!current) throw new OwnerError("Batch not found", 404);
    const next = {
      courtId: patch.courtId ?? current.court_id, type: patch.type ?? current.batch_type, name: patch.name ?? current.name,
      startTime: patch.startTime ?? current.start_hhmm, endTime: patch.endTime ?? current.end_hhmm,
      status: patch.status ?? current.status,
      daysOfWeek: patch.daysOfWeek ?? current.days_of_week,
      effectiveFrom: patch.effectiveFrom !== undefined ? patch.effectiveFrom : current.effective_from_ymd,
      effectiveTo: patch.effectiveTo !== undefined ? patch.effectiveTo : current.effective_to_ymd,
    };
    orderedTimes(next.startTime, next.endTime);
    orderedDates(next.effectiveFrom, next.effectiveTo);
    // Lock the destination court first, then the batch row; both orders are consistent across writers.
    const court = await batches.lockCourt(db, profile.id, next.courtId);
    if (!court || court.academy_id !== current.academy_id) throw new OwnerError("Court not found", 404);
    const locked = await batches.findForOwner(db, profile.id, batchId, true);
    // Memberships reference this batch: it cannot go inactive until they are ended or moved (never auto-ended).
    if (next.status === "INACTIVE" && locked.status === "ACTIVE" && (await countActiveForBatch(db, batchId)) > 0) {
      throw new OwnerError("Batch has active memberships. Move or end them before deactivating the batch", 409);
    }
    const scheduleChanged = next.courtId !== locked.court_id || next.startTime !== locked.start_hhmm || next.endTime !== locked.end_hhmm
      || next.daysOfWeek.join() !== locked.days_of_week.join() || next.effectiveFrom !== locked.effective_from_ymd || next.effectiveTo !== locked.effective_to_ymd;
    const becomesActive = next.status === "ACTIVE" && locked.status !== "ACTIVE";
    if (next.status === "ACTIVE" && (scheduleChanged || becomesActive)) {
      if (court.status !== "ACTIVE") throw new OwnerError("Court is inactive", 409);
      await assertNoConflict(db, next, batchId);
    }
    await batches.update(db, batchId, next);
    return mapBatch(await batches.findForOwner(db, profile.id, batchId));
  });
}
