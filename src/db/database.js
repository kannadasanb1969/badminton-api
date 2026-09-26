import { Client } from "pg";
import { DATABASE_MODE } from "../../dbConfig.js";

// DATABASE_MODE is only a selector (see dbConfig.js) — it never overrides
// which Hyperdrive connection is actually used, that's still entirely
// env.HYPERDRIVE.connectionString, resolved exactly as before by Cloudflare
// (local .dev.vars override during `wrangler dev`, real Hyperdrive when
// deployed). This guard only fails fast if DATABASE_MODE disagrees with
// what's actually available, instead of silently connecting to the wrong
// database in either direction.
function assertDatabaseModeMatchesEnvironment(env) {
  const hasLocalOverride = Boolean(env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE);
  if (DATABASE_MODE === "LOCAL" && !hasLocalOverride) {
    throw new Error(
      "DATABASE_MODE is LOCAL (dbConfig.js) but no local database override was found " +
        "(.dev.vars is missing CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE). " +
        "Refusing to connect rather than silently using whatever the HYPERDRIVE binding " +
        "resolves to, which may be production.",
    );
  }
  if (DATABASE_MODE === "PRODUCTION" && hasLocalOverride) {
    throw new Error(
      "DATABASE_MODE is PRODUCTION (dbConfig.js) but a local database override is present " +
        "(.dev.vars). Wrangler would silently use the local database instead of production. " +
        "Refusing to connect — remove .dev.vars or set DATABASE_MODE back to LOCAL.",
    );
  }
}

export async function withDatabase(env, operation) {
  assertDatabaseModeMatchesEnvironment(env);
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end();
  }
}

export async function withTransaction(env, operation) {
  return withDatabase(env, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
