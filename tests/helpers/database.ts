import { sql, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase, type Database } from "../../src/database/client.ts";
import { fileAssets, students, users } from "../../src/database/schema.ts";
import { bootstrapTeacher, findActor, touchPrivateUser, type Actor } from "../../src/modules/auth/service.ts";

const truncate = sql.raw(`TRUNCATE TABLE
  scheduler_state, outbox_messages, processed_updates, daily_report_entries, daily_reports,
  feedbacks, draft_files, homework_drafts, callback_actions, bot_sessions, audit_events,
  homework_version_files, homework_versions, homeworks, file_assets, invitation_attempts,
  invitations, class_memberships, assistants, students, classes, teachers, users
  RESTART IDENTITY CASCADE`);

export type TestDatabase = ReturnType<typeof createDatabase>;

export async function openTestDatabase(databaseUrl: string): Promise<TestDatabase> {
  const database = createDatabase(databaseUrl);
  await migrate(database.db, { migrationsFolder: "drizzle" });
  return database;
}

export async function resetTestDatabase(db: Database): Promise<void> {
  await db.execute(truncate);
}

export async function seedTeacher(db: Database, baleId = "7000000001",
  chatId = baleId): Promise<Extract<Actor, { role: "teacher" }>> {
  await bootstrapTeacher(db, baleId);
  await touchPrivateUser(db, baleId, chatId);
  const actor = await findActor(db, baleId, chatId);
  if (actor?.role !== "teacher") throw new Error("Unable to seed teacher");
  return actor;
}

export async function bindStudent(db: Database, teacherId: string, studentId: string,
  baleId: string): Promise<Extract<Actor, { role: "student" }>> {
  const userId = await touchPrivateUser(db, baleId, baleId);
  await db.update(students).set({ userId }).where(eq(students.id, studentId));
  const actor = await findActor(db, baleId, baleId);
  if (actor?.role !== "student" || actor.teacherId !== teacherId) throw new Error("Unable to bind student");
  return actor;
}

export async function readyAsset(db: Database, actor: Extract<Actor, { role: "student" }>,
  suffix: string): Promise<string> {
  const [asset] = await db.insert(fileAssets).values({
    teacherId: actor.teacherId, kind: "document", mimeType: "application/pdf",
    originalName: `${suffix}.pdf`, sizeBytes: 3, status: "ready",
    storageKey: crypto.randomUUID(), checksum: suffix.padEnd(64, "0").slice(0, 64),
    createdByUserId: actor.userId,
  }).returning({ id: fileAssets.id });
  if (!asset) throw new Error("Unable to seed asset");
  return asset.id;
}

export async function userCount(db: Database): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::integer` }).from(users);
  return row?.count ?? 0;
}
