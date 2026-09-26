// ======================================================
// SMASHPOINT BACKEND DATABASE CONFIGURATION
// IMPORTANT: ONLY ONE MODE MUST BE UNCOMMENTED BELOW.
//
// This is ONLY a selector — it never contains a database URL, password,
// Neon/Hyperdrive connection string, Cloudflare token, or any other
// secret. Real credentials continue to come from:
//   LOCAL:      .dev.vars (CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE)
//   PRODUCTION: the deployed Worker's existing Hyperdrive binding ("HYPERDRIVE")
// ======================================================

// ---------------- LOCAL ----------------

export const DATABASE_MODE = "LOCAL";

// ---------------- PRODUCTION ----------------

// export const DATABASE_MODE = "PRODUCTION";
