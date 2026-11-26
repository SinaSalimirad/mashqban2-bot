import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { BaleClient, BaleUpdate } from "../bot/bale/client.ts";
import { parseUpdate } from "../bot/bale/client.ts";
import { handleAuthorizedMessage } from "../bot/router.ts";
import type { Database } from "../database/client.ts";
import { outboxMessages, processedUpdates } from "../database/schema.ts";
import { findActor, touchPrivateUser } from "../modules/auth/service.ts";
import { hashInvitationCode, redeemInvitationDigest } from "../modules/invitations/service.ts";
import type { PrivateFileStorage } from "../storage/private.ts";

type StoredUpdate = { update: BaleUpdate; invitationDigest?: string };

function updateOperationId(botInstanceKey: string, updateId: bigint): string {
  const digest = createHash("sha256").update(`${botInstanceKey}:${updateId}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function storedUpdate(value: unknown): StoredUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid stored update");
  const record = value as Record<string, unknown>;
  return {
    update: parseUpdate(record.update),
    ...(typeof record.invitationDigest === "string" ? { invitationDigest: record.invitationDigest } : {}),
  };
}

export async function pollIntoInbox(
  db: Database, bale: BaleClient, botInstanceKey: string, inviteCodeSecret: string,
): Promise<number> {
  const maximum = await db.execute(sql`SELECT max(update_id) AS last_id FROM processed_updates WHERE bot_instance_key = ${botInstanceKey}`);
  const last = maximum[0]?.last_id;
  const offset = last === null || last === undefined ? undefined : Number(last) + 1;
  if (offset !== undefined && !Number.isSafeInteger(offset)) throw new Error("Bale update offset exceeds safe range");
  const updates = await bale.getUpdates(offset);
  if (!updates.length) return 0;

  await db.transaction(async (tx) => {
    for (const update of updates) {
      const message = update.message;
      const text = message?.text?.trim();
      const codeDigest = text && !text.startsWith("/") ? hashInvitationCode(text, inviteCodeSecret) : undefined;
      const sanitized: BaleUpdate = message && codeDigest
        ? { update_id: update.update_id, message: { ...message, text: undefined } }
        : update;
      await tx.insert(processedUpdates).values({
        botInstanceKey, updateId: BigInt(update.update_id),
        payload: { update: sanitized, ...(codeDigest ? { invitationDigest: codeDigest } : {}) },
      }).onConflictDoNothing();
    }
  });
  return updates.length;
}

export async function recoverExpiredInboxLeases(db: Database): Promise<number> {
  const rows = await db.update(processedUpdates).set({ status: "pending", leaseUntil: null })
    .where(and(eq(processedUpdates.status, "processing"),
      sql`${processedUpdates.leaseUntil} < clock_timestamp()`))
    .returning({ updateId: processedUpdates.updateId });
  return rows.length;
}

export async function processOneUpdate(
  db: Database, botInstanceKey: string, bale: BaleClient,
  storage: PrivateFileStorage, inviteCodeSecret: string,
): Promise<boolean> {
  const item = await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      SELECT update_id FROM processed_updates
      WHERE bot_instance_key = ${botInstanceKey} AND status = 'pending'
      ORDER BY update_id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    const updateId = claimed[0]?.update_id;
    if (updateId === undefined) return null;
    const [row] = await tx.update(processedUpdates).set({ status: "processing",
      attempts: sql`${processedUpdates.attempts} + 1`, leaseUntil: new Date(Date.now() + 60_000) })
      .where(and(eq(processedUpdates.botInstanceKey, botInstanceKey),
        eq(processedUpdates.updateId, BigInt(String(updateId))))).returning();
    return row ?? null;
  });
  if (!item) return false;

  try {
    const stored = storedUpdate(item.payload);
    const message = stored.update.message;
    if (message?.chat.type === "private" && message.from) {
      const baleUserId = String(message.from.id);
      const chatId = String(message.chat.id);
      const userId = await touchPrivateUser(db, baleUserId, chatId);
      let actor = await findActor(db, baleUserId, chatId);
      let reply: string;
      let direct = false;
      if (stored.invitationDigest && !actor) {
        const success = await redeemInvitationDigest(db, stored.invitationDigest, baleUserId, chatId);
        actor = await findActor(db, baleUserId, chatId);
        reply = success && actor ? "عضویت شما فعال شد. /start را بفرستید." : "کد دعوت نامعتبر است یا دیگر قابل استفاده نیست.";
      } else if (actor) {
        const result = await handleAuthorizedMessage({ db, bale, storage, actor, userId,
          message, inviteCodeSecret, operationId: updateOperationId(botInstanceKey, item.updateId) });
        reply = result.text;
        direct = result.direct === true;
      } else {
        reply = "به مشق‌بان خوش آمدید. کد دعوت شخصی خود را وارد کنید.";
      }
      if (direct) {
        // Invitation plaintext must not enter the durable inbox/outbox or logs.
        try { await bale.sendText(chatId, reply); } catch { /* Teacher may issue a new code. */ }
      } else {
        await db.insert(outboxMessages).values({
          recipientUserId: userId, kind: "bot_reply",
          idempotencyKey: `update:${botInstanceKey}:${item.updateId}:reply`,
          payload: { text: reply },
        }).onConflictDoNothing();
      }
    }
    await db.update(processedUpdates).set({ status: "processed", processedAt: new Date(),
      leaseUntil: null, payload: { updateId: stored.update.update_id } })
      .where(and(eq(processedUpdates.botInstanceKey, botInstanceKey), eq(processedUpdates.updateId, item.updateId)));
  } catch {
    await db.update(processedUpdates).set({ status: item.attempts >= 5 ? "failed" : "pending",
      leaseUntil: null, lastError: "processing_failed" })
      .where(and(eq(processedUpdates.botInstanceKey, botInstanceKey), eq(processedUpdates.updateId, item.updateId)));
  }
  return true;
}
