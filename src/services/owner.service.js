import { withDatabase, withTransaction } from "../db/database.js";
import * as owner from "../repositories/owner.repository.js";
import * as users from "../repositories/user.repository.js";
import { countActiveOnCourt } from "../repositories/owner-batch.repository.js";

export class OwnerError extends Error {
  constructor(message, status = 400, details = null) { super(message); this.status = status; this.details = details; }
}

const STATUSES = ["ACTIVE", "INACTIVE"];
const OPTIONAL_TEXT = { mobile: 20, address: 300, area: 100, city: 100, state: 100, pincode: 10 };

function body(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  return input;
}

export function nameValue(value, label) {
  if (typeof value !== "string") throw new OwnerError(`${label} is required`);
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new OwnerError(`${label} is required`);
  if (name.length > 100) throw new OwnerError(`${label} must be at most 100 characters`);
  return name;
}

function statusValue(value) {
  if (!STATUSES.includes(value)) throw new OwnerError("status must be ACTIVE or INACTIVE");
  return value;
}

// Optional text fields: undefined = untouched, ""/null = cleared, string = trimmed value.
function optionalText(patch, input) {
  for (const [key, max] of Object.entries(OPTIONAL_TEXT)) {
    if (!Object.hasOwn(input, key)) continue;
    const raw = input[key];
    if (raw == null || (typeof raw === "string" && !raw.trim())) { patch[key] = null; continue; }
    if (typeof raw !== "string") throw new OwnerError(`${key} must be text`);
    const text = raw.trim();
    if (text.length > max) throw new OwnerError(`${key} must be at most ${max} characters`);
    patch[key] = text;
  }
  if (patch.mobile != null && !/^\+?[0-9 ]{10,15}$/.test(patch.mobile)) throw new OwnerError("mobile must be a valid phone number");
  if (patch.pincode != null && !/^[0-9]{4,10}$/.test(patch.pincode)) throw new OwnerError("pincode must be numeric");
  return patch;
}

export function academyInput(input) {
  const data = body(input);
  return { name: nameValue(data.name, "Academy name"), ...optionalText({}, data) };
}

export function academyPatch(input) {
  const data = body(input);
  const patch = optionalText({}, data);
  if (Object.hasOwn(data, "name")) patch.name = nameValue(data.name, "Academy name");
  if (Object.hasOwn(data, "status")) patch.status = statusValue(data.status);
  if (!Object.keys(patch).length) throw new OwnerError("No updatable fields supplied");
  return patch;
}

export function courtPatch(input) {
  const data = body(input);
  const patch = {};
  if (Object.hasOwn(data, "name")) patch.name = nameValue(data.name, "Court name");
  if (Object.hasOwn(data, "status")) patch.status = statusValue(data.status);
  if (!Object.keys(patch).length) throw new OwnerError("No updatable fields supplied");
  return patch;
}

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

export function mapProfile(row) {
  return { id: row.id, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
export function mapAcademy(row) {
  return {
    id: row.id, name: row.name, mobile: row.mobile ?? null, address: row.address ?? null, area: row.area ?? null,
    city: row.city ?? null, state: row.state ?? null, pincode: row.pincode ?? null, status: row.status,
    activeCourtCount: row.active_court_count ?? 0, courtCount: row.court_count ?? 0,
    activeRegularBatchCount: row.active_regular_batch_count ?? 0, activeCoachingBatchCount: row.active_coaching_batch_count ?? 0, activeMemberCount: row.active_member_count ?? 0,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}
export function mapCourt(row) {
  return { id: row.id, academyId: row.academy_id, name: row.name, status: row.status, displayOrder: row.display_order,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

// Identity comes only from the verified bearer token. The owner profile is looked up by that user id;
// no client-supplied user or owner id is ever read.
async function activeUser(db, identity) {
  if (!identity?.sub) throw new OwnerError("Authentication required", 401);
  const user = await users.findById(db, identity.sub);
  if (!user?.is_active) throw new OwnerError("Authentication is no longer valid", 401);
  return user;
}
export async function activeProfile(db, identity) {
  const user = await activeUser(db, identity);
  const profile = await owner.findProfileByUserId(db, user.id);
  if (!profile) throw new OwnerError("Owner profile required", 403);
  if (profile.status !== "ACTIVE") throw new OwnerError("Owner profile is inactive", 403);
  return profile;
}

// 200 with data:null when the user has no Owner profile yet, so the app can route to onboarding.
export async function getProfile(env, identity) {
  return withDatabase(env, async (db) => {
    const user = await activeUser(db, identity);
    const profile = await owner.findProfileByUserId(db, user.id);
    return profile ? mapProfile(profile) : null;
  });
}

// Grants Owner capability only: inserts one owner_profiles row. users.role is never written.
export async function createProfile(env, identity) {
  return withTransaction(env, async (db) => {
    const user = await activeUser(db, identity);
    return mapProfile(await owner.insertProfile(db, user.id));
  });
}

export async function listAcademies(env, identity) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return (await owner.listAcademies(db, profile.id)).map(mapAcademy);
  });
}

export async function createAcademy(env, identity, input) {
  const values = academyInput(input);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const { id } = await owner.insertAcademy(db, profile.id, values);
    return mapAcademy(await owner.findAcademy(db, profile.id, id));
  });
}

export async function getAcademy(env, identity, academyId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const academy = await owner.findAcademy(db, profile.id, academyId);
    if (!academy) throw new OwnerError("Academy not found", 404);
    return mapAcademy(academy);
  });
}

export async function updateAcademy(env, identity, academyId, input) {
  const patch = academyPatch(input);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    if (!(await owner.findAcademy(db, profile.id, academyId, true))) throw new OwnerError("Academy not found", 404);
    return mapAcademy(await owner.updateAcademy(db, profile.id, academyId, patch));
  });
}

export async function listCourts(env, identity, academyId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    if (!(await owner.findAcademy(db, profile.id, academyId))) throw new OwnerError("Academy not found", 404);
    return (await owner.listCourts(db, academyId)).map(mapCourt);
  });
}

export async function createCourt(env, identity, academyId, input) {
  const name = nameValue(body(input).name, "Court name");
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    // Locking the academy row serialises concurrent court inserts so display_order stays unique-ish.
    const academy = await owner.findAcademy(db, profile.id, academyId, true);
    if (!academy) throw new OwnerError("Academy not found", 404);
    if (academy.status !== "ACTIVE") throw new OwnerError("Academy is inactive", 409);
    return mapCourt(await owner.insertCourt(db, academyId, name));
  });
}

export async function updateCourt(env, identity, courtId, input) {
  const patch = courtPatch(input);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const court = await owner.findCourtForOwner(db, profile.id, courtId, true);
    if (!court) throw new OwnerError("Court not found", 404);
    // The court row is locked above, which also serialises against concurrent batch writes on this court.
    if (patch.status === "INACTIVE" && court.status !== "INACTIVE" && (await countActiveOnCourt(db, courtId)) > 0) {
      throw new OwnerError("Court has active batches. Deactivate or move them before deactivating the court", 409);
    }
    return mapCourt(await owner.updateCourt(db, courtId, patch));
  });
}
