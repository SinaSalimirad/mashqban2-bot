import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  classMemberships, classes, dailyReportEntries, fileAssets, homeworks,
  homeworkVersionFiles, homeworkVersions, outboxMessages, students, teachers,
} from "../src/database/schema.ts";
import { deleteHomework, saveHomework, type AuthoritativeClock } from "../src/modules/homeworks/service.ts";
import { closeSchoolDay, readDailyReport } from "../src/modules/reports/service.ts";
import { createClass, createStudent } from "../src/modules/roster/service.ts";
import { runDailyScheduler } from "../src/scheduler/daily.ts";
import { getTehranHourInstant, getTehranTime, shiftSchoolDate } from "../src/shared/calendar.ts";
import { bindStudent, openTestDatabase, readyAsset, resetTestDatabase,
  seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
let database: TestDatabase;

function clock(iso: string): AuthoritativeClock {
  const instant = new Date(iso);
  return async () => new Date(instant);
}

async function fixture() {
  const teacher = await seedTeacher(database.db);
  const classA = await createClass(database.db, teacher, "چهارم الف", crypto.randomUUID());
  const classB = await createClass(database.db, teacher, "چهارم ب", crypto.randomUUID());
  const studentId = await createStudent(database.db, teacher, "علی", "احمدی",
    [classA, classB], crypto.randomUUID());
  const student = await bindStudent(database.db, teacher.teacherId, studentId, "9000000001");
  const historical = new Date("2026-11-24T00:00:00.000Z");
  await database.db.update(teachers).set({ createdAt: historical }).where(eq(teachers.id, teacher.teacherId));
  await database.db.update(classes).set({ createdAt: historical }).where(eq(classes.teacherId, teacher.teacherId));
  await database.db.update(students).set({ createdAt: historical }).where(eq(students.id, studentId));
  await database.db.update(classMemberships).set({ joinedAt: historical })
    .where(eq(classMemberships.studentId, studentId));
  return { teacher, student, studentId, classA, classB };
}

integration("homework, versioning and reports", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => { await resetTestDatabase(database.db); });
  afterAll(async () => { await database?.close(); });

  test("AC-06: final-save boundaries are [14:00, 22:00) Tehran", async () => {
    const data = await fixture();
    const asset = await readyAsset(database.db, data.student, "boundary");
    const input = (operationId: string) => ({ operationId, classId: data.classA,
      title: "تمرین ریاضی", assetIds: [asset] });

    await expect(saveHomework(database.db, data.student, input(crypto.randomUUID()),
      clock("2026-11-25T10:29:59.000Z"))).rejects.toThrow("window closed");
    await expect(saveHomework(database.db, data.student, input(crypto.randomUUID()),
      clock("2026-11-25T10:30:00.000Z"))).resolves.toEqual(expect.any(String));
    await expect(saveHomework(database.db, data.student, input(crypto.randomUUID()),
      clock("2026-11-25T18:29:59.000Z"))).resolves.toEqual(expect.any(String));
    await expect(saveHomework(database.db, data.student, input(crypto.randomUUID()),
      clock("2026-11-25T18:30:00.000Z"))).rejects.toThrow("window closed");
  });

  test("AC-07/08/15: edit snapshots are atomic, stale edits fail, and duplicate finalize is idempotent", async () => {
    const data = await fixture();
    const firstAsset = await readyAsset(database.db, data.student, "first");
    const secondAsset = await readyAsset(database.db, data.student, "second");
    const operationId = crypto.randomUUID();
    const homeworkId = await saveHomework(database.db, data.student, {
      operationId, classId: data.classA, title: "نسخه اول", assetIds: [firstAsset],
    }, clock("2026-11-25T10:30:00.000Z"));
    expect(await saveHomework(database.db, data.student, {
      operationId, classId: data.classA, title: "نسخه اول", assetIds: [firstAsset],
    }, clock("2026-11-25T10:31:00.000Z"))).toBe(homeworkId);

    const [base] = await database.db.select().from(homeworks).where(eq(homeworks.id, homeworkId));
    if (!base) throw new Error("Homework missing");
    await saveHomework(database.db, data.student, {
      operationId: crypto.randomUUID(), classId: data.classA, homeworkId,
      baseVersionId: base.currentVersionId, title: "نسخه دوم", assetIds: [secondAsset],
    }, clock("2026-11-25T12:00:00.000Z"));

    const versions = await database.db.select().from(homeworkVersions)
      .where(eq(homeworkVersions.homeworkId, homeworkId));
    expect(versions).toHaveLength(2);
    const files = await database.db.select().from(homeworkVersionFiles)
      .where(eq(homeworkVersionFiles.homeworkId, homeworkId));
    expect(files.map((row) => row.assetId).sort()).toEqual([firstAsset, secondAsset].sort());

    const [current] = await database.db.select().from(homeworks).where(eq(homeworks.id, homeworkId));
    if (!current) throw new Error("Homework missing");
    await expect(saveHomework(database.db, data.student, {
      operationId: crypto.randomUUID(), classId: data.classA, homeworkId,
      baseVersionId: base.currentVersionId, title: "ویرایش قدیمی", assetIds: [firstAsset],
    }, clock("2026-11-25T13:00:00.000Z"))).rejects.toThrow("version conflict");
    await expect(saveHomework(database.db, data.student, {
      operationId: crypto.randomUUID(), classId: data.classA, homeworkId,
      baseVersionId: current.currentVersionId, title: "بعد از مهلت", assetIds: [secondAsset],
    }, clock("2026-11-25T18:30:00.000Z"))).rejects.toThrow("window closed");
    const [preserved] = await database.db.select().from(homeworks).where(eq(homeworks.id, homeworkId));
    expect(preserved?.currentVersionId).toBe(current.currentVersionId);
  });

  test("AC-05: one student is counted independently in each class", async () => {
    const data = await fixture();
    const asset = await readyAsset(database.db, data.student, "class-report");
    await saveHomework(database.db, data.student, {
      operationId: crypto.randomUUID(), classId: data.classA, title: "علوم", assetIds: [asset],
    }, clock("2026-11-25T11:00:00.000Z"));
    const reportId = await closeSchoolDay(database.db, data.teacher.teacherId, "2026-11-25",
      clock("2026-11-25T18:31:00.000Z"));
    const entries = await database.db.select().from(dailyReportEntries)
      .where(eq(dailyReportEntries.reportId, reportId));
    expect(entries.find((row) => row.classId === data.classA)?.submitted).toBe(true);
    expect(entries.find((row) => row.classId === data.classB)?.submitted).toBe(false);
  });

  test("AC-09/11: deleting the last homework changes the report while membership remains eligible", async () => {
    const data = await fixture();
    const asset = await readyAsset(database.db, data.student, "report");
    const homeworkId = await saveHomework(database.db, data.student, {
      operationId: crypto.randomUUID(), classId: data.classA, title: "علوم", assetIds: [asset],
    }, clock("2026-11-25T11:00:00.000Z"));
    const [homework] = await database.db.select().from(homeworks).where(eq(homeworks.id, homeworkId));
    if (!homework) throw new Error("Homework missing");

    await deleteHomework(database.db, data.student, homeworkId, homework.currentVersionId,
      crypto.randomUUID(), clock("2026-11-25T12:00:00.000Z"));
    const reportId = await closeSchoolDay(database.db, data.teacher.teacherId, "2026-11-25",
      clock("2026-11-25T18:31:00.000Z"));
    const entries = await database.db.select().from(dailyReportEntries)
      .where(eq(dailyReportEntries.reportId, reportId));
    expect(entries).toHaveLength(2);
    expect(entries.find((row) => row.classId === data.classA)).toMatchObject({
      submitted: false, hadDeletedHomework: true,
    });
    expect(entries.find((row) => row.classId === data.classB)).toMatchObject({
      submitted: false, hadDeletedHomework: false,
    });
  });

  test("AC-13: closing a day is idempotent and queues one notification per active staff recipient", async () => {
    const data = await fixture();
    const first = await closeSchoolDay(database.db, data.teacher.teacherId, "2026-11-25",
      clock("2026-11-25T18:31:00.000Z"));
    const second = await closeSchoolDay(database.db, data.teacher.teacherId, "2026-11-25",
      clock("2026-11-26T10:00:00.000Z"));
    expect(second).toBe(first);
    const deliveries = await database.db.select().from(outboxMessages)
      .where(and(eq(outboxMessages.dailyReportId, first), eq(outboxMessages.kind, "daily_report")));
    expect(deliveries).toHaveLength(1);
    const report = await readDailyReport(database.db, data.teacher, "2026-11-25");
    expect(report?.report.id).toBe(first);
  });

  test("AC-13: scheduler catches up a missed closed day after restart", async () => {
    const teacher = await seedTeacher(database.db);
    const yesterday = shiftSchoolDate(getTehranTime(new Date()).schoolDate, -1);
    await database.db.update(teachers).set({
      createdAt: new Date(getTehranHourInstant(yesterday, 14).getTime() - 1_000),
    }).where(eq(teachers.id, teacher.teacherId));
    expect(await runDailyScheduler(database.db)).toBeGreaterThanOrEqual(1);
    const report = await readDailyReport(database.db, teacher, yesterday);
    expect(report?.report.schoolDate).toBe(yesterday);
    expect(await runDailyScheduler(database.db)).toBe(0);
  });

  test("AC-16: invalid or foreign files never create partial homework", async () => {
    const data = await fixture();
    const [foreignUser] = await database.db.insert(fileAssets).values({
      teacherId: data.teacher.teacherId, kind: "document", status: "ready",
      sizeBytes: 1, storageKey: crypto.randomUUID(), createdByUserId: data.teacher.userId,
    }).returning({ id: fileAssets.id });
    if (!foreignUser) throw new Error("Asset missing");
    await expect(saveHomework(database.db, data.student, {
      operationId: crypto.randomUUID(), classId: data.classA,
      title: "نامعتبر", assetIds: [foreignUser.id],
    }, clock("2026-11-25T11:00:00.000Z"))).rejects.toThrow("File unavailable");
    const [count] = await database.db.select({ total: sql<number>`count(*)::integer` }).from(homeworks);
    expect(count?.total).toBe(0);
  });
});
