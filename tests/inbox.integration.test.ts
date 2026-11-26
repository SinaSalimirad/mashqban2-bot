import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { BaleClient } from "../src/bot/bale/client.ts";
import { processedUpdates } from "../src/database/schema.ts";
import { pollIntoInbox } from "../src/workers/inbox.ts";
import { openTestDatabase, resetTestDatabase, seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
let database: TestDatabase;

integration("durable inbox", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => { await resetTestDatabase(database.db); });
  afterAll(async () => { await database?.close(); });

  test("persists updates before processing while keeping invitation plaintext out of PostgreSQL", async () => {
    const teacher = await seedTeacher(database.db, "7000000001");
    const invitationCode = "A".repeat(40);
    const bale = new BaleClient("token", async () => Response.json({ ok: true, result: [
      { update_id: 1, message: { message_id: 1, from: { id: 7999999999 },
        chat: { id: 7999999999, type: "private" }, text: invitationCode } },
      { update_id: 2, message: { message_id: 2, from: { id: Number(teacher.baleUserId) },
        chat: { id: Number(teacher.chatId), type: "private" }, text: "نام کلاس جدید" } },
    ] }));
    expect(await pollIntoInbox(database.db, bale, "integration", "secret")).toBe(2);
    const rows = await database.db.select().from(processedUpdates).orderBy(asc(processedUpdates.updateId));
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0]?.payload)).not.toContain(invitationCode);
    expect(JSON.stringify(rows[0]?.payload)).toContain("invitationDigest");
    expect(JSON.stringify(rows[1]?.payload)).toContain("نام کلاس جدید");
    expect(rows.every((row) => row.status === "pending")).toBe(true);
  });
});
