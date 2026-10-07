import { withDatabase, withTransaction } from "../db/database.js";
import * as fees from "../repositories/owner-fee.repository.js";
import * as members from "../repositories/owner-member.repository.js";
import * as ownerRepo from "../repositories/owner.repository.js";
import * as repo from "../repositories/owner-reminder.repository.js";
import { createWhatsAppProvider, normalizeIndianMobile, publicConfig, toE164India, whatsappConfig } from "../providers/whatsapp/index.js";
import { currentMonthIST, todayIST } from "../utils/owner-dates.js";
import { fromCents, toCents } from "../utils/owner-money.js";
import { buildReminder } from "./owner-reminder-message.js";
import { feeScope, monthValue } from "./owner-fee.service.js";
import { lockMemberScope } from "./owner-payment.service.js";
import { OwnerError, activeProfile } from "./owner.service.js";

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
const SCOPES = ["MONTH", "ALL_OUTSTANDING"];

// ---- scope ---------------------------------------------------------------------------------------------------------------------
// Scope and filters decide message coverage and are retained in audit history.
// Daily duplicate protection uses only academy + member + local date.
export function reminderScope(input = {}) {
  const scope = input.scope ?? "MONTH";
  if (!SCOPES.includes(scope)) throw new OwnerError("scope must be MONTH or ALL_OUTSTANDING");
  const narrow = feeScope({ courtId: input.courtId, batchId: input.batchId, type: input.type });
  const parts = [];
  let feeMonth = null;
  if (scope === "MONTH") {
    feeMonth = input.feeMonth ? monthValue(input.feeMonth) : currentMonthIST();
    parts.push(`MONTH:${feeMonth}`);
  } else {
    parts.push("ALL_OUTSTANDING");
  }
  if (narrow.courtId) parts.push(`court:${narrow.courtId}`);
  if (narrow.batchId) parts.push(`batch:${narrow.batchId}`);
  if (narrow.type) parts.push(`type:${narrow.type}`);
  return { scope, feeMonth, narrow, scopeKey: parts.join("|") };
}

// Same filter object the Fees list and the dashboard use, so "outstanding" means exactly one thing everywhere.
const outstandingFilter = (academyId, s, extra = {}) => ({ academyId, ...(s.feeMonth ? { feeMonth: s.feeMonth } : {}), ...s.narrow, outstanding: true, ...extra });

function memberOf(items) {
  const first = items[0];
  return { memberId: first.memberId, memberName: first.memberName, mobile: first.memberMobile ?? null };
}

function groupByMember(items) {
  const map = new Map();
  for (const i of items) {
    if (!map.has(i.member_id)) map.set(i.member_id, []);
    map.get(i.member_id).push({
      feeId: i.id, memberId: i.member_id, memberName: i.member_name, memberMobile: i.member_mobile ?? null,
      feeMonth: i.fee_month, batchName: i.batch_name, type: i.batch_type, courtName: i.court_name,
      applicableFee: i.applicable_fee, paidAmount: i.paid_amount, balance: i.balance, status: i.status,
    });
  }
  return map;
}

const publicItem = (i) => ({ feeMonth: i.feeMonth, batchName: i.batchName, type: i.type, courtName: i.courtName, applicableFee: i.applicableFee, paidAmount: i.paidAmount, balance: i.balance });

async function resolveAcademy(db, profile, academyId) {
  if (typeof academyId !== "string" || !academyId) throw new OwnerError("academyId is required");
  const academy = await ownerRepo.findAcademy(db, profile.id, academyId);
  if (!academy) throw new OwnerError("Academy not found", 404);
  return academy;
}

// Why a member has nothing to remind about right now.
async function nothingOutstandingReason(db, profileId, academyId, s, memberId) {
  const rows = await fees.memberFeeStates(db, profileId, { academyId, ...(s.feeMonth ? { feeMonth: s.feeMonth } : {}), ...s.narrow, memberId });
  if (!rows.length) return "NO_OUTSTANDING";
  return rows[0].has_leave ? "ON_LEAVE" : "PAID";
}

function recipientOf(mobile) {
  const to = toE164India(mobile);
  return to ? { to, display: normalizeIndianMobile(mobile) } : null;
}

// ---- eligibility (bulk view): member-grouped, never one row per obligation ----------------------------------------------------------
export async function listEligible(env, identity, query = {}, deps = {}) {
  const today = (deps.today ?? todayIST)();
  const s = reminderScope(query);
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const academy = await resolveAcademy(db, profile, query.academyId);
    const baseFilter = { academyId: academy.id, ...(s.feeMonth ? { feeMonth: s.feeMonth } : {}), ...s.narrow };
    const [rows, live, states] = await Promise.all([
      fees.listFees(db, profile.id, { ...baseFilter, outstanding: true }),
      repo.liveForDay(db, academy.id, today),
      fees.memberFeeStates(db, profile.id, baseFilter),
    ]);
    const grouped = groupByMember(rows);
    const liveBy = new Map(live.map((r) => [r.member_id, r.status]));
    const list = [];
    for (const [memberId, items] of grouped) {
      const total = fromCents(items.reduce((sum, i) => sum + toCents(i.balance), 0n));
      const recipient = recipientOf(items[0].memberMobile);
      const reminded = liveBy.get(memberId) ?? null;
      list.push({
        ...memberOf(items), itemCount: items.length, total, items: items.map(publicItem),
        status: reminded ? "ALREADY_REMINDED_TODAY" : !recipient ? "MISSING_MOBILE" : "ELIGIBLE",
        remindedToday: reminded, // SENT | DRY_RUN | SENDING
      });
    }
    list.sort((a, b) => (a.items[0].feeMonth === b.items[0].feeMonth ? a.memberName.localeCompare(b.memberName) || (a.memberId < b.memberId ? -1 : 1) : a.items[0].feeMonth < b.items[0].feeMonth ? -1 : 1));
    const withoutOutstanding = states.filter((r) => !r.has_outstanding);
    const count = (st) => list.filter((m) => m.status === st).length;
    return {
      config: publicConfig(env), scope: s.scope, feeMonth: s.feeMonth, scopeKey: s.scopeKey, reminderDate: today,
      summary: {
        candidates: list.length, eligibleMembers: count("ELIGIBLE"), alreadyRemindedToday: count("ALREADY_REMINDED_TODAY"), missingMobile: count("MISSING_MOBILE"),
        skippedLeave: withoutOutstanding.filter((r) => r.has_leave).length, skippedPaid: withoutOutstanding.filter((r) => !r.has_leave).length,
        totalOutstanding: fromCents(list.reduce((sum, m) => sum + toCents(m.total), 0n)),
      },
      members: list,
    };
  });
}

// ---- preview: read-only, creates no history ----------------------------------------------------------------------------------
export async function previewReminder(env, identity, input = {}, deps = {}) {
  const today = (deps.today ?? todayIST)();
  const s = reminderScope(input);
  if (typeof input.memberId !== "string" || !input.memberId) throw new OwnerError("memberId is required");
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const member = await members.findMemberForOwner(db, profile.id, input.memberId);
    if (!member) throw new OwnerError("Member not found", 404);
    const academy = await ownerRepo.findAcademy(db, profile.id, member.academy_id);
    const rows = await fees.listFees(db, profile.id, outstandingFilter(member.academy_id, s, { memberId: member.id }));
    const config = publicConfig(env);
    const live = await repo.findLive(db, member.academy_id, member.id, today);
    const base = { alreadyRemindedToday: Boolean(live), config, scope: s.scope, feeMonth: s.feeMonth, scopeKey: s.scopeKey, member: { id: member.id, name: member.name, mobile: member.mobile ?? null } };
    if (!rows.length) {
      return { ...base, eligible: false, reason: live ? "ALREADY_REMINDED_TODAY" : await nothingOutstandingReason(db, profile.id, member.academy_id, s, member.id), items: [], total: "0.00", message: null, recipient: null, sender: config.senderNumber };
    }
    const items = rows.map((i) => ({ feeMonth: i.fee_month, batchName: i.batch_name, balance: i.balance, type: i.batch_type, courtName: i.court_name, applicableFee: i.applicable_fee, paidAmount: i.paid_amount }));
    const built = buildReminder({ memberName: member.name, academyName: academy.name, items });
    const recipient = recipientOf(member.mobile);
    let reason = null;
    if (live) reason = "ALREADY_REMINDED_TODAY";
    else if (!recipient) reason = "MISSING_MOBILE";
    else if (!config.ready) reason = "SENDER_NOT_CONFIGURED";
    return {
      ...base, eligible: reason === null, reason, items: built.items.map(publicItem), total: fromCents(toCents(built.total)), message: built.body,
      recipient: recipient ? recipient.display : null, sender: config.senderNumber,
    };
  });
}

// ---- send ----------------------------------------------------------------------------------------------------------------------------
function skipped(reason, member) {
  return { result: "SKIPPED", reason, ...(member ? { memberId: member.id ?? member.memberId, memberName: member.name ?? member.memberName } : {}) };
}

// Phase 1 (one transaction, locks held): re-read the CURRENT balances, build the message, and claim the day's slot.
// Lock order is the same as every other money write: academy -> member -> the member's monthly fees. A payment or a leave change either
// finished before this read or waits until the claim has committed; nothing can slip in between "read balance" and "claim".
// Phase 2 (no locks held): call the provider. Phase 3: record exactly what the provider said.
export async function sendReminder(env, identity, input = {}, deps = {}) {
  const today = (deps.today ?? todayIST)();
  const s = reminderScope(input);
  if (typeof input.memberId !== "string" || !input.memberId) throw new OwnerError("memberId is required");
  const config = whatsappConfig(env);
  // Real sending is blocked (nothing claimed, nothing recorded) until the server is fully configured.
  if (!config.ready) throw new OwnerError(config.notReadyMessage ?? "WhatsApp is not configured", 409);
  const provider = deps.provider ?? createWhatsAppProvider(env);

  const claimed = await withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const member = await lockMemberScope(db, profile, input.memberId, { withPayments: false });
    const academy = await ownerRepo.findAcademy(db, profile.id, member.academy_id);
    await repo.abandonStaleClaims(db, member.academy_id, member.id, today);
    if (await repo.findLive(db, member.academy_id, member.id, today)) return { skip: skipped("ALREADY_REMINDED_TODAY", member) };
    const rows = await fees.listFees(db, profile.id, outstandingFilter(member.academy_id, s, { memberId: member.id }));
    if (!rows.length) return { skip: skipped(await nothingOutstandingReason(db, profile.id, member.academy_id, s, member.id), member) };
    const recipient = recipientOf(member.mobile);
    if (!recipient) return { skip: skipped("MISSING_MOBILE", member) };
    const built = buildReminder({
      memberName: member.name, academyName: academy.name,
      items: rows.map((i) => ({ feeMonth: i.fee_month, batchName: i.batch_name, balance: i.balance })),
    });
    const row = await repo.claim(db, {
      academyId: member.academy_id, memberId: member.id, scopeKey: s.scopeKey, reminderDate: today, sender: config.senderE164, recipient: recipient.to,
      body: built.body, total: fromCents(toCents(built.total)), itemCount: built.itemCount, provider: provider.name, userId: identity.sub,
    });
    if (!row) return { skip: skipped("ALREADY_REMINDED_TODAY", member) };
    return { id: row.id, from: config.senderE164, to: recipient.to, body: built.body, reminder: built.fields };
  });
  if (claimed.skip) return claimed.skip;

  let outcome;
  try {
    const r = await provider.sendMessage({ from: claimed.from, to: claimed.to, body: claimed.body, reminder: claimed.reminder });
    if (r?.success) outcome = r.dryRun ? { status: "DRY_RUN" } : { status: "SENT", providerMessageId: r.providerMessageId ?? null };
    else outcome = { status: "FAILED", failureCode: r?.errorCode ?? "PROVIDER_REJECTED", failureMessage: r?.errorMessage ?? "The provider did not accept the message" };
  } catch (error) {
    outcome = { status: "FAILED", failureCode: "PROVIDER_EXCEPTION", failureMessage: String(error?.message ?? error) };
  }
  return withDatabase(env, async (db) => {
    await repo.complete(db, claimed.id, outcome);
    const profile = await activeProfile(db, identity);
    return { result: outcome.status, reminder: mapReminder(await repo.getForOwner(db, profile.id, claimed.id)) };
  });
}

// ---- bulk ------------------------------------------------------------------------------------------------------------------------------
// Members are processed ONE AT A TIME. Each goes through the full recheck + claim + dispatch above, so every member is judged against
// current data and one failure never stops the job. Sequential on purpose: correctness over speed, and it cannot flood a provider.
export async function sendBulk(env, identity, input = {}, deps = {}) {
  const config = whatsappConfig(env);
  if (!config.ready) throw new OwnerError(config.notReadyMessage ?? "WhatsApp is not configured", 409);
  const view = await listEligible(env, identity, input, deps);
  const out = {
    config: view.config, scope: view.scope, feeMonth: view.feeMonth, candidates: view.summary.candidates, eligibleMembers: view.summary.eligibleMembers,
    sent: 0, dryRun: 0, failed: 0, skippedPaid: view.summary.skippedPaid, skippedLeave: view.summary.skippedLeave, missingMobile: 0, alreadyRemindedToday: 0, results: [],
  };
  const base = { academyId: input.academyId, scope: view.scope, feeMonth: view.feeMonth ?? undefined, courtId: input.courtId, batchId: input.batchId, type: input.type };
  for (const m of view.members) {
    let r;
    try {
      r = await sendReminder(env, identity, { ...base, memberId: m.memberId }, deps);
    } catch (error) {
      r = { result: "FAILED", reason: "ERROR", error: String(error?.message ?? error) };
    }
    if (r.result === "SENT") out.sent += 1;
    else if (r.result === "DRY_RUN") out.dryRun += 1;
    else if (r.result === "FAILED") out.failed += 1;
    else if (r.reason === "MISSING_MOBILE") out.missingMobile += 1;
    else if (r.reason === "ALREADY_REMINDED_TODAY") out.alreadyRemindedToday += 1;
    else if (r.reason === "ON_LEAVE") out.skippedLeave += 1;
    else out.skippedPaid += 1; // PAID / NO_OUTSTANDING: settled between the list and the send
    out.results.push({ memberId: m.memberId, memberName: m.memberName, result: r.result, ...(r.reason ? { reason: r.reason } : {}), ...(r.reminder ? { reminderId: r.reminder.id } : {}) });
  }
  return out;
}

// ---- history ---------------------------------------------------------------------------------------------------------------------------
export function mapReminder(r) {
  return {
    id: r.id, academyId: r.academy_id, memberId: r.member_id, memberName: r.member_name, scope: r.scope_key, reminderDate: r.reminder_date,
    sender: r.sender_number, recipient: r.recipient_number, message: r.message_body, totalOutstanding: r.total_outstanding, itemCount: r.item_count,
    status: r.status, delivered: r.status === "SENT", provider: r.provider, providerMessageId: r.provider_message_id ?? null,
    failureCode: r.failure_code ?? null, failureMessage: r.failure_message ?? null,
    attemptedAt: iso(r.created_at), completedAt: iso(r.completed_at), sentAt: iso(r.sent_at),
  };
}

export async function listReminders(env, identity, query = {}) {
  const f = {};
  if (query.academyId) f.academyId = query.academyId;
  if (query.memberId) f.memberId = query.memberId;
  if (query.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date)) throw new OwnerError("date must be YYYY-MM-DD");
    f.date = query.date;
  }
  if (query.status) {
    if (!["SENT", "FAILED", "DRY_RUN", "SENDING"].includes(query.status)) throw new OwnerError("status must be SENT, FAILED, DRY_RUN or SENDING");
    f.status = query.status;
  }
  const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "100", 10) || 100, 1), 200);
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return { config: publicConfig(env), items: (await repo.list(db, profile.id, f, limit)).map(mapReminder) };
  });
}

export async function getReminder(env, identity, id) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const row = await repo.getForOwner(db, profile.id, id);
    if (!row) throw new OwnerError("Reminder not found", 404);
    return mapReminder(row);
  });
}
