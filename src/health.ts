import { sql } from "drizzle-orm";
import type { Database } from "./database/client.ts";

export function startHealthServer(db: Database, port: number, isReady: () => boolean) {
  return Bun.serve({
    hostname: "0.0.0.0",
    port,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") return new Response(null, { status: 405 });
      if (path === "/health") return new Response("ok\n");
      if (path !== "/ready") return new Response(null, { status: 404 });
      if (!isReady()) return new Response("unavailable\n", { status: 503 });
      try {
        await db.execute(sql`SELECT 1 FROM processed_updates LIMIT 1`);
        await db.execute(sql`SELECT 1 FROM outbox_messages LIMIT 1`);
        return new Response("ready\n");
      } catch {
        return new Response("unavailable\n", { status: 503 });
      }
    },
  });
}
