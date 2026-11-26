import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { consumeMenuButton, createMenuButtons } from "../src/bot/callbacks.ts";
import { assistants, botSessions, students } from "../src/database/schema.ts";
import { findActor, touchPrivateUser } from "../src/modules/auth/service.ts";
import { hashInvitationCode, issueInvitation, redeemInvitationDigest } from "../src/modules/invitations/service.ts";
import { createAssistant, createClass, createStudent } from "../src/modules/roster/service.ts";
import { openTestDatabase, resetTestDatabase, seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
const secret = "integration-test-invitation-secret";
let database: TestDatabase;

integration("identity, invitations and scoped callbacks", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => { await resetTestDatabase(database.db); });
  afterAll(async () => { await database?.close(); });

  test("AC-01/02: invalid and consumed invitations disclose nothing and only one concurrent consumer wins", async () => {
    const teacher = await seedTeacher(database.db);
    const studentId = await createStudent(database.db, teacher, "علی", "احمدی", [], crypto.randomUUID());
    const code = await issueInvitation(database.db, teacher, { kind: "student", id: studentId }, secret);
    await expect(redeemInvitationDigest(database.db, hashInvitationCode("wrong", secret), "8001", "8001"))
      .resolves.toBe(false);

    const digest = hashInvitationCode(code, secret);
    const results = await Promise.all([
      redeemInvitationDigest(database.db, digest, "8002", "8002"),
      redeemInvitationDigest(database.db, digest, "8003", "8003"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(redeemInvitationDigest(database.db, digest, "8004", "8004")).resolves.toBe(false);
  });

  test("AC-03: rebinding blocks the old account while retaining the student record", async () => {
    const teacher = await seedTeacher(database.db);
    const studentId = await createStudent(database.db, teacher, "زهرا", "رضایی", [], crypto.randomUUID());
    const firstCode = await issueInvitation(database.db, teacher, { kind: "student", id: studentId }, secret);
    expect(await redeemInvitationDigest(database.db, hashInvitationCode(firstCode, secret), "8101", "8101")).toBe(true);
    expect((await findActor(database.db, "8101", "8101"))?.role).toBe("student");

    const secondCode = await issueInvitation(database.db, teacher, { kind: "student", id: studentId }, secret, true);
    expect(await findActor(database.db, "8101", "8101")).toBeNull();
    expect(await redeemInvitationDigest(database.db, hashInvitationCode(secondCode, secret), "8102", "8102")).toBe(true);
    const replacement = await findActor(database.db, "8102", "8102");
    expect(replacement).toMatchObject({ role: "student", studentId });
    expect((await database.db.select().from(students).where(eq(students.id, studentId))).length).toBe(1);
  });

  test("AC-04/14: callbacks are one-use, revision scoped, and unavailable to another actor", async () => {
    const teacher = await seedTeacher(database.db);
    const rows = await createMenuButtons(database.db, teacher, [
      { label: "کلاس‌ها", command: "/classes" },
    ]);
    const button = rows[0]?.[0];
    if (!button) throw new Error("Button missing");
    const studentId = await createStudent(database.db, teacher, "مریم", "کاظمی", [], crypto.randomUUID());
    const studentUserId = await touchPrivateUser(database.db, "8201", "8201");
    await database.db.update(students).set({ userId: studentUserId }).where(eq(students.id, studentId));
    const student = await findActor(database.db, "8201", "8201");
    if (student?.role !== "student") throw new Error("Student missing");

    await expect(consumeMenuButton(database.db, student, button.callback_data)).resolves.toBeNull();
    await expect(consumeMenuButton(database.db, teacher, button.callback_data)).resolves.toBe("/classes");
    await expect(consumeMenuButton(database.db, teacher, button.callback_data)).resolves.toBeNull();

    const staleRows = await createMenuButtons(database.db, teacher, [
      { label: "دانش‌آموزان", command: "/students" },
    ]);
    const stale = staleRows[0]?.[0];
    if (!stale) throw new Error("Button missing");
    await database.db.update(botSessions).set({ revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.userId, teacher.userId));
    await expect(consumeMenuButton(database.db, teacher, stale.callback_data)).resolves.toBeNull();
  });

  test("assistant cannot use teacher-only roster operations", async () => {
    const teacher = await seedTeacher(database.db);
    const assistantId = await createAssistant(database.db, teacher, "همکار", crypto.randomUUID());
    const userId = await touchPrivateUser(database.db, "8301", "8301");
    await database.db.update(assistants).set({ userId }).where(eq(assistants.id, assistantId));
    const assistant = await findActor(database.db, "8301", "8301");
    if (assistant?.role !== "assistant") throw new Error("Assistant missing");
    await expect(createClass(database.db, assistant, "غیرمجاز")).rejects.toThrow("Forbidden");
  });
});
