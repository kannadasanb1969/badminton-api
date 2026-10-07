import { withDatabase, withTransaction } from "../db/database.js";
import * as repo from "../repositories/owner-fee.repository.js";
import * as ownerRepo from "../repositories/owner.repository.js";
import { addDays, currentMonthIST, fmtDate, monthEnd, parseUtcDate as toUtc, todayIST } from "../utils/owner-dates.js";
import { OwnerError, activeProfile } from "./owner.service.js";
import { feeValue } from "./owner-batch.service.js";

const has = (o, k) => Object.hasOwn(o, k);

function body(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  return input;
}

// ---- month / date helpers (plain calendar dates; see src/utils/owner-dates.js) ----------------------------------------
// Accepts "YYYY-MM" or "YYYY-MM-01". Any other day is rejected: billing is deterministic per whole month.
export function monthValue(v, label = "Fee month") {
  if (typeof v !== "string") throw new OwnerError(`${label} is required (YYYY-MM)`);
  const text = /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? toUtc(text) : null;
  if (!d || Number.isNaN(d.getTime()) || fmtDate(d) !== text) throw new OwnerError(`${label} must be a valid month in YYYY-MM format`);
  if (!text.endsWith("-01")) throw new OwnerError(`${label} must be the first day of a month`);
  return text;
}

export const rateInput = (input) => {
  const d = body(input);
  return { feeAmount: feeValue(d.feeAmount), effectiveFrom: monthValue(d.effectiveFrom, "Effective month") };
};

const mapRate = (r) => ({ id: r.id, batchId: r.batch_id, feeAmount: r.fee_amount, effectiveFrom: r.effective_from, effectiveTo: r.effective_to });
export const mapLeave = (r) => ({ id: r.id, membershipId: r.membership_id, feeMonth: r.fee_month, note: r.note ?? null });
export const mapFee = (r) => ({
  id: r.id, membershipId: r.membership_id, feeMonth: r.fee_month, applicableFee: r.applicable_fee, status: r.status,
  paidAmount: r.paid_amount, balance: r.balance,
  memberId: r.member_id, memberName: r.member_name, memberMobile: r.member_mobile ?? null, batchId: r.batch_id, batchName: r.batch_name,
  type: r.batch_type, courtId: r.court_id ?? null, courtName: r.court_name,
});
export const mapSummary = (s) => ({
  expectedCollection: s.expected_collection, collected: s.collected, outstanding: s.outstanding,
  pendingCount: s.pending_count, partiallyPaidCount: s.partially_paid_count, paidCount: s.paid_count,
  onLeaveCount: s.on_leave_count, totalCount: s.total_count,
});
export const mapNotGenerated = (n) => ({
  count: n.total, missingFeeRateCount: n.missing_rate, generatableCount: n.total - n.missing_rate,
  items: n.items.map((r) => ({
    membershipId: r.membership_id, memberId: r.member_id, memberName: r.member_name, memberMobile: r.member_mobile ?? null,
    batchId: r.batch_id, batchName: r.batch_name, type: r.batch_type, courtName: r.court_name, missingFeeRate: r.missing_rate,
  })),
});
export const TYPES = ["REGULAR", "COACHING"];
const LOCKED_MESSAGE = "Payments are already recorded against that month's fee, so it can no longer be changed";

// Overlap/duplicate violations raised by the database guard are translated into clear conflicts.
function translate(error) {
  if (error?.code === "23P01") return new OwnerError("This fee period overlaps an existing fee rate for the batch", 409);
  if (error?.code === "23505") {
    if (error.constraint === "owner_monthly_leaves_membership_month_uidx") return new OwnerError("Leave is already marked for this membership and month", 409);
    if (error.constraint?.startsWith("owner_fee_rates_")) return new OwnerError("A fee rate already exists for this period", 409);
  }
  return error;
}
async function guarded(fn) {
  try { return await fn(); } catch (e) { throw translate(e); }
}

// ---- fee rates ------------------------------------------------------------------------------------------------------
async function ratesView(db, batch) {
  const rates = (await repo.listRates(db, batch.id)).map(mapRate);
  const current = await repo.rateAt(db, batch.id, currentMonthIST());
  return { batchId: batch.id, batchName: batch.name, currentFeeRate: current ? mapRate(current) : null, rates };
}

export async function getFeeRates(env, identity, batchId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const batch = await repo.batchForOwner(db, profile.id, batchId);
    if (!batch) throw new OwnerError("Batch not found", 404);
    return ratesView(db, batch);
  });
}

// Fee-rate history is append-only from the Owner's point of view:
//   * first rate for a batch: any month
//   * a CHANGE (after the latest rate): effective month must be the current month or later; the previous open rate is
//     closed at the end of the preceding month and the new open-ended rate is created, atomically
//   * a rate BEFORE the earliest rate fills earlier history (ends the month before the earliest rate)
//   * a month that already starts a rate, or a date inside existing history, is refused: history is never rewritten.
export async function setFeeRate(env, identity, batchId, input) {
  const v = rateInput(input);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const peek = await repo.batchForOwner(db, profile.id, batchId);
    if (!peek) throw new OwnerError("Batch not found", 404);
    // Lock order for all Phase-5 writes: academy first, then the batch (the DB trigger re-locks the batch row).
    await repo.lockAcademy(db, profile.id, peek.academy_id);
    const batch = await repo.batchForOwner(db, profile.id, batchId, true);
    const rates = await repo.listRates(db, batch.id); // newest first
    if (!rates.length) {
      await repo.insertRate(db, batch.id, v.feeAmount, v.effectiveFrom, null);
    } else {
      const latest = rates[0];
      const earliest = rates[rates.length - 1];
      if (rates.some((r) => r.effective_from === v.effectiveFrom)) throw new OwnerError("A fee rate already starts in that month", 409);
      if (v.effectiveFrom > latest.effective_from) {
        if (v.effectiveFrom < currentMonthIST()) throw new OwnerError("A fee change cannot take effect before the current month", 409);
        await repo.closeRate(db, latest.id, addDays(v.effectiveFrom, -1));
        await repo.insertRate(db, batch.id, v.feeAmount, v.effectiveFrom, null);
      } else if (v.effectiveFrom < earliest.effective_from) {
        await repo.insertRate(db, batch.id, v.feeAmount, v.effectiveFrom, addDays(earliest.effective_from, -1));
      } else {
        throw new OwnerError("That month falls inside existing fee history, which cannot be rewritten", 409);
      }
    }
    return ratesView(db, batch);
  }));
}

// ---- monthly leave ----------------------------------------------------------------------------------------------------
function intersectsMonth(membership, monthStart) {
  return membership.start_ymd <= monthEnd(monthStart) && (membership.end_ymd == null || membership.end_ymd >= monthStart);
}

export async function listLeaves(env, identity, membershipId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    if (!(await repo.membershipForOwner(db, profile.id, membershipId))) throw new OwnerError("Membership not found", 404);
    return (await repo.listLeaves(db, membershipId)).map(mapLeave);
  });
}

// Reconciliation: an existing obligation for this membership+month is brought in line with the leave state inside the
// same transaction (never deleted). Phase 6 can refuse via repo.isFeeLocked once payments exist.
export async function addLeave(env, identity, membershipId, input) {
  const d = body(input);
  const feeMonth = monthValue(d.feeMonth);
  const note = has(d, "note") && d.note != null ? String(d.note).trim().slice(0, 300) || null : null;
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const ms = await repo.membershipForOwner(db, profile.id, membershipId);
    if (!ms) throw new OwnerError("Membership not found", 404);
    await repo.lockAcademy(db, profile.id, ms.academy_id);
    if (!intersectsMonth(ms, feeMonth)) throw new OwnerError("The membership does not cover that month", 400);
    const leave = await repo.insertLeave(db, membershipId, feeMonth, note);
    const fee = await repo.findFee(db, membershipId, feeMonth, true);
    if (fee) {
      if (await repo.isFeeLocked(db, fee.id)) throw new OwnerError(LOCKED_MESSAGE, 409);
      await repo.reconcileFee(db, fee.id, { applicableFee: "0", status: "ON_LEAVE", feeRateId: null });
    }
    return mapLeave(leave);
  }));
}

export async function cancelLeave(env, identity, membershipId, feeMonthInput) {
  const feeMonth = monthValue(feeMonthInput);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const ms = await repo.membershipForOwner(db, profile.id, membershipId);
    if (!ms) throw new OwnerError("Membership not found", 404);
    await repo.lockAcademy(db, profile.id, ms.academy_id);
    const leave = await repo.findLeave(db, membershipId, feeMonth);
    if (!leave) throw new OwnerError("No leave is marked for that month", 404);
    const fee = await repo.findFee(db, membershipId, feeMonth, true);
    if (fee) {
      if (await repo.isFeeLocked(db, fee.id)) throw new OwnerError(LOCKED_MESSAGE, 409);
      // Restore the snapshot from the Owner-defined rate in force on the first day of that month; never invent one.
      const rate = await repo.rateAt(db, ms.batch_id, feeMonth);
      if (!rate) throw new OwnerError("No fee rate applies to that month, so the fee cannot be restored. Set the batch fee first", 409);
      await repo.reconcileFee(db, fee.id, { applicableFee: rate.fee_amount, status: "PENDING", feeRateId: rate.id });
    }
    await repo.deleteLeave(db, leave.id);
    return { feeMonth, membershipId, cancelled: true, feeRestored: Boolean(fee) };
  }));
}

// ---- monthly fee generation ---------------------------------------------------------------------------------------------
// Idempotent. For every membership intersecting the month: existing obligation -> left alone (alreadyExisting);
// leave -> ON_LEAVE/0; otherwise the Owner-defined rate in force on the 1st of the month is snapshotted as PENDING;
// no rate -> reported in missingFeeRate and NO obligation is created.
export async function generateMonthlyFees(env, identity, input) {
  const d = body(input);
  const feeMonth = monthValue(d.feeMonth);
  if (typeof d.academyId !== "string" || !d.academyId) throw new OwnerError("academyId is required");
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const academy = await repo.lockAcademy(db, profile.id, d.academyId);
    if (!academy) throw new OwnerError("Academy not found", 404);
    const candidates = await repo.generationCandidates(db, academy.id, feeMonth, monthEnd(feeMonth));
    const toInsert = [];
    const missing = [];
    let alreadyExisting = 0;
    for (const c of candidates) {
      if (c.has_fee) alreadyExisting += 1;
      else if (c.has_leave) toInsert.push({ membershipId: c.membership_id, applicableFee: "0", status: "ON_LEAVE", feeRateId: null });
      else if (c.rate_id) toInsert.push({ membershipId: c.membership_id, applicableFee: c.fee_amount, status: "PENDING", feeRateId: c.rate_id });
      else missing.push({ membershipId: c.membership_id, memberName: c.member_name, batchName: c.batch_name, type: c.batch_type });
    }
    await repo.insertFees(db, feeMonth, toInsert);
    return {
      academyId: academy.id, feeMonth, eligible: candidates.length,
      generated: toInsert.filter((r) => r.status === "PENDING").length,
      onLeave: toInsert.filter((r) => r.status === "ON_LEAVE").length,
      alreadyExisting, missingFeeRate: missing.length, missing,
    };
  }));
}

// Shared by the Fees list and the dashboard so both read the same scope with the same validation.
export function feeScope(query = {}) {
  const f = {};
  if (query.academyId) f.academyId = query.academyId;
  if (query.feeMonth) f.feeMonth = monthValue(query.feeMonth);
  if (query.memberId) f.memberId = query.memberId;
  if (query.batchId) f.batchId = query.batchId;
  if (query.courtId) f.courtId = query.courtId;
  if (query.type) {
    if (!TYPES.includes(query.type)) throw new OwnerError("type must be REGULAR or COACHING");
    f.type = query.type;
  }
  return f;
}

export async function listMonthlyFees(env, identity, query = {}) {
  const scope = feeScope(query);
  const view = { ...scope };
  if (query.status) {
    if (!["PENDING", "PARTIALLY_PAID", "PAID", "ON_LEAVE"].includes(query.status)) throw new OwnerError("status must be PENDING, PARTIALLY_PAID, PAID or ON_LEAVE");
    view.status = query.status;
  }
  if (query.outstanding === "true") view.outstanding = true;
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const queries = [repo.listFees(db, profile.id, view), repo.summarizeFees(db, profile.id, scope)];
    // "Not generated" needs an academy and a month; it follows the same court / batch / type / member scope.
    // It queries by academy id directly, so it only runs for an academy this Owner owns (never for a foreign id).
    const wantsGap = scope.academyId && scope.feeMonth && (await ownerRepo.findAcademy(db, profile.id, scope.academyId));
    if (wantsGap) queries.push(repo.notGenerated(db, scope.academyId, scope.feeMonth, monthEnd(scope.feeMonth), scope));
    const [items, s, gap] = await Promise.all(queries);
    return { summary: mapSummary(s), items: items.map(mapFee), ...(gap ? { notGenerated: mapNotGenerated(gap) } : {}) };
  });
}

export { currentMonthIST, todayIST };
