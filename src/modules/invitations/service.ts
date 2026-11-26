import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { assistants, auditEvents, invitations, students, teachers, users } from "../../database/schema.ts";
import type { Actor } from "../auth/service.ts";

type Target = { kind: "student" | "assistant"; id: string };

function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
}

export function hashInvitationCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(normalizeCode(code)).digest("hex");
}

export async function issueInvitation(db: Database, teacher: Actor, target: Target, secret: string): Promise<string> {
  if (teacher.role !== "teacher") throw new Error("Forbidden");
  const code = randomBytes(20).toString("hex").toUpperCase();
  const codeDigest = hashInvitationCode(code, secret);

  await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${teacher.teacherId} AND user_id = ${teacher.userId} AND disabled_at IS NULL FOR UPDATE`);
    if (owner.length !== 1) throw new Error("Forbidden");
    const now = new Date();
    const targetRow = target.kind === "student"
      ? (await tx.select().from(students).where(and(eq(students.id, target.id), eq(students.teacherId, teacher.teacherId), isNull(students.disabledAt))).limit(1))[0]
      : (await tx.select().from(assistants).where(and(eq(assistants.id, target.id), eq(assistants.teacherId, teacher.teacherId), isNull(assistants.disabledAt))).limit(1))[0];
    if (!targetRow || targetRow.userId) throw new Error("Invitation target unavailable");

    await tx.update(invitations).set({ revokedAt: now }).where(and(
      eq(invitations.teacherId, teacher.teacherId),
      target.kind === "student" ? eq(invitations.studentId, target.id) : eq(invitations.assistantId, target.id),
      isNull(invitations.consumedAt), isNull(invitations.revokedAt),
    ));
    await tx.insert(invitations).values({
      teacherId: teacher.teacherId,
      studentId: target.kind === "student" ? target.id : null,
      assistantId: target.kind === "assistant" ? target.id : null,
      codeDigest,
      issuedByUserId: teacher.userId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      targetBindingRevision: targetRow.bindingRevision,
    });
    await tx.insert(auditEvents).values({
      teacherId: teacher.teacherId, actorUserId: teacher.userId,
      eventType: "invitation_issued", entityType: target.kind, entityId: target.id,
    });
  });
  return code;
}

export async function redeemInvitation(
  db: Database,
  code: string,
  secret: string,
  baleUserId: string,
  privateChatId: string,
): Promise<boolean> {
  return redeemInvitationDigest(db, hashInvitationCode(code, secret), baleUserId, privateChatId);
}

export async function redeemInvitationDigest(
  db: Database, codeDigest: string, baleUserId: string, privateChatId: string,
): Promise<boolean> {
  const [candidate] = await db.select({ teacherId: invitations.teacherId }).from(invitations)
    .where(eq(invitations.codeDigest, codeDigest)).limit(1);
  if (!candidate) return false;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM teachers WHERE id = ${candidate.teacherId} FOR UPDATE`);
    const [invitation] = await tx.select().from(invitations)
      .where(eq(invitations.codeDigest, codeDigest)).limit(1);
    const now = new Date();
    if (!invitation || invitation.consumedAt || invitation.revokedAt || invitation.expiresAt <= now) return false;

    const [owner] = await tx.select().from(teachers)
      .where(and(eq(teachers.id, invitation.teacherId), isNull(teachers.disabledAt))).limit(1);
    if (!owner) return false;

    const [user] = await tx.insert(users).values({
      baleUserId: BigInt(baleUserId), privateChatId: BigInt(privateChatId), lastSeenAt: now,
    }).onConflictDoUpdate({
      target: users.baleUserId,
      set: { privateChatId: BigInt(privateChatId), lastSeenAt: now, updatedAt: now },
    }).returning({ id: users.id });
    if (!user || user.id === owner.userId) return false;

    const [existingStudent] = await tx.select({ id: students.id }).from(students)
      .where(and(eq(students.teacherId, owner.id), eq(students.userId, user.id))).limit(1);
    const [existingAssistant] = await tx.select({ id: assistants.id }).from(assistants)
      .where(and(eq(assistants.teacherId, owner.id), eq(assistants.userId, user.id))).limit(1);
    if (existingStudent || existingAssistant) return false;

    if (invitation.studentId) {
      const [target] = await tx.select().from(students)
        .where(and(eq(students.id, invitation.studentId), eq(students.teacherId, owner.id), isNull(students.disabledAt))).limit(1);
      if (!target || target.userId || target.bindingRevision !== invitation.targetBindingRevision) return false;
      await tx.update(students).set({ userId: user.id, bindingRevision: target.bindingRevision + 1, updatedAt: now })
        .where(eq(students.id, target.id));
      await tx.insert(auditEvents).values({ teacherId: owner.id, actorUserId: user.id,
        eventType: "student_bound", entityType: "student", entityId: target.id });
    } else if (invitation.assistantId) {
      const [target] = await tx.select().from(assistants)
        .where(and(eq(assistants.id, invitation.assistantId), eq(assistants.teacherId, owner.id), isNull(assistants.disabledAt))).limit(1);
      if (!target || target.userId || target.bindingRevision !== invitation.targetBindingRevision) return false;
      await tx.update(assistants).set({ userId: user.id, bindingRevision: target.bindingRevision + 1, updatedAt: now })
        .where(eq(assistants.id, target.id));
      await tx.insert(auditEvents).values({ teacherId: owner.id, actorUserId: user.id,
        eventType: "assistant_bound", entityType: "assistant", entityId: target.id });
    } else {
      return false;
    }

    await tx.update(invitations).set({ consumedAt: now, consumedByUserId: user.id })
      .where(eq(invitations.id, invitation.id));
    return true;
  });
}
