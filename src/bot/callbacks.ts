import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../database/client.ts";
import { botSessions, callbackActions } from "../database/schema.ts";
import type { Actor } from "../modules/auth/service.ts";
import type { RouterReply } from "./router.ts";
import type { BaleButton } from "./bale/client.ts";

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function invalidateMenuButtons(db: Database, actor: Actor): Promise<void> {
  await db.update(botSessions).set({ revision: sql`${botSessions.revision} + 1`,
    updatedAt: new Date() }).where(and(eq(botSessions.userId, actor.userId),
    eq(botSessions.chatId, BigInt(actor.chatId))));
}

export async function createMenuButtons(db: Database, actor: Actor,
  buttons: NonNullable<RouterReply["buttons"]>) {
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx.insert(botSessions).values({
      userId: actor.userId, chatId: BigInt(actor.chatId), teacherId: actor.teacherId,
      role: actor.role, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    }).onConflictDoUpdate({ target: [botSessions.userId, botSessions.chatId],
      set: { teacherId: actor.teacherId, role: actor.role, updatedAt: now } });
    const [session] = await tx.update(botSessions).set({
      revision: sql`${botSessions.revision} + 1`, updatedAt: now,
    }).where(and(eq(botSessions.userId, actor.userId),
      eq(botSessions.chatId, BigInt(actor.chatId)))).returning({ revision: botSessions.revision });
    if (!session) throw new Error("Session unavailable");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const rows: BaleButton[][] = [];
    for (const button of buttons) {
      const token = randomBytes(24).toString("base64url");
      await tx.insert(callbackActions).values({
        tokenDigest: tokenDigest(token), userId: actor.userId, chatId: BigInt(actor.chatId),
        teacherId: actor.teacherId, action: "command", payload: { command: button.command },
        expectedRevision: session.revision, expiresAt,
      });
      rows.push([{ text: button.label, callback_data: token,
        ...(button.style ? { style: button.style } : {}) }]);
    }
    return rows;
  });
}

export async function consumeMenuButton(db: Database, actor: Actor, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  return db.transaction(async (tx) => {
    const digest = tokenDigest(token);
    const locked = await tx.execute(sql`SELECT token_digest FROM callback_actions WHERE token_digest = ${digest} FOR UPDATE`);
    if (locked.length !== 1) return null;
    const [action] = await tx.select().from(callbackActions).where(and(
      eq(callbackActions.tokenDigest, digest), eq(callbackActions.userId, actor.userId),
      eq(callbackActions.chatId, BigInt(actor.chatId)), eq(callbackActions.teacherId, actor.teacherId),
      isNull(callbackActions.consumedAt),
    )).limit(1);
    if (!action || action.expiresAt <= new Date() || action.action !== "command") return null;
    const [session] = await tx.select({ revision: botSessions.revision }).from(botSessions).where(and(
      eq(botSessions.userId, actor.userId), eq(botSessions.chatId, BigInt(actor.chatId)),
    )).limit(1);
    if (!session || session.revision !== action.expectedRevision) return null;
    const payload = action.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    const command = (payload as Record<string, unknown>).command;
    if (typeof command !== "string" || !command.startsWith("/")) return null;
    await tx.update(callbackActions).set({ consumedAt: new Date() }).where(eq(callbackActions.tokenDigest, digest));
    return command;
  });
}
