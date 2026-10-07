import { withDatabase } from "../db/database.js";
import * as dash from "../repositories/owner-dashboard.repository.js";
import * as fees from "../repositories/owner-fee.repository.js";
import * as ownerRepo from "../repositories/owner.repository.js";
import { OwnerError, activeProfile } from "./owner.service.js";
import { feeScope, mapFee, mapNotGenerated, mapSummary, monthValue } from "./owner-fee.service.js";
import { currentMonthIST, monthEnd } from "../utils/owner-dates.js";

const RECENT_LIMIT = 5;
const ATTENTION_LIMIT = 10;

// One consolidated read. Every figure comes from a PostgreSQL aggregate; the number of queries is constant (it does not grow with
// members, payments or fees). Totals and lists reuse the Fees repository functions, so they match the Fees screen exactly.
export async function loadDashboard(db, profile, query = {}) {
  let academy;
  if (query.academyId) academy = await ownerRepo.findAcademy(db, profile.id, query.academyId);
  else academy = (await ownerRepo.listAcademies(db, profile.id))[0];
  if (!academy) throw new OwnerError("Academy not found", 404);

  const feeMonth = query.feeMonth ? monthValue(query.feeMonth) : currentMonthIST();
  const scope = feeScope({ courtId: query.courtId, batchId: query.batchId, type: query.type });
  const feeScopeFull = { ...scope, academyId: academy.id, feeMonth };

  const [ops, summary, gap, attention, byBatch, recent, credit, options] = await Promise.all([
    dash.operations(db, academy.id),
    fees.summarizeFees(db, profile.id, feeScopeFull),
    fees.notGenerated(db, academy.id, feeMonth, monthEnd(feeMonth), scope, { limit: ATTENTION_LIMIT }),
    fees.listFees(db, profile.id, { ...feeScopeFull, outstanding: true }, { limit: ATTENTION_LIMIT }),
    dash.pendingByBatch(db, academy.id, feeMonth, scope, { limit: ATTENTION_LIMIT }),
    dash.recentPayments(db, academy.id, RECENT_LIMIT),
    dash.creditSummary(db, academy.id, { limit: ATTENTION_LIMIT }),
    dash.filterOptions(db, academy.id),
  ]);

  const financial = mapSummary(summary);
  const notGenerated = mapNotGenerated(gap);
  return {
    academy: { id: academy.id, name: academy.name, city: academy.city ?? null, area: academy.area ?? null },
    feeMonth,
    filters: { courtId: scope.courtId ?? null, batchId: scope.batchId ?? null, type: scope.type ?? null },
    // Academy-wide people/court counts. They describe who is in the academy today and are not narrowed by the collection filters.
    operations: {
      activeCourts: ops.active_courts, activeBatches: ops.active_batches, activeMembers: ops.active_members,
      regularPlayers: ops.regular_players, coachingStudents: ops.coaching_students, activeMemberships: ops.active_memberships,
    },
    financial: { ...financial, notGeneratedCount: notGenerated.count, missingFeeRateCount: notGenerated.missingFeeRateCount },
    needsAttention: {
      outstandingCount: financial.pendingCount + financial.partiallyPaidCount,
      outstanding: attention.map(mapFee),
      notGenerated,
      pendingByBatch: byBatch.map((r) => ({ batchId: r.batch_id, batchName: r.batch_name, type: r.batch_type, courtName: r.court_name, feeCount: r.fee_count, outstanding: r.outstanding })),
    },
    recentPayments: recent.map((r) => ({
      id: r.id, receiptNumber: r.receipt_number, amount: r.amount, paymentMode: r.payment_mode, paymentDate: r.payment_date,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at, memberId: r.member_id, memberName: r.member_name,
    })),
    credit,
    options: {
      courts: options.courts.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      batches: options.batches.map((b) => ({ id: b.id, courtId: b.court_id, name: b.name, type: b.batch_type, status: b.status })),
    },
  };
}

export async function getDashboard(env, identity, query = {}) {
  return withDatabase(env, async (db) => loadDashboard(db, await activeProfile(db, identity), query));
}
