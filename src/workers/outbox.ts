import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../database/client.ts";
import { assistants, fileAssets, homeworks, homeworkVersionFiles, homeworkVersions,
  outboxMessages, students, teachers, users } from "../database/schema.ts";
import { BaleApiError, type BaleButton, type BaleClient } from "../bot/bale/client.ts";
import { createMenuButtons } from "../bot/callbacks.ts";
import { findActor } from "../modules/auth/service.ts";
import type { PrivateFileStorage } from "../storage/private.ts";
import { formatPersianSchoolDate, getTehranHourInstant } from "../shared/calendar.ts";

function reportText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Invalid report payload");
  const record = payload as Record<string, unknown>;
  if (typeof record.schoolDate !== "string" || !Array.isArray(record.summaries)) throw new Error("Invalid report payload");
  const digits = new Intl.NumberFormat("fa-IR");
  const lines = record.summaries.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid report summary");
    const item = value as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.submitted !== "number" || typeof item.missing !== "number") {
      throw new Error("Invalid report summary");
    }
    return `${item.name}: تحویل‌داده ${digits.format(item.submitted)}، تحویل‌نداده ${digits.format(item.missing)}`;
  });
  const date = formatPersianSchoolDate(getTehranHourInstant(record.schoolDate, 14));
  return `🔒 بازهٔ ثبت تکلیف امروز بسته شد.\n📊 گزارش نهایی ${date}\n${lines.join("\n")}`;
}

function textPayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Invalid message payload");
  const text = (payload as Record<string, unknown>).text;
  if (typeof text !== "string" || !text) throw new Error("Invalid message payload");
  return text;
}

function replyButtons(payload: unknown): BaleButton[][] | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const buttons = (payload as Record<string, unknown>).buttons;
  if (buttons === undefined) return undefined;
  if (!Array.isArray(buttons)) throw new Error("Invalid button payload");
  return buttons.map((row) => {
    if (!Array.isArray(row)) throw new Error("Invalid button payload");
    return row.map((button) => {
      if (typeof button !== "object" || button === null || Array.isArray(button)) throw new Error("Invalid button payload");
      const value = button as Record<string, unknown>;
      if (typeof value.text !== "string" || typeof value.callback_data !== "string") throw new Error("Invalid button payload");
      const style = value.style;
      if (style !== undefined && style !== "primary" && style !== "success" && style !== "danger") {
        throw new Error("Invalid button style");
      }
      return { text: value.text, callback_data: value.callback_data,
        ...(style ? { style } : {}) };
    });
  });
}

export async function recoverExpiredOutboxLeases(db: Database): Promise<number> {
  const rows = await db.update(outboxMessages).set({ status: "unknown", leaseUntil: null,
    lastErrorCode: "lease_expired" }).where(and(eq(outboxMessages.status, "processing"),
    sql`${outboxMessages.leaseUntil} < clock_timestamp()`)).returning({ id: outboxMessages.id });
  return rows.length;
}

export async function dispatchOneOutbox(db: Database, bale: BaleClient, storage: PrivateFileStorage): Promise<boolean> {
  const item = await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      SELECT id FROM outbox_messages
      WHERE status IN ('pending','retry') AND next_attempt_at <= clock_timestamp()
      ORDER BY next_attempt_at, created_at, id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    const id = claimed[0]?.id;
    if (typeof id !== "string") return null;
    const [row] = await tx.update(outboxMessages).set({ status: "processing",
      leaseUntil: new Date(Date.now() + 60_000), attemptCount: sql`${outboxMessages.attemptCount} + 1` })
      .where(eq(outboxMessages.id, id)).returning();
    return row ?? null;
  });
  if (!item) return false;

  try {
    let chatId: string | null = null;
    if (item.targetStudentId && item.teacherId) {
      const [recipient] = await db.select({ chatId: users.privateChatId }).from(students)
        .innerJoin(users, eq(students.userId, users.id)).where(and(
          eq(students.id, item.targetStudentId), eq(students.teacherId, item.teacherId),
          isNull(students.disabledAt),
        )).limit(1);
      chatId = recipient?.chatId?.toString() ?? null;
    } else if (item.recipientUserId && item.teacherId) {
      const [owner] = await db.select({ id: teachers.id }).from(teachers).where(and(
        eq(teachers.id, item.teacherId), eq(teachers.userId, item.recipientUserId), isNull(teachers.disabledAt),
      )).limit(1);
      const [assistant] = owner ? [] : await db.select({ id: assistants.id }).from(assistants).where(and(
        eq(assistants.teacherId, item.teacherId), eq(assistants.userId, item.recipientUserId),
        isNull(assistants.disabledAt),
      )).limit(1);
      const [student] = owner || assistant ? [] : await db.select({ id: students.id }).from(students).where(and(
        eq(students.teacherId, item.teacherId), eq(students.userId, item.recipientUserId),
        isNull(students.disabledAt),
      )).limit(1);
      if (owner || assistant || student) {
        const [recipient] = await db.select({ chatId: users.privateChatId }).from(users)
          .where(eq(users.id, item.recipientUserId)).limit(1);
        chatId = recipient?.chatId?.toString() ?? null;
      }
    } else if (item.recipientUserId && item.kind === "bot_reply") {
      const [recipient] = await db.select({ chatId: users.privateChatId }).from(users)
        .where(eq(users.id, item.recipientUserId)).limit(1);
      chatId = recipient?.chatId?.toString() ?? null;
    }
    if (!chatId) {
      await db.update(outboxMessages).set({ status: "cancelled", leaseUntil: null,
        lastErrorCode: "recipient_unavailable" }).where(eq(outboxMessages.id, item.id));
      return true;
    }

    let providerMessageId: string;
    if (item.kind === "homework_file") {
      if (typeof item.payload !== "object" || item.payload === null || Array.isArray(item.payload)) {
        throw new Error("Invalid homework file payload");
      }
      const payload = item.payload as Record<string, unknown>;
      if (typeof payload.homeworkId !== "string" || typeof payload.versionId !== "string"
        || typeof payload.assetId !== "string" || !item.teacherId) {
        throw new Error("Invalid homework file payload");
      }
      const [homework] = await db.select().from(homeworks).where(and(
        eq(homeworks.id, payload.homeworkId), eq(homeworks.teacherId, item.teacherId),
      )).limit(1);
      const [version] = await db.select({ id: homeworkVersions.id }).from(homeworkVersions).where(and(
        eq(homeworkVersions.id, payload.versionId), eq(homeworkVersions.homeworkId, payload.homeworkId),
      )).limit(1);
      const [file] = await db.select({ id: homeworkVersionFiles.assetId }).from(homeworkVersionFiles).where(and(
        eq(homeworkVersionFiles.homeworkId, payload.homeworkId),
        eq(homeworkVersionFiles.versionId, payload.versionId),
        eq(homeworkVersionFiles.assetId, payload.assetId),
      )).limit(1);
      if (!homework || !version || !file) throw new Error("Homework file unavailable");
      if (item.targetStudentId && (homework.studentId !== item.targetStudentId
        || homework.currentVersionId !== version.id || homework.deletedAt)) {
        await db.update(outboxMessages).set({ status: "cancelled", leaseUntil: null,
          lastErrorCode: "access_revoked" }).where(eq(outboxMessages.id, item.id));
        return true;
      }
      const [asset] = await db.select().from(fileAssets).where(and(
        eq(fileAssets.id, file.id), eq(fileAssets.teacherId, item.teacherId),
        eq(fileAssets.status, "ready"),
      )).limit(1);
      if (!asset?.storageKey) throw new Error("Homework asset unavailable");
      const kind = asset.kind;
      if (kind !== "photo" && kind !== "document" && kind !== "video"
        && kind !== "voice" && kind !== "audio") throw new Error("Unsupported file kind");
      providerMessageId = await bale.sendMedia(chatId, kind,
        await storage.read(item.teacherId, asset.storageKey), asset.mimeType ?? "application/octet-stream");
    } else if (item.kind === "feedback_voice") {
      if (typeof item.payload !== "object" || item.payload === null || Array.isArray(item.payload)) {
        throw new Error("Invalid voice payload");
      }
      const assetId = (item.payload as Record<string, unknown>).assetId;
      if (typeof assetId !== "string" || !item.teacherId) throw new Error("Invalid voice payload");
      const [asset] = await db.select().from(fileAssets).where(and(
        eq(fileAssets.id, assetId), eq(fileAssets.teacherId, item.teacherId), eq(fileAssets.status, "ready"),
      )).limit(1);
      if (!asset?.storageKey) throw new Error("Voice asset unavailable");
      providerMessageId = await bale.sendVoice(chatId, await storage.read(item.teacherId, asset.storageKey));
    } else {
      const text = item.kind === "daily_report" ? reportText(item.payload) : textPayload(item.payload);
      let buttons = item.kind === "bot_reply" ? replyButtons(item.payload) : undefined;
      const payload = typeof item.payload === "object" && item.payload !== null && !Array.isArray(item.payload)
        ? item.payload as Record<string, unknown> : {};
      if (item.kind === "daily_report" && item.recipientUserId && typeof payload.schoolDate === "string") {
        const [recipient] = await db.select({ baleUserId: users.baleUserId,
          privateChatId: users.privateChatId }).from(users)
          .where(eq(users.id, item.recipientUserId)).limit(1);
        if (recipient?.privateChatId) {
          const actor = await findActor(db, String(recipient.baleUserId), String(recipient.privateChatId));
          if (actor) buttons = await createMenuButtons(db, actor, [
            { label: "📊 مشاهدهٔ گزارش کامل", command: `/report ${payload.schoolDate}`, style: "primary" },
          ]);
        }
      }
      if (item.kind === "feedback_text" && item.targetStudentId && typeof payload.homeworkId === "string") {
        const [recipient] = await db.select({ baleUserId: users.baleUserId,
          privateChatId: users.privateChatId }).from(students)
          .innerJoin(users, eq(students.userId, users.id)).where(and(
            eq(students.id, item.targetStudentId), isNull(students.disabledAt))).limit(1);
        if (recipient?.privateChatId) {
          const actor = await findActor(db, String(recipient.baleUserId), String(recipient.privateChatId));
          if (actor?.role === "student") buttons = await createMenuButtons(db, actor, [
            { label: "📚 مشاهدهٔ تکلیف", command: `/homeworkinfo ${payload.homeworkId}`, style: "primary" },
            { label: "💬 همهٔ بازخوردها", command: "/feedbacks" },
          ]);
        }
      }
      const editMessageId = payload.editMessageId;
      if (item.kind === "bot_reply" && typeof editMessageId === "number"
        && Number.isSafeInteger(editMessageId) && editMessageId > 0) {
        try {
          providerMessageId = await bale.editText(chatId, editMessageId, text, buttons);
        } catch (error) {
          if (!(error instanceof BaleApiError) || error.code === null || error.code >= 500 || error.code === 429) {
            throw error;
          }
          providerMessageId = await bale.sendText(chatId, text, buttons);
        }
      } else {
        providerMessageId = await bale.sendText(chatId, text, buttons);
      }
    }
    await db.update(outboxMessages).set({ status: "sent", providerMessageId,
      sentAt: new Date(), leaseUntil: null, lastErrorCode: null }).where(eq(outboxMessages.id, item.id));
  } catch (error) {
    if (error instanceof BaleApiError && error.code === 429) {
      const delaySeconds = error.retryAfter ?? Math.min(3600, 2 ** Math.min(item.attemptCount, 10));
      await db.update(outboxMessages).set({ status: "retry", leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        lastErrorCode: `bale_${error.code}` }).where(eq(outboxMessages.id, item.id));
    } else {
      await db.update(outboxMessages).set({ status: error instanceof BaleApiError && error.code !== null && error.code < 500 ? "failed" : "unknown",
        leaseUntil: null, lastErrorCode: error instanceof BaleApiError ? `bale_${error.code}` : "unknown_outcome" })
        .where(eq(outboxMessages.id, item.id));
    }
  }
  return true;
}
