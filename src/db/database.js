import { Client } from "pg";

export async function withDatabase(env, operation) {
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
