import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = Bun.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = postgres(databaseUrl, { max: 1, prepare: false });
try {
  await migrate(drizzle({ client }), { migrationsFolder: "/app/drizzle" });
  console.info("Database migrations completed.");
} finally {
  await client.end();
}
