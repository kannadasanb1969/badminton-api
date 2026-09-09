import { mapGuestPlayerRow } from "../mappers/guestPlayer.mapper.js";
import * as service from "../services/guestPlayer.service.js";
import { successResponse, errorResponse } from "../utils/response.js";

async function body(request) {
  try {
    return await request.json();
  } catch {
    throw new service.GuestPlayerError("Request body must contain valid JSON", 400);
  }
}

export async function handleGuestPlayerRoutes(request, env) {
  try {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const parts = path.split("/").slice(3).map((part) => {
      try { return decodeURIComponent(part); }
      catch { throw new service.GuestPlayerError("Invalid URL encoding", 400); }
    });
    if (parts.length === 0) {
      if (request.method === "GET") return successResponse((await service.listGuests(env)).map((row) => mapGuestPlayerRow(row)));
      if (request.method === "POST") return successResponse(mapGuestPlayerRow(await service.createGuest(env, await body(request))), 201);
    } else if (parts.length === 2 && parts[0] === "code" && parts[1]) {
      if (request.method === "GET") return successResponse(mapGuestPlayerRow(await service.getGuestByCode(env, parts[1])));
    } else if (parts.length === 1 && parts[0]) {
      const id = parts[0];
      if (request.method === "GET") return successResponse(mapGuestPlayerRow(await service.getGuest(env, id)));
      if (request.method === "PUT") return successResponse(mapGuestPlayerRow(await service.updateGuest(env, id, await body(request))));
      // Guest history is permanent; DELETE is intentionally unsupported.
    } else {
      return errorResponse("API endpoint not found", 404);
    }
    return errorResponse("Method not allowed", 405);
  } catch (error) {
    if (error instanceof service.GuestPlayerError) return errorResponse(error.message, error.status);
    if (error.code === "23503") return errorResponse("Guest player is referenced by other records", 409);
    if (error.code === "23505") return errorResponse("Guest player conflicts with an existing record", 409);
    if (["22001", "22007", "22008", "22P02", "23514", "23502"].includes(error.code)) {
      return errorResponse("Guest player data does not satisfy database constraints", 400);
    }
    // Avoid returning database details or credentials to clients or logs.
    console.error("Guest Player API request failed", { code: error.code ?? "UNKNOWN" });
    return errorResponse("Unable to complete guest player request", 500);
  }
}
