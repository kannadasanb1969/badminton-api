import { withDatabase, withTransaction } from "../db/database.js";
import * as guests from "../repositories/guestPlayer.repository.js";

export class GuestPlayerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const fields = {
  fullName: "full_name", mobile: "mobile", gender: "gender", dob: "dob",
  location: "location", playingSince: "playing_since", regularPlayer: "regular_player",
  courtAcademy: "court_academy",
};

function validate(input, existing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new GuestPlayerError("Request body must be a JSON object", 400);
  }
  const result = existing
    ? Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, existing[column]]))
    : { gender: null, dob: null, location: null, playingSince: null,
        regularPlayer: false, courtAcademy: null };
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(input, key)) result[key] = input[key];
  }
  for (const key of ["fullName", "mobile"]) {
    if (typeof result[key] !== "string" || !result[key].trim()) {
      throw new GuestPlayerError(`${key} is required and must be a non-empty string`, 400);
    }
    result[key] = result[key].trim();
  }
  for (const key of ["gender", "location", "courtAcademy"]) {
    if (result[key] !== null && typeof result[key] !== "string") {
      throw new GuestPlayerError(`${key} must be a string or null`, 400);
    }
  }
  if (result.gender !== null && !["MALE", "FEMALE", "OTHER"].includes(result.gender)) {
    throw new GuestPlayerError("gender must be MALE, FEMALE, OTHER, or null", 400);
  }
  if (typeof result.regularPlayer !== "boolean") throw new GuestPlayerError("regularPlayer must be a boolean", 400);
  if (result.playingSince !== null && (!Number.isInteger(result.playingSince) || result.playingSince < -2147483648 || result.playingSince > 2147483647)) {
    throw new GuestPlayerError("playingSince must be an integer or null", 400);
  }
  // pg may return an existing DATE as a Date object; validate only supplied dates.
  if (Object.hasOwn(input, "dob") && input.dob !== null) {
    const date = typeof input.dob === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dob) ? new Date(`${input.dob}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.dob) {
      throw new GuestPlayerError("dob must be a valid YYYY-MM-DD date or null", 400);
    }
  }
  return result;
}

function required(player) {
  if (!player) throw new GuestPlayerError("Guest player not found", 404);
  return player;
}

async function checkDuplicate(db, player, id) {
  if (await guests.findDuplicate(db, player.fullName, player.mobile, id)) {
    throw new GuestPlayerError("A guest player with this name and mobile number already exists", 409);
  }
  if (await guests.findRegisteredPlayer(db, player.fullName, player.mobile)) {
    throw new GuestPlayerError("This person already has a registered player profile", 409);
  }
}

export const listGuests = (env) => withDatabase(env, guests.findAll);
export const getGuest = (env, id) => withDatabase(env, async (db) => required(await guests.findById(db, id)));
export const getGuestByCode = (env, code) => withDatabase(env, async (db) => required(await guests.findByCode(db, code)));

export async function createGuest(env, input) {
  const player = validate(input);
  return withTransaction(env, async (db) => {
    await guests.lockGuests(db);
    await checkDuplicate(db, player);
    const next = BigInt(await guests.highestCodeNumber(db)) + 1n;
    const code = `GST${next.toString().padStart(6, "0")}`;
    return guests.insert(db, player, code);
  });
}

export function updateGuest(env, id, input) {
  return withTransaction(env, async (db) => {
    await guests.lockGuests(db);
    const existing = required(await guests.findById(db, id));
    const player = validate(input, existing);
    if (player.fullName !== existing.full_name || player.mobile !== existing.mobile) {
      await checkDuplicate(db, player, id);
    }
    return guests.update(db, id, player);
  });
}
