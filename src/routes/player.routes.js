import { mapPlayerRow } from "../mappers/player.mapper.js";
import * as service from "../services/player.service.js";
import { successResponse, errorResponse } from "../utils/response.js";

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new service.PlayerError("Request body must contain valid JSON", 400);
  }
}

export async function handlePlayerRoutes(request, env) {
  try {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const parts = path.split("/").slice(3).map((part) => {
      try { return decodeURIComponent(part); }
      catch { throw new service.PlayerError("Invalid URL encoding", 400); }
    });
    if (parts.length === 0) {
      if (request.method === "GET") return successResponse((await service.listPlayers(env)).map((row) => mapPlayerRow(row)));
      if (request.method === "POST") return successResponse(mapPlayerRow(await service.createPlayer(env, await body(request))), 201);
    } else if (parts.length === 2 && parts[0] === "code" && parts[1]) {
      if (request.method === "GET") return successResponse(mapPlayerRow(await service.getPlayerByCode(env, parts[1])));
    } else if (parts.length === 2 && parts[1] === 'link-user') {
      if(request.method!=='POST')return errorResponse('Method not allowed',405);const data=await body(request);if(!data?.userId)throw new service.PlayerError('userId is required',400);return successResponse(mapPlayerRow(await service.linkUser(env,parts[0],data.userId)));
    } else if (parts.length === 1 && parts[0]) {
      const id = parts[0];
      if (request.method === "GET") return successResponse(mapPlayerRow(await service.getPlayer(env, id)));
      if (request.method === "PUT") return successResponse(mapPlayerRow(await service.updatePlayer(env, id, await body(request))));
      if (request.method === "DELETE") return successResponse(await service.deletePlayer(env, id));
    } else {
      return errorResponse("API endpoint not found", 404);
    }
    return errorResponse("Method not allowed", 405);
  } catch (error) {
    if (error instanceof service.PlayerError) return errorResponse(error.message, error.status);
    if (error.code === "23503") return errorResponse("Player is referenced by other records", 409);
    if (error.code === "23505") return errorResponse("Player conflicts with an existing record", 409);
    if (["22001", "22007", "22008", "22P02", "23514", "23502"].includes(error.code)) {
      return errorResponse("Player data does not satisfy database constraints", 400);
    }
    // Avoid returning database details or credentials to clients or logs.
    console.error("Player API request failed", { code: error.code ?? "UNKNOWN" });
    return errorResponse("Unable to complete player request", 500);
  }
}
