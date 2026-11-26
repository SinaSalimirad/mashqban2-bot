import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { assistants, classMemberships, classes, feedbacks, fileAssets, homeworks,
  homeworkVersions, outboxMessages, students, teachers } from "../src/database/schema.ts";
import { findActor, touchPrivateUser } from "../src/modules/auth/service.ts";
import { recordFeedback } from "../src/modules/feedbacks/service.ts";
import { saveHomework, type AuthoritativeClock } from "../src/modules/homeworks/service.ts";
import { createAssistant, createClass, createStudent } from "../src/modules/roster/service.ts";
import { bindStudent, openTestDatabase, readyAsset, resetTestDatabase,
  seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
let database: TestDatabase;
const fixedClock: AuthoritativeClock = async () => new Date("2026-11-25T11:00:00.000Z");

integration("feedback delivery", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => { await resetTestDatabase(database.db); });
  afterAll(async () => { await database?.close(); });

  test("AC-10: voice feedback keeps its selected version and queues the current student binding", async () => {
    const teacher = await seedTeacher(database.db);
    const classId = await createClass(database.db, teacher, "پنجم", crypto.randomUUID());
    const studentId = await createStudent(database.db, teacher, "سارا", "محمدی", [classId], crypto.randomUUID());
    const student = await bindStudent(database.db, teacher.teacherId, studentId, "9100000001");
    const historical = new Date("2026-11-24T00:00:00Z");
    await database.db.update(teachers).set({ createdAt: historical }).where(eq(teachers.id, teacher.teacherId));
    await database.db.update(classes).set({ createdAt: historical }).where(eq(classes.id, classId));
    await database.db.update(students).set({ createdAt: historical }).where(eq(students.id, studentId));
    await database.db.update(classMemberships).set({ joinedAt: historical })
      .where(eq(classMemberships.studentId, studentId));
    const homeworkAsset = await readyAsset(database.db, student, "homework");
    const homeworkId = await saveHomework(database.db, student, {
      operationId: crypto.randomUUID(), classId, title: "فارسی", assetIds: [homeworkAsset],
    }, fixedClock);
    const [version] = await database.db.select().from(homeworkVersions)
      .where(eq(homeworkVersions.homeworkId, homeworkId));
    if (!version) throw new Error("Version missing");

    const assistantId = await createAssistant(database.db, teacher, "خانم همکار", crypto.randomUUID());
    const assistantUserId = await touchPrivateUser(database.db, "9100000002", "9100000002");
    await database.db.update(assistants).set({ userId: assistantUserId }).where(eq(assistants.id, assistantId));
    const assistant = await findActor(database.db, "9100000002", "9100000002");
    if (assistant?.role !== "assistant") throw new Error("Assistant missing");
    const [voice] = await database.db.insert(fileAssets).values({
      teacherId: teacher.teacherId, kind: "voice", mimeType: "audio/ogg", status: "ready",
      sizeBytes: 8, storageKey: crypto.randomUUID(), createdByUserId: assistant.userId,
    }).returning({ id: fileAssets.id });
    if (!voice) throw new Error("Voice missing");

    const operationId = crypto.randomUUID();
    const feedbackId = await recordFeedback(database.db, assistant, {
      homeworkId, versionId: version.id, operationId,
      content: { kind: "voice", assetId: voice.id },
    });
    expect(await recordFeedback(database.db, assistant, {
      homeworkId, versionId: version.id, operationId,
      content: { kind: "voice", assetId: voice.id },
    })).toBe(feedbackId);
    const [feedback] = await database.db.select().from(feedbacks).where(eq(feedbacks.id, feedbackId));
    expect(feedback).toMatchObject({ homeworkId, versionId: version.id, authorRole: "assistant",
      authorDisplayName: "خانم همکار", kind: "voice" });
    const deliveries = await database.db.select().from(outboxMessages)
      .where(eq(outboxMessages.feedbackId, feedbackId));
    expect(deliveries.map((row) => row.kind).sort()).toEqual(["feedback_text", "feedback_voice"]);
    expect(deliveries.every((row) => row.targetStudentId === studentId)).toBe(true);
    const [homework] = await database.db.select().from(homeworks).where(eq(homeworks.id, homeworkId));
    expect(homework?.studentId).toBe(studentId);
  });
});
