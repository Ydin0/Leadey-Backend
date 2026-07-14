import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

// Pool tuning: hot endpoints fan queries out with Promise.all, so the default
// max=10 would queue under load. idle_timeout recycles unused connections;
// keep_alive stops Railway's proxy from silently killing idle sockets.
//
// Connection pooler: when the app talks to PgBouncer in TRANSACTION pooling mode
// (set PG_TRANSACTION_POOLER=1 and point DATABASE_URL at the pooler), prepared
// statements must be disabled — a pooled connection isn't pinned to a session,
// so a prepared statement created on one backend connection won't exist on the
// next. This flag is a no-op against a direct Postgres connection, so it's safe
// to ship ahead of the cutover.
const usingTransactionPooler = process.env.PG_TRANSACTION_POOLER === "1";
const client = postgres(connectionString, {
  max: Number(process.env.PG_POOL_MAX ?? 20),
  idle_timeout: 30,
  connect_timeout: 10,
  keep_alive: 30,
  ...(usingTransactionPooler ? { prepare: false } : {}),
});
export const db = drizzle(client, { schema });

export type Database = typeof db;
