import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import {
  auditEvents, classMemberships, classes, dailyReports, fileAssets, homeworks,
  homeworkVersionFiles, homeworkVersions, students, teachers,
} from "../../database/schema.ts";
import { getTehranTime, isHomeworkWindowOpen } from "../../shared/calendar.ts";
import type { Actor } from "../auth/service.ts";

type SaveInput = {
  operationId: string;
  classId: string;
  title: string;
  assetIds: string[];
  homeworkId?: string;
  baseVersionId?: string;
};

export async function authoritativeTime(tx: Parameters<Parameters<Database["transaction"]>[0]>[0]): Promise<Date> {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS current_time`);
  const value = result[0]?.current_time;
  const instant = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(instant.getTime())) throw new Error("Database clock unavailable");
  return instant;
}

export async function saveHomework(db: Database, actor: Actor, input: SaveInput): Promise<string> {
  if (actor.role !== "student") throw new Error("Forbidden");
  const title = input.title.trim();
  if (!title || title.length > 120) throw new Error("Invalid homework title");
  if (!input.assetIds.length || input.assetIds.length > 20
    || new Set(input.assetIds).size !== input.assetIds.length) {
    throw new Error("Homework requires 1 to 20 distinct files");
  }
  if (Boolean(input.homeworkId) !== Boolean(input.baseVersionId)) throw new Error("Invalid edit base");

  return db.transaction(async (tx) => {
    const ownerLock = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND disabled_at IS NULL FOR UPDATE`);
    if (ownerLock.length !== 1) throw new Error("Forbidden");
    const [student] = await tx.select().from(students).where(and(
      eq(students.id, actor.studentId), eq(students.teacherId, actor.teacherId),
      eq(students.userId, actor.userId), isNull(students.disabledAt),
    )).limit(1);
    if (!student) throw new Error("Forbidden");

    const [previous] = await tx.select({ homeworkId: homeworkVersions.homeworkId })
      .from(homeworkVersions).innerJoin(homeworks, eq(homeworkVersions.homeworkId, homeworks.id))
      .where(and(eq(homeworkVersions.operationId, input.operationId),
        eq(homeworks.teacherId, actor.teacherId), eq(homeworks.studentId, actor.studentId))).limit(1);
    if (previous) return previous.homeworkId;

    const [schoolClass] = await tx.select().from(classes).where(and(
      eq(classes.id, input.classId), eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt),
    )).limit(1);
    if (!schoolClass) throw new Error("Class unavailable");
    const [membership] = await tx.select().from(classMemberships).where(and(
      eq(classMemberships.classId, input.classId), eq(classMemberships.studentId, actor.studentId),
      isNull(classMemberships.leftAt),
    )).limit(1);
    if (!membership) throw new Error("Class membership unavailable");

    const [existing] = input.homeworkId
      ? await tx.select().from(homeworks).where(and(eq(homeworks.id, input.homeworkId),
        eq(homeworks.teacherId, actor.teacherId), eq(homeworks.studentId, actor.studentId),
        eq(homeworks.classId, input.classId), isNull(homeworks.deletedAt))).limit(1)
      : [];
    if (input.homeworkId && (!existing || existing.currentVersionId !== input.baseVersionId)) {
      throw new Error("Homework version conflict");
    }

    const assets = await tx.select({ id: fileAssets.id, createdByUserId: fileAssets.createdByUserId }).from(fileAssets).where(and(
      eq(fileAssets.teacherId, actor.teacherId), eq(fileAssets.status, "ready"),
      inArray(fileAssets.id, input.assetIds),
    ));
    if (assets.length !== input.assetIds.length) throw new Error("File unavailable");
    const inheritedFiles = existing ? await tx.select({ assetId: homeworkVersionFiles.assetId })
      .from(homeworkVersionFiles).where(eq(homeworkVersionFiles.versionId, existing.currentVersionId)) : [];
    const inheritedIds = new Set(inheritedFiles.map((file) => file.assetId));
    if (assets.some((asset) => asset.createdByUserId !== actor.userId && !inheritedIds.has(asset.id))) {
      throw new Error("File unavailable");
    }

    const instant = await authoritativeTime(tx);
    const schoolDate = getTehranTime(instant).schoolDate;
    if (!isHomeworkWindowOpen(instant) || membership.joinedAt > instant) throw new Error("Homework window closed");
    if (existing && existing.schoolDate !== schoolDate) throw new Error("Cannot edit an earlier day");
    const [closedReport] = await tx.select({ id: dailyReports.id }).from(dailyReports)
      .where(and(eq(dailyReports.teacherId, actor.teacherId), eq(dailyReports.schoolDate, schoolDate))).limit(1);
    if (closedReport) throw new Error("School day already closed");

    const homeworkId = existing?.id ?? crypto.randomUUID();
    const versionId = crypto.randomUUID();
    if (!existing) {
      await tx.insert(homeworks).values({ id: homeworkId, teacherId: actor.teacherId,
        classId: input.classId, studentId: actor.studentId, schoolDate,
        createdAt: instant, currentVersionId: versionId });
    }
    const [lastVersion] = existing ? await tx.select({ versionNo: homeworkVersions.versionNo })
      .from(homeworkVersions).where(eq(homeworkVersions.id, existing.currentVersionId)).limit(1) : [];
    await tx.insert(homeworkVersions).values({ id: versionId, homeworkId,
      versionNo: lastVersion ? lastVersion.versionNo + 1 : 1,
      kind: existing ? "edited" : "submitted", title, createdAt: instant,
      createdByUserId: actor.userId, operationId: input.operationId });
    await tx.insert(homeworkVersionFiles).values(input.assetIds.map((assetId, index) => ({
      teacherId: actor.teacherId, homeworkId, versionId, assetId, position: index + 1,
    })));
    if (existing) await tx.update(homeworks).set({ currentVersionId: versionId }).where(eq(homeworks.id, homeworkId));
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: existing ? "homework_edited" : "homework_submitted", entityType: "homework", entityId: homeworkId,
      occurredAt: instant, metadata: { versionId },
    });
    return homeworkId;
  });
}

export async function deleteHomework(
  db: Database, actor: Actor, homeworkId: string, expectedVersionId: string, operationId: string,
): Promise<void> {
  if (actor.role === "assistant") throw new Error("Forbidden");
  await db.transaction(async (tx) => {
    const ownerLock = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND disabled_at IS NULL FOR UPDATE`);
    if (ownerLock.length !== 1) throw new Error("Forbidden");
    const [homework] = await tx.select().from(homeworks).where(and(
      eq(homeworks.id, homeworkId), eq(homeworks.teacherId, actor.teacherId),
    )).limit(1);
    if (!homework) throw new Error("Homework unavailable");
    if (actor.role === "student") {
      const [student] = await tx.select().from(students).where(and(
        eq(students.id, actor.studentId), eq(students.userId, actor.userId),
        eq(students.teacherId, actor.teacherId), isNull(students.disabledAt),
      )).limit(1);
      const [membership] = await tx.select().from(classMemberships).where(and(
        eq(classMemberships.classId, homework.classId), eq(classMemberships.studentId, actor.studentId),
        isNull(classMemberships.leftAt),
      )).limit(1);
      if (!student || !membership || homework.studentId !== actor.studentId) throw new Error("Forbidden");
    } else {
      const [owner] = await tx.select().from(teachers).where(and(
        eq(teachers.id, actor.teacherId), eq(teachers.userId, actor.userId), isNull(teachers.disabledAt),
      )).limit(1);
      if (!owner) throw new Error("Forbidden");
    }
    const [previous] = await tx.select({ id: homeworkVersions.id }).from(homeworkVersions)
      .where(and(eq(homeworkVersions.operationId, operationId), eq(homeworkVersions.homeworkId, homework.id))).limit(1);
    if (previous) return;
    if (homework.deletedAt || homework.currentVersionId !== expectedVersionId) throw new Error("Homework version conflict");
    const [current] = await tx.select().from(homeworkVersions)
      .where(eq(homeworkVersions.id, homework.currentVersionId)).limit(1);
    if (!current) throw new Error("Homework version missing");
    const instant = await authoritativeTime(tx);
    if (actor.role === "student") {
      if (!isHomeworkWindowOpen(instant) || getTehranTime(instant).schoolDate !== homework.schoolDate) {
        throw new Error("Homework window closed");
      }
      const [closedReport] = await tx.select({ id: dailyReports.id }).from(dailyReports)
        .where(and(eq(dailyReports.teacherId, actor.teacherId), eq(dailyReports.schoolDate, homework.schoolDate))).limit(1);
      if (closedReport) throw new Error("School day already closed");
    }
    const versionId = crypto.randomUUID();
    await tx.insert(homeworkVersions).values({ id: versionId, homeworkId: homework.id,
      versionNo: current.versionNo + 1, kind: "deleted", title: current.title,
      createdAt: instant, createdByUserId: actor.userId, operationId });
    await tx.update(homeworks).set({ currentVersionId: versionId, deletedAt: instant, deletedByUserId: actor.userId })
      .where(eq(homeworks.id, homework.id));
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "homework_deleted", entityType: "homework", entityId: homework.id,
      occurredAt: instant, metadata: { versionId },
    });
  });
}
