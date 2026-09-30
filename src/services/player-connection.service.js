import { withDatabase, withTransaction } from "../db/database.js";
import * as players from "../repositories/player.repository.js";
import * as connections from "../repositories/player-connection.repository.js";
import * as users from "../repositories/user.repository.js";
import { emit } from "./notification.events.js";

export class PlayerConnectionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function relationshipState(currentPlayerId, row) {
  if (!row) return "NONE";
  if (row.status === "ACCEPTED") return "CONNECTED";
  if (row.status === "PENDING") {
    return row.requester_player_id === currentPlayerId ? "REQUESTED" : "INCOMING";
  }
  return "NONE";
}

function publicPlayer(row) {
  return {
    id: row.id,
    playerCode: row.player_code,
    fullName: row.full_name,
    gender: row.gender ?? null,
    dob: row.dob ? String(row.dob).slice(0, 10) : null,
    location: row.location ?? null,
    playingSince: row.playing_since ?? null,
    courtAcademy: row.court_academy ?? null,
    profilePhoto: row.profile_photo_url ?? null,
    profileStatus: row.profile_status,
  };
}

async function currentPlayer(db, identity) {
  if (!identity || identity.role !== "PLAYER") {
    throw new PlayerConnectionError("An authenticated PLAYER account is required", 403);
  }
  const user = await users.findById(db, identity.sub);
  if (!user?.is_active) throw new PlayerConnectionError("Authentication is no longer valid", 401);
  const player = await players.findByUserId(db, user.id);
  if (!player || player.profile_status !== "ACTIVE") {
    throw new PlayerConnectionError("An active player profile is required", 403);
  }
  return player;
}

function relationship(row, currentId) {
  return {
    connectionId: row.connection_id ?? row.id ?? null,
    connectionState: relationshipState(currentId, {
      status: row.connection_status ?? row.status,
      requester_player_id: row.connection_requester_id ?? row.requester_player_id,
    }),
  };
}

function discoverItem(row, currentId) {
  return { player: publicPlayer(row), ...relationship(row, currentId) };
}

function requestItem(row) {
  return {
    connectionId: row.connection_id,
    player: publicPlayer(row),
    createdAt: row.connection_created_at,
    updatedAt: row.connection_updated_at ?? null,
  };
}

export function discover(env, identity, search) {
  return withDatabase(env, async (db) => {
    const current = await currentPlayer(db, identity);
    return (await connections.discover(db, current.id, search)).map((row) => discoverItem(row, current.id));
  });
}

export function accepted(env, identity) {
  return withDatabase(env, async (db) => {
    const current = await currentPlayer(db, identity);
    return (await connections.acceptedFor(db, current.id)).map((row) => ({
      connectionId: row.connection_id, player: publicPlayer(row), connectionState: "CONNECTED",
    }));
  });
}

export function requests(env, identity) {
  return withDatabase(env, async (db) => {
    const current = await currentPlayer(db, identity);
    return {
      received: (await connections.pendingFor(db, current.id, "received")).map(requestItem),
      sent: (await connections.pendingFor(db, current.id, "sent")).map(requestItem),
    };
  });
}

export function profile(env, identity, playerId) {
  return withDatabase(env, async (db) => {
    const current = await currentPlayer(db, identity);
    const player = await players.findById(db, playerId);
    if (!player || player.profile_status !== "ACTIVE") throw new PlayerConnectionError("Player not found", 404);
    if (player.id === current.id) throw new PlayerConnectionError("Player not found", 404);
    const row = await connections.findPair(db, current.id, player.id);
    return { player: publicPlayer(player), ...relationship(row, current.id) };
  });
}

export function request(env, identity, targetPlayerId) {
  return withTransaction(env, async (db) => {
    const current = await currentPlayer(db, identity);
    if (current.id === targetPlayerId) throw new PlayerConnectionError("You cannot connect with yourself", 400);
    const target = await players.findById(db, targetPlayerId);
    if (!target || target.profile_status !== "ACTIVE") throw new PlayerConnectionError("Player not found", 404);
    const existing = await connections.findPair(db, current.id, target.id, true);
    let row;
    if (!existing) row = await connections.insert(db, current.id, target.id);
    else if (existing.status === "ACCEPTED") throw new PlayerConnectionError("Players are already connected", 409);
    else if (existing.status === "PENDING") {
      if (existing.requester_player_id === current.id) return { connectionId: existing.id, connectionState: "REQUESTED" };
      throw new PlayerConnectionError("This player has already requested to connect with you", 409);
    } else row = await connections.updatePending(db, existing.id, current.id, target.id);
    // Only the insert/updatePending branches reach here — the idempotent
    // double-tap branch above returns early — so this fires exactly once
    // per real PENDING transition, never on a repeated Connect tap.
    if (target.user_id) {
      await emit(db, {
        recipientId: target.user_id,
        recipientRole: "PLAYER",
        type: "CONNECTION_REQUEST",
        title: "Connection Request",
        message: `${current.full_name} wants to connect with you.`,
        link: `connection:${row.id}`,
        dedupeKey: `CONNECTION_REQUEST:${row.id}:${new Date(row.updated_at).getTime()}`,
      });
    }
    return { connectionId: row.id, connectionState: "REQUESTED" };
  });
}

async function changeRequest(env, identity, connectionId, status) {
  return withTransaction(env, async (db) => {
    const current = await currentPlayer(db, identity);
    const row = await connections.findById(db, connectionId, true);
    if (!row) throw new PlayerConnectionError("Connection request not found", 404);
    if (row.recipient_player_id !== current.id) throw new PlayerConnectionError("Only the recipient can respond to this request", 403);
    if (row.status !== "PENDING") throw new PlayerConnectionError("Connection request is no longer pending", 409);
    const updated = await connections.updateStatus(db, connectionId, status);
    if (status === "ACCEPTED") {
      const requester = await players.findById(db, updated.requester_player_id);
      if (requester?.user_id) {
        await emit(db, {
          recipientId: requester.user_id,
          recipientRole: "PLAYER",
          type: "CONNECTION_ACCEPTED",
          title: "Connection Accepted",
          message: `${current.full_name} accepted your connection request.`,
          // Player profile id (not connection id) — CONNECTION_ACCEPTED has no
          // action, only "View Profile", so it links straight to the accepter.
          link: `player:${current.id}`,
          dedupeKey: `CONNECTION_ACCEPTED:${updated.id}:${new Date(updated.accepted_at).getTime()}`,
        });
      }
    }
    return { connectionId: updated.id, connectionState: status === "ACCEPTED" ? "CONNECTED" : "NONE" };
  });
}

export const accept = (env, identity, id) => changeRequest(env, identity, id, "ACCEPTED");
export const decline = (env, identity, id) => changeRequest(env, identity, id, "DECLINED");

export function unconnect(env, identity, connectionId) {
  return withTransaction(env, async (db) => {
    const current = await currentPlayer(db, identity);
    const deleted = await connections.deleteAcceptedFor(db, connectionId, current.id);
    if (!deleted) throw new PlayerConnectionError("Connected player not found", 404);
    return { connectionId, connectionState: "NONE" };
  });
}
