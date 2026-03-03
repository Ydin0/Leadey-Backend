import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function runMigrations() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  console.log("Running database migrations...");

  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);

  await migrate(db, { migrationsFolder: "./drizzle" });

  console.log("Migrations complete.");
  await client.end();
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
