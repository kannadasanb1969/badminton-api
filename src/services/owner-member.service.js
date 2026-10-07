import { withDatabase, withTransaction } from "../db/database.js";
import * as repo from "../repositories/owner-member.repository.js";
import * as owner from "../repositories/owner.repository.js";
import { leavesForMember } from "../repositories/owner-fee.repository.js";
import { OwnerError, activeProfile } from "./owner.service.js";

const STATUSES = ["ACTIVE", "INACTIVE"];
const has = (o, k) => Object.hasOwn(o, k);
const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

function body(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  return input;
}

export function nameValue(v) {
  if (typeof v !== "string" || !v.trim()) throw new OwnerError("Member name is required");
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length > 100) throw new OwnerError("Member name must be at most 100 characters");
  return name;
}

// Canonical academy-scoped mobile: the 10 national digits ("+91 98765-43210", "09876543210" -> "9876543210").
// Empty means "no mobile" (null). Names are never used as identity.
export function mobileValue(v) {
  if (v == null || (typeof v === "string" && !v.trim())) return null;
  if (typeof v !== "string") throw new OwnerError("mobile must be text");
  let digits = v.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!/^[0-9]{10}$/.test(digits)) throw new OwnerError("mobile must be a valid 10-digit number");
  return digits;
}

// Calendar dates only ("YYYY-MM-DD"). "Today" is the Owner's calendar day (India, UTC+05:30).
export const todayIST = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
export function dateValue(v, label = "Effective date") {
  if (v == null) return todayIST();
  const parsed = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  // Invalid calendar dates (month 13, Feb 30) parse to an invalid Date; round-tripping also catches overflow.
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
    throw new OwnerError(`${label} must be a valid date in YYYY-MM-DD format`);
  }
  // Future-dated changes would need a scheduler and would otherwise pretend to have happened. Not supported yet.
  if (v > todayIST()) throw new OwnerError(`${label} cannot be in the future. Choose today or an earlier date`);
  return v;
}

export function memberCreateInput(input) {
  const d = body(input);
  if (typeof d.academyId !== "string" || !d.academyId) throw new OwnerError("academyId is required");
  return { academyId: d.academyId, name: nameValue(d.name), mobile: mobileValue(d.mobile) };
}
export function memberPatchInput(input) {
  const d = body(input);
  const p = {};
  if (has(d, "name")) p.name = nameValue(d.name);
  if (has(d, "mobile")) p.mobile = mobileValue(d.mobile);
  if (has(d, "status")) {
    if (!STATUSES.includes(d.status)) throw new OwnerError("status must be ACTIVE or INACTIVE");
    p.status = d.status;
  }
  if (!Object.keys(p).length) throw new OwnerError("No updatable fields supplied");
  return p;
}

export function mapMember(row) {
  const active = Array.isArray(row.active_memberships) ? row.active_memberships : null;
  return {
    id: row.id, academyId: row.academy_id, linkedUserId: row.linked_user_id ?? null, name: row.name, mobile: row.mobile ?? null,
    status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(active ? { activeMembershipCount: active.length, activeMemberships: active } : {}),
  };
}
export function mapMembership(row) {
  return {
    id: row.id, memberId: row.member_id, batchId: row.batch_id, status: row.status, startDate: row.start_ymd, endDate: row.end_ymd ?? null,
    batch: { name: row.batch_name, type: row.batch_type, status: row.batch_status, courtName: row.court_name,
      startTime: row.batch_start, endTime: row.batch_end, feePerPerson: row.fee_per_person },
  };
}

// Database constraints are the last line of defence against concurrent duplicates; translate them to clear 409s.
function translate(error) {
  if (error?.code === "23505") {
    if (error.constraint === "owner_members_active_mobile_uidx") return new OwnerError("An active member with this mobile number already exists in this academy", 409);
    if (error.constraint === "owner_memberships_active_member_batch_uidx") return new OwnerError("This member already has an active membership in this batch", 409);
  }
  return error;
}
async function guarded(fn) {
  try { return await fn(); } catch (e) { throw translate(e); }
}

export async function listMembers(env, identity, filters = {}) {
  const f = {};
  if (filters.academyId) f.academyId = filters.academyId;
  if (filters.status) {
    if (!STATUSES.includes(filters.status)) throw new OwnerError("status must be ACTIVE or INACTIVE");
    f.status = filters.status;
  }
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return (await repo.listMembers(db, profile.id, f)).map(mapMember);
  });
}

export async function createMember(env, identity, input) {
  const v = memberCreateInput(input);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const academy = await owner.findAcademy(db, profile.id, v.academyId);
    if (!academy) throw new OwnerError("Academy not found", 404);
    if (academy.status !== "ACTIVE") throw new OwnerError("Academy is inactive", 409);
    return mapMember(await repo.insertMember(db, v.academyId, v.name, v.mobile));
  }));
}

async function memberDetail(db, profileId, memberId) {
  const member = await repo.findMemberForOwner(db, profileId, memberId);
  if (!member) throw new OwnerError("Member not found", 404);
  const leaves = await leavesForMember(db, memberId);
  const all = (await repo.listMemberships(db, memberId)).map((row) => ({
    ...mapMembership(row), leaveMonths: leaves.filter((l) => l.membership_id === row.id).map((l) => l.fee_month),
  }));
  return { ...mapMember(member), activeMemberships: all.filter((m) => m.status === "ACTIVE"), history: all.filter((m) => m.status === "ENDED") };
}

export async function getMember(env, identity, memberId) {
  return withDatabase(env, async (db) => memberDetail(db, (await activeProfile(db, identity)).id, memberId));
}

export async function updateMember(env, identity, memberId, input) {
  const patch = memberPatchInput(input);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    // Member row lock serialises with membership creation / move / end for this member.
    const member = await repo.findMemberForOwner(db, profile.id, memberId, true);
    if (!member) throw new OwnerError("Member not found", 404);
    if (patch.status === "INACTIVE" && member.status === "ACTIVE" && (await repo.countActiveForMember(db, memberId)) > 0) {
      throw new OwnerError("Member has active memberships. End or move them before deactivating the member", 409);
    }
    await repo.updateMember(db, memberId, patch);
    return memberDetail(db, profile.id, memberId);
  }));
}

export async function listMemberships(env, identity, memberId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    if (!(await repo.findMemberForOwner(db, profile.id, memberId))) throw new OwnerError("Member not found", 404);
    return (await repo.listMemberships(db, memberId)).map(mapMembership);
  });
}

// Shared by assign and move. The batch row is locked FOR SHARE so it cannot be deactivated mid-transaction.
async function lockAssignableBatch(db, profileId, member, batchId) {
  if (typeof batchId !== "string" || !batchId) throw new OwnerError("batchId is required");
  const batch = await repo.lockBatchShare(db, profileId, batchId);
  if (!batch) throw new OwnerError("Batch not found", 404);
  if (batch.academy_id !== member.academy_id) throw new OwnerError("Batch belongs to a different academy than the member", 409);
  if (batch.status !== "ACTIVE") throw new OwnerError("Batch is inactive", 409);
  if (batch.court_status !== "ACTIVE") throw new OwnerError("The batch's court is inactive", 409);
  return batch;
}

export async function assignMembership(env, identity, memberId, input) {
  const d = body(input);
  const startDate = dateValue(d.startDate, "Start date");
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const member = await repo.findMemberForOwner(db, profile.id, memberId, true);
    if (!member) throw new OwnerError("Member not found", 404);
    if (member.status !== "ACTIVE") throw new OwnerError("Member is inactive", 409);
    const batch = await lockAssignableBatch(db, profile.id, member, d.batchId);
    const id = await repo.insertMembership(db, memberId, batch.id, startDate);
    return mapMembership(await repo.getMembership(db, id));
  }));
}

// Loads and locks (member first, then membership) so concurrent move/end/assign on one member serialise.
async function lockActiveMembership(db, profileId, membershipId) {
  const peek = await repo.findMembershipOwner(db, profileId, membershipId);
  if (!peek) throw new OwnerError("Membership not found", 404);
  const member = await repo.findMemberForOwner(db, profileId, peek.member_id, true);
  const membership = await repo.findMembershipOwner(db, profileId, membershipId, true);
  if (membership.status !== "ACTIVE") throw new OwnerError("Membership has already ended", 409);
  return { member, membership };
}

function effectiveAfterStart(date, membership) {
  if (date < membership.start_ymd) throw new OwnerError(`Effective date cannot be before the membership start date (${membership.start_ymd})`);
}

// One transaction: the old row is ended and the new row inserted, or neither. History is never overwritten.
export async function moveMembership(env, identity, membershipId, input) {
  const d = body(input);
  const date = dateValue(d.effectiveDate);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const { member, membership } = await lockActiveMembership(db, profile.id, membershipId);
    effectiveAfterStart(date, membership);
    if (d.batchId === membership.batch_id) throw new OwnerError("Member is already in this batch", 409);
    const batch = await lockAssignableBatch(db, profile.id, member, d.batchId);
    await repo.endMembership(db, membership.id, date);
    const id = await repo.insertMembership(db, member.id, batch.id, date);
    return mapMembership(await repo.getMembership(db, id));
  }));
}

export async function endMembership(env, identity, membershipId, input) {
  const d = body(input ?? {});
  const date = dateValue(d.effectiveDate);
  return guarded(() => withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const { membership } = await lockActiveMembership(db, profile.id, membershipId);
    effectiveAfterStart(date, membership);
    await repo.endMembership(db, membership.id, date);
    return mapMembership(await repo.getMembership(db, membership.id));
  }));
}
