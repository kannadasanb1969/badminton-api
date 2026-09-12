import { handleRegistrationRoutes } from "./routes/registration.routes.js";
import { handleFixtureRoutes } from "./routes/fixture.routes.js";
import { handleTournamentRoutes } from "./routes/tournament.routes.js";
import { handleAuthRoutes } from "./routes/auth.routes.js";
import { handleGuestPlayerRoutes } from "./routes/guestPlayer.routes.js";
import { Client } from "pg";
import { handlePlayerRoutes } from "./routes/player.routes.js";
import { handleMatchRoutes } from "./routes/match.routes.js";
import { handleResultRoutes } from "./routes/result.routes.js";
import { handleNotificationRoutes } from "./routes/notification.routes.js";
import { corsResponse, preflight } from "./utils/cors.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight(request);
    const respond = (response) => corsResponse(response, request);

    if (url.pathname === "/api/players" || url.pathname.startsWith("/api/players/")) {
      return respond(await handlePlayerRoutes(request, env));
    }

    if (url.pathname === "/api/guest-players" || url.pathname.startsWith("/api/guest-players/")) {
      return respond(await handleGuestPlayerRoutes(request, env));
    }

    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/users/")) {
      return respond(await handleAuthRoutes(request, env));
    }

    if (url.pathname === "/api/tournaments" || url.pathname.startsWith("/api/tournaments/")) {
      return respond(await handleTournamentRoutes(request, env));
    }

    if (url.pathname === "/api/registrations" || url.pathname.startsWith("/api/registrations/") || url.pathname === "/api/eligibility/check") {
      return respond(await handleRegistrationRoutes(request, env));
    }

    if (url.pathname === "/api/fixtures" || url.pathname.startsWith("/api/fixtures/") || url.pathname === "/api/fixtures/generate" || url.pathname === "/api/teams" || url.pathname.startsWith("/api/teams/")) {
      return respond(await handleFixtureRoutes(request, env));
    }
    if (url.pathname === "/api/matches" || url.pathname.startsWith("/api/matches/")) return respond(await handleMatchRoutes(request, env));
    if (url.pathname === "/api/results" || url.pathname.startsWith("/api/results/") || url.pathname === "/api/medals" || url.pathname.startsWith("/api/medals/")) return respond(await handleResultRoutes(request, env));
    if (url.pathname === "/api/notifications" || url.pathname.startsWith("/api/notifications/")) return respond(await handleNotificationRoutes(request, env));

    // API health check
    if ((url.pathname === "/api/health" || url.pathname === "/health")) {
      return respond(Response.json({
        success: true,
        message: "Badminton API is running",
      }));
    }

    // Database health check
    if (url.pathname === "/api/db-health") {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
      });

      try {
        await client.connect();

        const result = await client.query(`
          SELECT
            NOW() AS database_time,
            current_database() AS database_name
        `);

        return respond(Response.json({
          success: true,
          database: "connected",
          databaseName: result.rows[0].database_name,
          databaseTime: result.rows[0].database_time,
        }));
      } catch (error) {
        console.error("Database error:", error);

        return respond(Response.json(
          {
            success: false,
            database: "connection failed",
            message: error.message,
          },
          { status: 500 }
        ));
      } finally {
        await client.end();
      }
    }

    return respond(Response.json(
      {
        success: false,
        message: "API endpoint not found",
      },
      { status: 404 }
    ));
  },
};
