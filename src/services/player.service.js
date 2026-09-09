import { withDatabase, withTransaction } from "../db/database.js";
import * as players from "../repositories/player.repository.js";

export class PlayerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const fields = {
  fullName: "full_name", mobile: "mobile", gender: "gender", dob: "dob",
  location: "location", playingSince: "playing_since", regularPlayer: "regular_player",
  courtAcademy: "court_academy", profilePhotoUrl: "profile_photo_url", profileStatus: "profile_status",
};

function validate(input, existing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PlayerError("Request body must be a JSON object", 400);
  }
  const result = existing
    ? Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, existing[column]]))
    : { gender: null, dob: null, location: null, playingSince: null,
        regularPlayer: false, courtAcademy: null, profilePhotoUrl: null, profileStatus: "ACTIVE" };
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(input, key)) result[key] = input[key];
  }
  // Keep the previous request alias working; React uses profilePhoto.
  if (Object.hasOwn(input, "profilePhoto")) result.profilePhotoUrl = input.profilePhoto;
  for (const key of ["fullName", "mobile", "profileStatus"]) {
    if (typeof result[key] !== "string" || !result[key].trim()) {
      throw new PlayerError(`${key} is required and must be a non-empty string`, 400);
    }
    result[key] = result[key].trim();
  }
  for (const key of ["gender", "location", "courtAcademy", "profilePhotoUrl"]) {
    if (result[key] !== null && typeof result[key] !== "string") {
      throw new PlayerError(`${key} must be a string or null`, 400);
    }
  }
  if (typeof result.regularPlayer !== "boolean") throw new PlayerError("regularPlayer must be a boolean", 400);
  if (result.playingSince !== null && (!Number.isInteger(result.playingSince) || result.playingSince < -2147483648 || result.playingSince > 2147483647)) {
    throw new PlayerError("playingSince must be an integer or null", 400);
  }
  // pg may return an existing DATE as a Date object; validate only supplied dates.
  if (Object.hasOwn(input, "dob") && input.dob !== null) {
    const date = typeof input.dob === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dob) ? new Date(`${input.dob}T00:00:00Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.dob) {
      throw new PlayerError("dob must be a valid YYYY-MM-DD date or null", 400);
    }
  }
  return result;
}

function required(player) {
  if (!player) throw new PlayerError("Player not found", 404);
  return player;
}

async function checkDuplicate(db, player, id) {
  if (await players.findDuplicate(db, player.fullName, player.mobile, id)) {
    throw new PlayerError("A player with this name and mobile number already exists", 409);
  }
}

export const listPlayers = (env) => withDatabase(env, players.findAll);
export const getPlayer = (env, id) => withDatabase(env, async (db) => required(await players.findById(db, id)));
export const getPlayerByCode = (env, code) => withDatabase(env, async (db) => required(await players.findByCode(db, code)));

export async function createPlayer(env, input) {
  const player = validate(input);
  return withTransaction(env, async (db) => {
    await players.lockPlayers(db);
    await checkDuplicate(db, player);
    const next = BigInt(await players.highestCodeNumber(db)) + 1n;
    const code = `PLR${next.toString().padStart(6, "0")}`;
    return players.insert(db, player, code);
  });
}

export function updatePlayer(env, id, input) {
  return withTransaction(env, async (db) => {
    await players.lockPlayers(db);
    const existing = required(await players.findById(db, id));
    const player = validate(input, existing);
    await checkDuplicate(db, player, id);
    return players.update(db, id, player);
  });
}

export function deletePlayer(env, id) {
  return withTransaction(env, async (db) => {
    await players.lockPlayers(db);
    return required(await players.remove(db, id));
  });
}
export function linkUser(env,playerId,userId){return withTransaction(env,async db=>{const p=required(await players.findById(db,playerId));const u=await players.findUser(db,userId);if(!u||!u.is_active||u.role!=='PLAYER')throw new PlayerError('An active PLAYER user is required',400);if(p.user_id===userId)return p;if(p.user_id)throw new PlayerError('Player is already linked to another user',409);const other=await players.findByUserId(db,userId);if(other&&other.id!==playerId)throw new PlayerError('User is already linked to another player',409);return players.linkUser(db,playerId,userId);});}
