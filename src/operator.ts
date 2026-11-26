import { and, asc, eq, inArray } from "drizzle-orm";
import { createDatabase } from "./database/client.ts";
import { outboxMessages } from "./database/schema.ts";

const databaseUrl = Bun.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { db, close } = createDatabase(databaseUrl);

try {
  const [action, id] = Bun.argv[2] === "outbox" ? Bun.argv.slice(3) : Bun.argv.slice(2);
  if (action === "list") {
    const rows = await db.select({ id: outboxMessages.id, kind: outboxMessages.kind,
      status: outboxMessages.status, attemptCount: outboxMessages.attemptCount,
      lastErrorCode: outboxMessages.lastErrorCode, createdAt: outboxMessages.createdAt })
      .from(outboxMessages).where(inArray(outboxMessages.status, ["failed", "unknown"]))
      .orderBy(asc(outboxMessages.createdAt), asc(outboxMessages.id)).limit(50);
    for (const row of rows) {
      console.log(`${row.id} ${row.status} ${row.kind} attempts=${row.attemptCount} error=${row.lastErrorCode ?? "none"} ${row.createdAt.toISOString()}`);
    }
    if (!rows.length) console.log("No failed or unknown deliveries.");
  } else if (action === "retry" && id && /^[0-9a-f-]{36}$/i.test(id)) {
    const rows = await db.update(outboxMessages).set({ status: "retry",
      nextAttemptAt: new Date(), leaseUntil: null, lastErrorCode: null })
      .where(and(eq(outboxMessages.id, id), inArray(outboxMessages.status, ["failed", "unknown"])))
      .returning({ id: outboxMessages.id });
    if (!rows.length) throw new Error("Delivery not found or not retryable");
    console.log(`Queued ${id} for retry. An unknown prior send may have reached Bale.`);
  } else {
    throw new Error("Usage: outbox list | outbox retry <message-uuid>");
  }
} finally {
  await close();
}
