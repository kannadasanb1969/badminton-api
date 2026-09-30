import * as service from "../services/player-connection.service.js";
import { verifyAccessToken } from "../utils/auth-token.js";
import { errorResponse, successResponse } from "../utils/response.js";

function identity(request, env) {
  const header = request.headers.get("authorization") || "";
  return verifyAccessToken(env, header.startsWith("Bearer ") ? header.slice(7) : null);
}

export async function handlePlayerConnectionRoutes(request, env) {
  try {
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const parts = path.split("/").slice(3).map(decodeURIComponent);
    const auth = await identity(request, env);
    if (!auth) return errorResponse("Authentication required", 401);
    if (request.method === "GET" && parts.length === 1 && parts[0] === "discover") {
      return successResponse(await service.discover(env, auth, new URL(request.url).searchParams.get("search")));
    }
    if (request.method === "GET" && parts.length === 0) return successResponse(await service.accepted(env, auth));
    if (request.method === "GET" && parts.length === 1 && parts[0] === "requests") return successResponse(await service.requests(env, auth));
    if (request.method === "GET" && parts.length === 2 && parts[0] === "profile") return successResponse(await service.profile(env, auth, parts[1]));
    if (request.method === "POST" && parts.length === 1) return successResponse(await service.request(env, auth, parts[0]), 201);
    if (request.method === "POST" && parts.length === 2 && parts[1] === "accept") return successResponse(await service.accept(env, auth, parts[0]));
    if (request.method === "POST" && parts.length === 2 && parts[1] === "decline") return successResponse(await service.decline(env, auth, parts[0]));
    if (request.method === "DELETE" && parts.length === 1) return successResponse(await service.unconnect(env, auth, parts[0]));
    return errorResponse("API endpoint not found", 404);
  } catch (error) {
    if (error instanceof service.PlayerConnectionError) return errorResponse(error.message, error.status);
    if (error.code === "23505") return errorResponse("A connection request already exists for these players", 409);
    if (error.code === "23503" || error.code === "23514") return errorResponse("Connection does not satisfy database constraints", 400);
    console.error("Player connection request failed", { code: error.code ?? "UNKNOWN" });
    return errorResponse("Unable to complete connection request", 500);
  }
}
