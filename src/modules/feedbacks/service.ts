import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import {
  assistants, auditEvents, classes, feedbacks, fileAssets, homeworks, homeworkVersions,
  outboxMessages, students, teachers,
} from "../../database/schema.ts";
import type { Actor } from "../auth/service.ts";

export type FeedbackInput = {
  homeworkId: string;
  versionId: string;
  operationId: string;
  content: { kind: "text"; body: string } | { kind: "voice"; assetId: string };
};

export async function recordFeedback(db: Database, actor: Actor, input: FeedbackInput): Promise<string> {
  if (actor.role === "student") throw new Error("Forbidden");
  const body = input.content.kind === "text" ? input.content.body.trim() : null;
  if (body !== null && (!body || body.length > 4096)) throw new Error("Invalid feedback text");

  return db.transaction(async (tx) => {
    const ownerLock = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND disabled_at IS NULL FOR UPDATE`);
    if (ownerLock.length !== 1) throw new Error("Forbidden");
    const [staff] = actor.role === "teacher"
      ? await tx.select({ displayName: teachers.displayName }).from(teachers).where(and(
        eq(teachers.id, actor.teacherId), eq(teachers.userId, actor.userId), isNull(teachers.disabledAt),
      )).limit(1)
      : await tx.select({ displayName: assistants.displayName }).from(assistants).where(and(
        eq(assistants.id, actor.assistantId), eq(assistants.teacherId, actor.teacherId),
        eq(assistants.userId, actor.userId), isNull(assistants.disabledAt),
      )).limit(1);
    if (!staff) throw new Error("Forbidden");

    const [homework] = await tx.select().from(homeworks).where(and(
      eq(homeworks.id, input.homeworkId), eq(homeworks.teacherId, actor.teacherId),
    )).limit(1);
    const [version] = await tx.select().from(homeworkVersions).where(and(
      eq(homeworkVersions.id, input.versionId), eq(homeworkVersions.homeworkId, input.homeworkId),
    )).limit(1);
    if (!homework || !version || version.kind === "deleted") throw new Error("Homework version unavailable");
    const [schoolClass] = await tx.select({ name: classes.name }).from(classes)
      .where(and(eq(classes.id, homework.classId), eq(classes.teacherId, actor.teacherId))).limit(1);
    if (!schoolClass) throw new Error("Class unavailable");
    const [student] = await tx.select().from(students).where(and(
      eq(students.id, homework.studentId), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt),
    )).limit(1);
    if (!student) throw new Error("Student unavailable");

    if (input.content.kind === "voice") {
      const [asset] = await tx.select({ id: fileAssets.id, storageKey: fileAssets.storageKey,
        mimeType: fileAssets.mimeType }).from(fileAssets).where(and(
        eq(fileAssets.id, input.content.assetId), eq(fileAssets.teacherId, actor.teacherId),
        eq(fileAssets.status, "ready"), eq(fileAssets.kind, "voice"),
      )).limit(1);
      if (!asset?.storageKey || asset.mimeType !== "audio/ogg") throw new Error("Voice file unavailable");
    }

    const [existing] = await tx.select({ id: feedbacks.id }).from(feedbacks)
      .where(eq(feedbacks.operationId, input.operationId)).limit(1);
    if (existing) return existing.id;

    const [feedback] = await tx.insert(feedbacks).values({
      teacherId: actor.teacherId, homeworkId: homework.id, versionId: version.id,
      authorUserId: actor.userId, authorRole: actor.role, authorDisplayName: staff.displayName,
      kind: input.content.kind, body,
      voiceAssetId: input.content.kind === "voice" ? input.content.assetId : null,
      operationId: input.operationId,
    }).returning({ id: feedbacks.id });
    if (!feedback) throw new Error("Feedback save failed");

    const roleName = actor.role === "teacher" ? "معلم" : "دستیار";
    const heading = `بازخورد ${roleName} ${staff.displayName} برای تکلیف «${version.title}» در کلاس «${schoolClass.name}»`;
    await tx.insert(outboxMessages).values({
      teacherId: actor.teacherId, feedbackId: feedback.id, targetStudentId: student.id,
      kind: "feedback_text", idempotencyKey: `feedback:${feedback.id}:text`,
      payload: { text: body ? `${heading}\n${body}` : heading },
    });
    if (input.content.kind === "voice") {
      await tx.insert(outboxMessages).values({
        teacherId: actor.teacherId, feedbackId: feedback.id, targetStudentId: student.id,
        kind: "feedback_voice", idempotencyKey: `feedback:${feedback.id}:voice`,
        payload: { assetId: input.content.assetId },
      });
    }
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "feedback_recorded", entityType: "feedback", entityId: feedback.id,
      metadata: { homeworkId: homework.id, versionId: version.id, kind: input.content.kind },
    });
    return feedback.id;
  });
}
