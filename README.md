# badminton-api

## Local / Production Switching

Configuration file:

```
dbConfig.js
```

This is only a selector — it never contains a database URL, password, or any other credential. Exactly one `DATABASE_MODE` declaration must be uncommented at a time.

### Local

Uncomment:

```js
export const DATABASE_MODE = "LOCAL";
```

Comment out:

```js
// export const DATABASE_MODE = "PRODUCTION";
```

LOCAL uses the existing local Hyperdrive override already configured via `.dev.vars` (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`). The actual database connection string is never documented or printed here — it stays in `.dev.vars`, which is not committed.

### Production

Comment out:

```js
// export const DATABASE_MODE = "LOCAL";
```

Uncomment:

```js
export const DATABASE_MODE = "PRODUCTION";
```

PRODUCTION uses the existing Cloudflare Hyperdrive binding (`HYPERDRIVE`) already configured for the deployed Worker.

> **IMPORTANT:** Only ONE `DATABASE_MODE` declaration must be uncommented at a time. Changing `DATABASE_MODE` does **not** deploy the Worker — production deployment is a separate, explicit action (`npm run deploy` / `wrangler deploy`).

### Quick reference

```
LOCAL:
  Mobile → apiConfig.ts LOCAL → Local API → dbConfig.js LOCAL → Local DB

PRODUCTION:
  Mobile → apiConfig.ts PRODUCTION → Production Cloudflare Worker → dbConfig.js PRODUCTION → Production DB
```

(`apiConfig.ts` lives in the mobile repository — see its README for details.)
