import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { BaleClient, type BaleMessage } from "../src/bot/bale/client.ts";
import { handleAuthorizedMessage } from "../src/bot/router.ts";
import { botSessions, classes } from "../src/database/schema.ts";
import type { Actor } from "../src/modules/auth/service.ts";
import { PrivateFileStorage } from "../src/storage/private.ts";
import { openTestDatabase, resetTestDatabase, seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
let database: TestDatabase;
const bale = new BaleClient("synthetic", async () => { throw new Error("Unexpected network call"); });
const storage = new PrivateFileStorage("/tmp/mashqban-router-tests");

function message(actor: Actor, text: string): BaleMessage {
  return { message_id: 1, from: { id: Number(actor.baleUserId) },
    chat: { id: Number(actor.chatId), type: "private" }, text };
}

async function send(actor: Actor, text: string) {
  return handleAuthorizedMessage({ db: database.db, bale, storage, actor, userId: actor.userId,
    message: message(actor, text), inviteCodeSecret: "router-test-secret",
    operationId: crypto.randomUUID() });
}

integration("guided bot UX", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => { await resetTestDatabase(database.db); });
  afterAll(async () => { await database?.close(); });

  test("teacher menu exposes role-appropriate primary journeys", async () => {
    const teacher = await seedTeacher(database.db);
    const reply = await send(teacher, "/start");
    expect(reply.text).toContain("منوی معلم");
    expect(reply.buttons?.map((button) => button.command)).toEqual([
      "/classes", "/students", "/assistants", "/homeworkmenu", "/reports",
    ]);
  });

  test("class creation and rename require guided confirmation", async () => {
    const teacher = await seedTeacher(database.db);
    expect((await send(teacher, "/newclass")).text).toContain("نام کلاس");
    expect((await send(teacher, "ششم الف")).buttons?.some((button) => button.command === "/confirmclass")).toBe(true);
    const created = await send(teacher, "/confirmclass");
    const [schoolClass] = await database.db.select().from(classes);
    expect(created.text).toContain("کلاس ثبت شد");
    if (!schoolClass) throw new Error("Class missing");

    await send(teacher, `/renamerequest class ${schoolClass.id}`);
    const review = await send(teacher, "ششم ب");
    expect(review.text).toContain("ششم ب");
    expect(review.buttons?.some((button) => button.command === "/confirmrename")).toBe(true);
    await send(teacher, "/confirmrename");
    const [renamed] = await database.db.select().from(classes).where(eq(classes.id, schoolClass.id));
    expect(renamed?.name).toBe("ششم ب");
  });

  test("cancel asks for confirmation and restores the previous workflow", async () => {
    const teacher = await seedTeacher(database.db);
    await send(teacher, "/newclass");
    const confirmation = await send(teacher, "/cancel");
    expect(confirmation.buttons?.map((button) => button.command)).toEqual(["/confirmcancel", "/keepdraft"]);
    await send(teacher, "/keepdraft");
    const [session] = await database.db.select().from(botSessions).where(eq(botSessions.userId, teacher.userId));
    expect(session?.state).toBe("CLASS_CREATE");
    await send(teacher, "/cancel");
    await send(teacher, "/confirmcancel");
    const [cancelled] = await database.db.select().from(botSessions).where(eq(botSessions.userId, teacher.userId));
    expect(cancelled?.state).toBe("IDLE");
  });

  test("Solar Hijri date input returns to idle after validation", async () => {
    const teacher = await seedTeacher(database.db);
    await send(teacher, "/reportdate daily");
    expect((await send(teacher, "تاریخ بد")).text).toContain("معتبر نیست");
    expect((await send(teacher, "۱۴۰۵/۰۹/۰۵")).text).toContain("گزارش موقت");
    const [session] = await database.db.select().from(botSessions).where(eq(botSessions.userId, teacher.userId));
    expect(session?.state).toBe("IDLE");
  });
});
