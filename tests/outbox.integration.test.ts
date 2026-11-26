import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { BaleClient } from "../src/bot/bale/client.ts";
import { callbackActions, outboxMessages } from "../src/database/schema.ts";
import { PrivateFileStorage } from "../src/storage/private.ts";
import { dispatchOneOutbox } from "../src/workers/outbox.ts";
import { openTestDatabase, resetTestDatabase, seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
let database: TestDatabase;
const storage = new PrivateFileStorage("/tmp/mashqban-outbox-tests");

integration("durable outbox", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => { await resetTestDatabase(database.db); });
  afterAll(async () => { await database?.close(); });

  test("marks accepted messages sent and includes scoped daily-report button", async () => {
    const teacher = await seedTeacher(database.db);
    const [item] = await database.db.insert(outboxMessages).values({
      teacherId: teacher.teacherId, recipientUserId: teacher.userId, kind: "daily_report",
      idempotencyKey: crypto.randomUUID(), payload: { schoolDate: "2026-11-25", summaries: [] },
    }).returning({ id: outboxMessages.id });
    if (!item) throw new Error("Outbox item missing");
    let body: Record<string, unknown> | undefined;
    const bale = new BaleClient("token", async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, result: { message_id: 101 } });
    });
    expect(await dispatchOneOutbox(database.db, bale, storage)).toBe(true);
    const [sent] = await database.db.select().from(outboxMessages).where(eq(outboxMessages.id, item.id));
    expect(sent).toMatchObject({ status: "sent", providerMessageId: "101" });
    expect(body?.reply_markup).toEqual({ inline_keyboard: [[expect.objectContaining({
      text: "📊 مشاهدهٔ گزارش کامل", callback_data: expect.any(String),
    })]] });
    expect(await database.db.select().from(callbackActions)).toHaveLength(1);
  });

  test("429 is retried while an unknown network outcome is held for review", async () => {
    const teacher = await seedTeacher(database.db);
    const [rateLimited] = await database.db.insert(outboxMessages).values({
      teacherId: teacher.teacherId, recipientUserId: teacher.userId, kind: "bot_reply",
      idempotencyKey: crypto.randomUUID(), payload: { text: "پیام" },
    }).returning({ id: outboxMessages.id });
    if (!rateLimited) throw new Error("Outbox item missing");
    const throttled = new BaleClient("token", async () => Response.json({ ok: false,
      error_code: 429, parameters: { retry_after: 3 } }, { status: 429 }));
    await dispatchOneOutbox(database.db, throttled, storage);
    const [retry] = await database.db.select().from(outboxMessages).where(eq(outboxMessages.id, rateLimited.id));
    expect(retry?.status).toBe("retry");
    expect(retry?.lastErrorCode).toBe("bale_429");

    await database.db.update(outboxMessages).set({ nextAttemptAt: new Date(0) }).where(eq(outboxMessages.id, rateLimited.id));
    const unknown = new BaleClient("token", async () => { throw new Error("connection reset"); });
    await dispatchOneOutbox(database.db, unknown, storage);
    const [held] = await database.db.select().from(outboxMessages).where(eq(outboxMessages.id, rateLimited.id));
    expect(held?.status).toBe("unknown");
    expect(held?.lastErrorCode).toBe("unknown_outcome");
  });
});
