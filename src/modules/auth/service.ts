import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { assistants, students, teachers, users } from "../../database/schema.ts";

export type Actor =
  | { role: "teacher"; userId: string; teacherId: string; baleUserId: string; chatId: string }
  | { role: "assistant"; userId: string; teacherId: string; assistantId: string; baleUserId: string; chatId: string }
  | { role: "student"; userId: string; teacherId: string; studentId: string; baleUserId: string; chatId: string };

export async function bootstrapTeacher(db: Database, baleUserId: string): Promise<string> {
  const id = BigInt(baleUserId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(940014)`);
    const existing = await tx.select({ id: teachers.id, baleUserId: users.baleUserId })
      .from(teachers).innerJoin(users, eq(teachers.userId, users.id)).limit(1);
    if (existing[0]) {
      if (existing[0].baleUserId !== id) {
        throw new Error("Teacher identity differs from the existing owner");
      }
      return existing[0].id;
    }

    const [user] = await tx.insert(users).values({ baleUserId: id }).onConflictDoUpdate({
      target: users.baleUserId,
      set: { updatedAt: new Date() },
    }).returning({ id: users.id });
    if (!user) throw new Error("Teacher bootstrap failed");
    const [teacher] = await tx.insert(teachers).values({ userId: user.id, displayName: "معلم" }).returning({ id: teachers.id });
    if (!teacher) throw new Error("Teacher bootstrap failed");
    return teacher.id;
  });
}

export async function findActor(db: Database, baleUserId: string, chatId: string): Promise<Actor | null> {
  const [user] = await db.select().from(users).where(eq(users.baleUserId, BigInt(baleUserId))).limit(1);
  if (!user || user.privateChatId !== BigInt(chatId)) return null;

  const [teacher] = await db.select().from(teachers)
    .where(and(eq(teachers.userId, user.id), isNull(teachers.disabledAt))).limit(1);
  if (teacher) return { role: "teacher", userId: user.id, teacherId: teacher.id, baleUserId, chatId };

  const [assistant] = await db.select().from(assistants)
    .where(and(eq(assistants.userId, user.id), isNull(assistants.disabledAt))).limit(1);
  if (assistant) {
    const [owner] = await db.select({ id: teachers.id }).from(teachers)
      .where(and(eq(teachers.id, assistant.teacherId), isNull(teachers.disabledAt))).limit(1);
    if (owner) return { role: "assistant", userId: user.id, teacherId: assistant.teacherId,
      assistantId: assistant.id, baleUserId, chatId };
  }

  const [student] = await db.select().from(students)
    .where(and(eq(students.userId, user.id), isNull(students.disabledAt))).limit(1);
  if (student) {
    const [owner] = await db.select({ id: teachers.id }).from(teachers)
      .where(and(eq(teachers.id, student.teacherId), isNull(teachers.disabledAt))).limit(1);
    if (owner) return { role: "student", userId: user.id, teacherId: student.teacherId,
      studentId: student.id, baleUserId, chatId };
  }

  return null;
}

export async function touchPrivateUser(db: Database, baleUserId: string, chatId: string): Promise<string> {
  const [user] = await db.insert(users).values({
    baleUserId: BigInt(baleUserId),
    privateChatId: BigInt(chatId),
    lastSeenAt: new Date(),
  }).onConflictDoUpdate({
    target: users.baleUserId,
    set: { privateChatId: BigInt(chatId), lastSeenAt: new Date(), updatedAt: new Date() },
  }).returning({ id: users.id });
  if (!user) throw new Error("Unable to save private user");
  return user.id;
}
