import { withDatabase, withTransaction } from "../db/database.js";
import * as repo from "../repositories/owner-payment.repository.js";
import * as members from "../repositories/owner-member.repository.js";
import { lockAcademy } from "../repositories/owner-fee.repository.js";
import { OwnerError, activeProfile } from "./owner.service.js";
import { dateValue } from "./owner-member.service.js";
import { fromCents, MoneyError, minCents, parseCents, toCents } from "../utils/owner-money.js";
import { todayIST } from "../utils/owner-dates.js";

const MODES = ["CASH", "UPI", "BANK_TRANSFER", "OTHER"];
const ALLOCATION_MODES = ["AUTO", "MANUAL"];
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

function body(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  return input;
}
function money(value, label, opts) {
  try { return parseCents(value, opts); } catch (e) { if (e instanceof MoneyError) throw new OwnerError(`${label}: ${e.message}`); throw e; }
}
function optionalText(value, label, max) {
  if (value == null) return null;
  if (typeof value !== "string") throw new OwnerError(`${label} must be text`);
  const text = value.trim();
  if (text.length > max) throw new OwnerError(`${label} must be at most ${max} characters`);
  return text || null;
}

// ---- input parsing (pure, unit-tested) ------------------------------------------------------------------------------
export function manualAllocations(list) {
  if (!Array.isArray(list) || list.length === 0) throw new OwnerError("allocations are required for MANUAL allocation");
  const seen = new Set();
  return list.map((a) => {
    if (!a || typeof a.monthlyFeeId !== "string" || !a.monthlyFeeId) throw new OwnerError("each allocation needs a monthlyFeeId");
    if (seen.has(a.monthlyFeeId)) throw new OwnerError("a monthly fee can appear only once in allocations");
    seen.add(a.monthlyFeeId);
    return { feeId: a.monthlyFeeId, cents: money(a.amount, "allocation amount", { positive: true }) };
  });
}

export function paymentInput(input) {
  const d = body(input);
  if (typeof d.memberId !== "string" || !d.memberId) throw new OwnerError("memberId is required");
  if (!MODES.includes(d.paymentMode)) throw new OwnerError(`paymentMode must be one of ${MODES.join(", ")}`);
  const allocationMode = d.allocationMode ?? "AUTO";
  if (!ALLOCATION_MODES.includes(allocationMode)) throw new OwnerError("allocationMode must be AUTO or MANUAL");
  const v = {
    memberId: d.memberId, amountCents: money(d.amount, "Payment amount", { positive: true }), paymentMode: d.paymentMode,
    paymentDate: dateValue(d.paymentDate, "Payment date"), allocationMode,
    reference: optionalText(d.reference, "reference", 200), note: optionalText(d.note, "note", 300), allocations: null,
  };
  if (allocationMode === "MANUAL") {
    v.allocations = manualAllocations(d.allocations);
    if (v.allocations.reduce((s, a) => s + a.cents, 0n) > v.amountCents) throw new OwnerError("allocations exceed the payment amount");
  }
  return v;
}

// ---- allocation planning (pure, unit-tested; all arithmetic in cents) ----------------------------------------------------
const remainingOf = (fee) => toCents(fee.applicable_fee) - toCents(fee.paid);
const OPEN = ["PENDING", "PARTIALLY_PAID"];

// Oldest fee month first (ties by id), only PENDING / PARTIALLY_PAID fees with something left, never above the balance.
export function planAuto(fees, availableCents) {
  const plan = [];
  let left = availableCents;
  for (const fee of [...fees].sort((a, b) => (a.fee_month < b.fee_month ? -1 : a.fee_month > b.fee_month ? 1 : a.id < b.id ? -1 : 1))) {
    if (left <= 0n) break;
    if (!OPEN.includes(fee.status)) continue;
    const take = minCents(remainingOf(fee), left);
    if (take > 0n) { plan.push({ feeId: fee.id, cents: take }); left -= take; }
  }
  return { plan, leftCents: left };
}

export function planManual(requests, feesById) {
  return requests.map((r) => {
    const fee = feesById.get(r.feeId);
    if (fee.status === "ON_LEAVE") throw new OwnerError("A payment cannot be applied to a fee that is ON_LEAVE", 409);
    if (r.cents > remainingOf(fee)) throw new OwnerError(`Allocation exceeds the remaining balance (${fromCents(remainingOf(fee))}) of the ${fee.fee_month.slice(0, 7)} fee`, 409);
    return r;
  }).sort((a, b) => (a.feeId < b.feeId ? -1 : 1));
}

// ---- mapping -----------------------------------------------------------------------------------------------------------
function mapAllocation(r) {
  return {
    id: r.id, paymentId: r.payment_id, receiptNumber: r.receipt_number, monthlyFeeId: r.monthly_fee_id, feeMonth: r.fee_month,
    batchName: r.batch_name, type: r.batch_type, allocatedAmount: r.amount, monthlyFeeStatus: r.fee_status, remainingBalance: r.remaining_balance,
  };
}
export function mapPayment(r, allocations = null) {
  return {
    id: r.id, receiptNumber: r.receipt_number, paymentDate: r.payment_date, createdAt: iso(r.created_at), amount: r.amount,
    paymentMode: r.payment_mode, reference: r.reference ?? null, note: r.note ?? null,
    allocatedAmount: r.allocated_amount, creditRemaining: r.credit_remaining,
    academy: { id: r.academy_id, name: r.academy_name, mobile: r.academy_mobile ?? null },
    member: { id: r.member_id, name: r.member_name, mobile: r.member_mobile ?? null },
    ...(allocations ? { allocations: allocations.map(mapAllocation) } : {}),
  };
}

async function paymentView(db, profileId, paymentId) {
  const row = await repo.getPayment(db, profileId, paymentId);
  if (!row) throw new OwnerError("Payment not found", 404);
  return mapPayment(row, await repo.allocationsFor(db, [paymentId]));
}

function translate(error) {
  if (error?.code === "23514" && /allocat|payment and monthly fee/.test(error.message ?? "")) return new OwnerError(error.message, 409);
  return error;
}
async function guarded(fn) {
  try { return await fn(); } catch (e) { throw translate(e); }
}

// Lock order for EVERY payment-side write (and for Phase-5 generation/leave, which take the academy first):
//   academy -> member -> member's monthly fees (fee_month, id) -> member's payments (date, created_at, id) -> receipt counter.
export async function lockMemberScope(db, profile, memberId, { withPayments }) {
  const peek = await members.findMemberForOwner(db, profile.id, memberId);
  if (!peek) throw new OwnerError("Member not found", 404);
  await lockAcademy(db, profile.id, peek.academy_id);
  const member = await members.findMemberForOwner(db, profile.id, memberId, true);
  await repo.lockMemberFees(db, memberId);
  if (withPayments) await repo.lockMemberPayments(db, memberId);
  return member;
}

// ---- record a payment -------------------------------------------------------------------------------------------------------
export async function createPayment(env, identity, input) {
  const v = paymentInput(input);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const member = await lockMemberScope(db, profile, v.memberId, { withPayments: false });
    const fees = await repo.memberFeeBalances(db, member.id); // fresh snapshot, after the locks

    let plan;
    if (v.allocationMode === "AUTO") {
      plan = planAuto(fees, v.amountCents).plan;
    } else {
      const byId = new Map(fees.map((f) => [f.id, f]));
      for (const r of v.allocations) {
        if (byId.has(r.feeId)) continue;
        const scope = await repo.feeOwnerScope(db, profile.id, r.feeId);
        if (!scope) throw new OwnerError("Monthly fee not found", 404);
        throw new OwnerError("That monthly fee belongs to a different member", 409);
      }
      plan = planManual(v.allocations, byId);
    }

    const paymentId = crypto.randomUUID();
    const year = Number(todayIST().slice(0, 4));
    // The counter row lock is taken last and held only until commit.
    const receiptNumber = await repo.nextReceiptNumber(db, member.academy_id, year);
    await repo.insertPayment(db, {
      id: paymentId, academyId: member.academy_id, memberId: member.id, receiptNumber, amount: fromCents(v.amountCents),
      paymentMode: v.paymentMode, paymentDate: v.paymentDate, reference: v.reference, note: v.note, userId: identity.sub,
    });
    await repo.insertAllocations(db, plan.map((p) => ({ paymentId, feeId: p.feeId, amount: fromCents(p.cents) })));
    return paymentView(db, profile.id, paymentId);
  }));
}

// ---- apply existing credit (no new payment transaction) -----------------------------------------------------------------
export async function applyCredit(env, identity, memberId, input) {
  const d = body(input ?? {});
  const mode = d.mode ?? "AUTO";
  if (!ALLOCATION_MODES.includes(mode)) throw new OwnerError("mode must be AUTO or MANUAL");
  const requests = mode === "MANUAL" ? manualAllocations(d.allocations) : null;
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const member = await lockMemberScope(db, profile, memberId, { withPayments: true });
    const fees = await repo.memberFeeBalances(db, member.id);
    const sources = (await repo.creditSources(db, member.id)).map((s) => ({ ...s, left: toCents(s.unallocated) }));
    const creditTotal = sources.reduce((s, x) => s + x.left, 0n);
    if (creditTotal <= 0n) throw new OwnerError("This member has no available credit", 409);

    let plan;
    if (mode === "AUTO") {
      plan = planAuto(fees, creditTotal).plan;
      if (!plan.length) throw new OwnerError("There are no outstanding dues to apply credit to", 409);
    } else {
      const byId = new Map(fees.map((f) => [f.id, f]));
      for (const r of requests) {
        if (byId.has(r.feeId)) continue;
        if (!(await repo.feeOwnerScope(db, profile.id, r.feeId))) throw new OwnerError("Monthly fee not found", 404);
        throw new OwnerError("That monthly fee belongs to a different member", 409);
      }
      plan = planManual(requests, byId);
      if (plan.reduce((s, p) => s + p.cents, 0n) > creditTotal) throw new OwnerError("The amount exceeds the member's available credit", 409);
    }

    // Consume the oldest unallocated payment money first; every allocation row points at the payment it came from.
    const rows = [];
    let si = 0;
    for (const target of plan) {
      let need = target.cents;
      while (need > 0n) {
        const src = sources[si];
        const take = minCents(need, src.left);
        if (take > 0n) { rows.push({ paymentId: src.id, feeId: target.feeId, amount: fromCents(take) }); src.left -= take; need -= take; }
        if (src.left === 0n) si += 1;
      }
    }
    const ids = await repo.insertAllocations(db, rows);
    const applied = rows.reduce((s, r) => s + toCents(r.amount), 0n);
    return {
      memberId: member.id, applied: fromCents(applied), creditRemaining: fromCents(creditTotal - applied),
      allocations: (await repo.allocationsByIds(db, ids)).map(mapAllocation),
    };
  }));
}

// ---- reads --------------------------------------------------------------------------------------------------------------------
export async function getPayment(env, identity, paymentId) {
  return withDatabase(env, async (db) => paymentView(db, (await activeProfile(db, identity)).id, paymentId));
}

export async function listPayments(env, identity, query = {}) {
  const f = {};
  if (query.academyId) f.academyId = query.academyId;
  if (query.memberId) f.memberId = query.memberId;
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "100", 10) || 100, 1), 200);
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return (await repo.listPayments(db, profile.id, f, limit)).map((r) => mapPayment(r));
  });
}

export async function memberPayments(env, identity, memberId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    if (!(await members.findMemberForOwner(db, profile.id, memberId))) throw new OwnerError("Member not found", 404);
    const [outstanding, credit, payments] = await Promise.all([
      repo.memberOutstanding(db, memberId), repo.memberCredit(db, memberId), repo.listPayments(db, profile.id, { memberId }, 200),
    ]);
    return { memberId, summary: { outstanding, availableCredit: credit }, payments: payments.map((r) => mapPayment(r)) };
  });
}

export async function memberCredit(env, identity, memberId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    if (!(await members.findMemberForOwner(db, profile.id, memberId))) throw new OwnerError("Member not found", 404);
    const [credit, sources] = await Promise.all([repo.memberCredit(db, memberId), repo.creditSources(db, memberId)]);
    return {
      memberId, availableCredit: credit,
      sources: sources.map((s) => ({ paymentId: s.id, receiptNumber: s.receipt_number, paymentDate: s.payment_date, unallocated: s.unallocated })),
    };
  });
}

export async function getMonthlyFee(env, identity, feeId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const fee = await repo.feeDetail(db, profile.id, feeId);
    if (!fee) throw new OwnerError("Monthly fee not found", 404);
    const allocations = await repo.allocationsForFee(db, feeId);
    return {
      id: fee.id, membershipId: fee.membership_id, feeMonth: fee.fee_month, applicableFee: fee.applicable_fee, status: fee.status,
      paidAmount: fee.paid_amount, balance: fee.balance, memberId: fee.member_id, memberName: fee.member_name,
      batchId: fee.batch_id, batchName: fee.batch_name, type: fee.batch_type, courtName: fee.court_name,
      payments: allocations.map((a) => ({ allocationId: a.id, paymentId: a.payment_id, receiptNumber: a.receipt_number, paymentDate: a.payment_date, paymentMode: a.payment_mode, amount: a.amount })),
    };
  });
}
