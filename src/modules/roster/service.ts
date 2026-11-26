import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { assistants, auditEvents, classes, classMemberships, invitations, students } from "../../database/schema.ts";
import type { Actor } from "../auth/service.ts";
import { authoritativeTime } from "../homeworks/service.ts";

function requireTeacher(actor: Actor): asserts actor is Extract<Actor, { role: "teacher" }> {
  if (actor.role !== "teacher") throw new Error("Forbidden");
}

function cleanName(value: string, maxLength: number): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > maxLength) throw new Error("Invalid name");
  return name;
}

export async function createClass(db: Database, actor: Actor, value: string, operationId?: string): Promise<string> {
  requireTeacher(actor);
  const name = cleanName(value, 80);
  return db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    if (operationId) {
      const [previous] = await tx.select({ id: classes.id }).from(classes)
        .where(and(eq(classes.id, operationId), eq(classes.teacherId, actor.teacherId))).limit(1);
      if (previous) return previous.id;
    }
    const [row] = await tx.insert(classes).values({
      ...(operationId ? { id: operationId } : {}),
      teacherId: actor.teacherId, name, normalizedName: name.toLocaleLowerCase("fa-IR"),
    }).returning({ id: classes.id });
    if (!row) throw new Error("Class creation failed");
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "class_created", entityType: "class", entityId: row.id });
    return row.id;
  });
}

export async function createStudent(
  db: Database, actor: Actor, first: string, last: string, classIds: string[], operationId?: string,
): Promise<string> {
  requireTeacher(actor);
  const firstName = cleanName(first, 80);
  const lastName = cleanName(last, 80);
  const uniqueClassIds = [...new Set(classIds)];
  return db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    if (operationId) {
      const [previous] = await tx.select({ id: students.id }).from(students)
        .where(and(eq(students.id, operationId), eq(students.teacherId, actor.teacherId))).limit(1);
      if (previous) return previous.id;
    }
    if (uniqueClassIds.length) {
      const ownedClasses = await tx.select({ id: classes.id }).from(classes).where(and(
        eq(classes.teacherId, actor.teacherId), inArray(classes.id, uniqueClassIds), isNull(classes.disabledAt),
      ));
      if (ownedClasses.length !== uniqueClassIds.length) throw new Error("Class unavailable");
    }
    const [student] = await tx.insert(students).values({
      ...(operationId ? { id: operationId } : {}), teacherId: actor.teacherId, firstName, lastName,
    }).returning({ id: students.id });
    if (!student) throw new Error("Student creation failed");
    if (uniqueClassIds.length) {
      await tx.insert(classMemberships).values(uniqueClassIds.map((classId) => ({
        teacherId: actor.teacherId, classId, studentId: student.id, createdByUserId: actor.userId,
      })));
    }
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "student_created", entityType: "student", entityId: student.id,
      metadata: { classIds: uniqueClassIds },
    });
    return student.id;
  });
}

export async function createAssistant(db: Database, actor: Actor, value: string, operationId?: string): Promise<string> {
  requireTeacher(actor);
  const displayName = cleanName(value, 120);
  return db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    if (operationId) {
      const [previous] = await tx.select({ id: assistants.id }).from(assistants)
        .where(and(eq(assistants.id, operationId), eq(assistants.teacherId, actor.teacherId))).limit(1);
      if (previous) return previous.id;
    }
    const [assistant] = await tx.insert(assistants).values({
      ...(operationId ? { id: operationId } : {}), teacherId: actor.teacherId, displayName,
    }).returning({ id: assistants.id });
    if (!assistant) throw new Error("Assistant creation failed");
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "assistant_created", entityType: "assistant", entityId: assistant.id });
    return assistant.id;
  });
}

export async function deactivateAssistant(db: Database, actor: Actor, assistantId: string): Promise<void> {
  requireTeacher(actor);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    const [assistant] = await tx.select().from(assistants).where(and(
      eq(assistants.id, assistantId), eq(assistants.teacherId, actor.teacherId), isNull(assistants.disabledAt),
    )).limit(1);
    if (!assistant) throw new Error("Assistant unavailable");
    const now = new Date();
    await tx.update(assistants).set({ disabledAt: now, bindingRevision: assistant.bindingRevision + 1, updatedAt: now })
      .where(eq(assistants.id, assistant.id));
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "assistant_deactivated", entityType: "assistant", entityId: assistant.id });
  });
}

export async function changeMembership(
  db: Database, actor: Actor, studentId: string, classId: string, active: boolean,
): Promise<void> {
  requireTeacher(actor);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    const [student] = await tx.select({ id: students.id }).from(students).where(and(
      eq(students.id, studentId), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt),
    )).limit(1);
    const [schoolClass] = await tx.select({ id: classes.id }).from(classes).where(and(
      eq(classes.id, classId), eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt),
    )).limit(1);
    if (!student || !schoolClass) throw new Error("Student or class unavailable");
    const [open] = await tx.select().from(classMemberships).where(and(
      eq(classMemberships.studentId, studentId), eq(classMemberships.classId, classId),
      isNull(classMemberships.leftAt),
    )).limit(1);
    if (Boolean(open) === active) return;
    const instant = await authoritativeTime(tx);
    if (active) {
      await tx.insert(classMemberships).values({ teacherId: actor.teacherId,
        studentId, classId, joinedAt: instant, createdByUserId: actor.userId });
    } else if (open) {
      await tx.update(classMemberships).set({ leftAt: sql`GREATEST(${instant}, ${classMemberships.joinedAt} + interval '1 millisecond')` })
        .where(eq(classMemberships.id, open.id));
    }
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: active ? "membership_started" : "membership_ended",
      entityType: "student", entityId: studentId, occurredAt: instant, metadata: { classId },
    });
  });
}

export async function disconnectStudent(db: Database, actor: Actor, studentId: string): Promise<void> {
  requireTeacher(actor);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    const [student] = await tx.select().from(students).where(and(
      eq(students.id, studentId), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt),
    )).limit(1);
    if (!student) throw new Error("Student unavailable");
    const instant = await authoritativeTime(tx);
    await tx.update(students).set({ userId: null, bindingRevision: student.bindingRevision + 1,
      updatedAt: instant }).where(eq(students.id, studentId));
    await tx.update(invitations).set({ revokedAt: instant }).where(and(
      eq(invitations.teacherId, actor.teacherId), eq(invitations.studentId, studentId),
      isNull(invitations.consumedAt), isNull(invitations.revokedAt),
    ));
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "student_disconnected", entityType: "student", entityId: studentId,
      occurredAt: instant });
  });
}

export async function deactivateStudent(db: Database, actor: Actor, studentId: string): Promise<void> {
  requireTeacher(actor);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    const [student] = await tx.select().from(students).where(and(
      eq(students.id, studentId), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt),
    )).limit(1);
    if (!student) throw new Error("Student unavailable");
    const instant = await authoritativeTime(tx);
    await tx.update(classMemberships).set({ leftAt: sql`GREATEST(${instant}, ${classMemberships.joinedAt} + interval '1 millisecond')` }).where(and(
      eq(classMemberships.studentId, studentId), isNull(classMemberships.leftAt),
    ));
    await tx.update(students).set({ disabledAt: instant, userId: null,
      bindingRevision: student.bindingRevision + 1, updatedAt: instant }).where(eq(students.id, studentId));
    await tx.update(invitations).set({ revokedAt: instant }).where(and(
      eq(invitations.teacherId, actor.teacherId), eq(invitations.studentId, studentId),
      isNull(invitations.consumedAt), isNull(invitations.revokedAt),
    ));
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "student_deactivated", entityType: "student", entityId: studentId,
      occurredAt: instant });
  });
}

export async function deactivateClass(db: Database, actor: Actor, classId: string): Promise<void> {
  requireTeacher(actor);
  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${actor.teacherId} AND user_id = ${actor.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    const [schoolClass] = await tx.select().from(classes).where(and(
      eq(classes.id, classId), eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt),
    )).limit(1);
    if (!schoolClass) throw new Error("Class unavailable");
    const instant = await authoritativeTime(tx);
    await tx.update(classMemberships).set({ leftAt: sql`GREATEST(${instant}, ${classMemberships.joinedAt} + interval '1 millisecond')` }).where(and(
      eq(classMemberships.classId, classId), isNull(classMemberships.leftAt),
    ));
    await tx.update(classes).set({ disabledAt: instant, updatedAt: instant }).where(eq(classes.id, classId));
    await tx.insert(auditEvents).values({ teacherId: actor.teacherId, actorUserId: actor.userId,
      eventType: "class_deactivated", entityType: "class", entityId: classId,
      occurredAt: instant });
  });
}
