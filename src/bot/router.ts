import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { BaleClient, BaleMessage } from "./bale/client.ts";
import type { Database } from "../database/client.ts";
import {
  assistants, botSessions, classes, classMemberships, draftFiles, feedbacks, fileAssets, invitations,
  homeworkDrafts, homeworks, homeworkVersionFiles, homeworkVersions, outboxMessages, students, teachers,
} from "../database/schema.ts";
import type { Actor } from "../modules/auth/service.ts";
import { issueInvitation, revokeInvitation } from "../modules/invitations/service.ts";
import {
  changeMembership, createAssistant, createClass, createStudent,
  deactivateAssistant, deactivateClass, deactivateStudent, disconnectStudent,
  renameAssistant, renameClass, renameStudent,
} from "../modules/roster/service.ts";
import { deleteHomework, saveHomework } from "../modules/homeworks/service.ts";
import { recordFeedback } from "../modules/feedbacks/service.ts";
import { readDailyReport, readPeriodReport, readProvisionalDailyReport } from "../modules/reports/service.ts";
import { formatPersianSchoolDate, getTehranHourInstant, getTehranTime,
  isHomeworkWindowOpen, parseSchoolDateInput, shiftPeriodReference, shiftSchoolDate } from "../shared/calendar.ts";
import type { PrivateFileStorage } from "../storage/private.ts";

export type RouterReply = { text: string; direct?: boolean;
  buttons?: Array<{ label: string; command: string; style?: "primary" | "success" | "danger" }> };

type RouterContext = { db: Database; bale: BaleClient; storage: PrivateFileStorage;
  actor: Actor; userId: string; message: BaleMessage; inviteCodeSecret: string; operationId: string };

const persianTimestamp = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short",
});

function pageNumber(input: string | undefined): number | null {
  const page = input === undefined ? 1 : Number(latinDigits(input));
  return Number.isSafeInteger(page) && page >= 1 && page <= 1000 ? page : null;
}

function latinDigits(input: string): string {
  return input.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632));
}

function cleanInputName(input: string, maxLength: number): string | null {
  const value = input.replace(/\s+/g, " ").trim();
  return value && value.length <= maxLength ? value : null;
}

function navigation(base: string, page: number, itemCount: number, pageSize: number): NonNullable<RouterReply["buttons"]> {
  return [
    ...(page > 1 ? [{ label: "◀️ قبلی", command: `${base} ${page - 1}` }] : []),
    ...(itemCount === pageSize ? [{ label: "بعدی ▶️", command: `${base} ${page + 1}` }] : []),
    { label: "🏠 منوی اصلی", command: "/menu" },
  ];
}

function draftIdFromContext(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const draftId = (value as Record<string, unknown>).draftId;
  return typeof draftId === "string" ? draftId : null;
}

async function sessionFor(db: Database, actor: Actor) {
  const now = new Date();
  const [session] = await db.insert(botSessions).values({
    userId: actor.userId, chatId: BigInt(actor.chatId), teacherId: actor.teacherId,
    role: actor.role, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  }).onConflictDoUpdate({ target: [botSessions.userId, botSessions.chatId],
    set: { updatedAt: now, teacherId: actor.teacherId, role: actor.role } }).returning();
  if (!session) throw new Error("Session unavailable");
  if (session.expiresAt <= now) {
    await db.update(homeworkDrafts).set({ status: "expired", updatedAt: now })
      .where(and(eq(homeworkDrafts.sessionId, session.id), eq(homeworkDrafts.status, "open")));
    const [refreshed] = await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1`, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) })
      .where(eq(botSessions.id, session.id)).returning();
    if (!refreshed) throw new Error("Session unavailable");
    return refreshed;
  }
  return session;
}

async function activeDraft(db: Database, actor: Actor, context: unknown) {
  const draftId = draftIdFromContext(context);
  if (!draftId || actor.role !== "student") return null;
  const [draft] = await db.select().from(homeworkDrafts).where(and(
    eq(homeworkDrafts.id, draftId), eq(homeworkDrafts.teacherId, actor.teacherId),
    eq(homeworkDrafts.studentId, actor.studentId), eq(homeworkDrafts.status, "open"),
  )).limit(1);
  return draft ?? null;
}

async function draftReview(db: Database, draft: NonNullable<Awaited<ReturnType<typeof activeDraft>>>): Promise<RouterReply> {
  const [schoolClass] = await db.select({ name: classes.name }).from(classes)
    .where(and(eq(classes.id, draft.classId), eq(classes.teacherId, draft.teacherId))).limit(1);
  const files = await db.select({ position: draftFiles.position, kind: fileAssets.kind,
    name: fileAssets.originalName }).from(draftFiles)
    .innerJoin(fileAssets, eq(draftFiles.assetId, fileAssets.id))
    .where(eq(draftFiles.draftId, draft.id)).orderBy(asc(draftFiles.position));
  const details = files.map((file) => `${file.position}. ${(file.name ?? file.kind).slice(0, 60)}`).join("\n");
  return {
    text: `پیش‌نویس ${schoolClass?.name ?? "کلاس"}\nعنوان: ${draft.title ?? "ثبت نشده"}\n${details || "هنوز فایلی دریافت نشده است."}\n${files.length} از ۲۰ فایل\nبرای نوشتن عنوان، متن یا /title عنوان را بفرستید.`,
    buttons: [
      { label: "✏️ تغییر عنوان", command: "/changetitle" },
      ...files.slice(0, 8).map((file) => ({ label: `🗑 حذف فایل ${file.position}`, command: `/remove ${file.position}` })),
      ...(draft.title && files.length ? [{ label: "✅ ثبت نهایی", command: "/finalize" }] : []),
      { label: "❌ لغو پیش‌نویس", command: "/cancel" },
    ],
  };
}

async function studentClassSelection(db: Database, teacherId: string, context: Record<string, unknown>,
  page: number): Promise<RouterReply> {
  const selected = Array.isArray(context.classIds) ? context.classIds.filter((id): id is string => typeof id === "string") : [];
  const rows = await db.select({ id: classes.id, name: classes.name }).from(classes)
    .where(and(eq(classes.teacherId, teacherId), isNull(classes.disabledAt)))
    .orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
  return { text: `کلاس‌های ${String(context.firstName)} ${String(context.lastName)} را انتخاب کنید.\n${rows.map((row) =>
    `${selected.includes(row.id) ? "✅" : "▫️"} ${row.name}`).join("\n") || "کلاسی در این صفحه نیست."}\nانتخاب‌شده: ${selected.length}`,
  buttons: [
    ...rows.map((row) => ({ label: `${selected.includes(row.id) ? "✅" : "▫️"} ${row.name}`,
      command: `/toggleclass ${row.id} ${page}` })),
    ...navigation("/studentclasses", page, rows.length, 8).filter((button) => button.command !== "/menu"),
    { label: "✅ ثبت دانش‌آموز", command: "/confirmstudent", style: "success" },
    { label: "❌ لغو", command: "/cancel" },
  ] };
}

async function beginDraft(db: Database, actor: Extract<Actor, { role: "student" }>,
  classId: string, homeworkId?: string): Promise<string> {
  const now = new Date();
  if (!isHomeworkWindowOpen(now)) return "بازهٔ ثبت تکلیف بسته است.";
  const schoolDate = getTehranTime(now).schoolDate;
  return db.transaction(async (tx) => {
    const [student] = await tx.select().from(students).where(and(eq(students.id, actor.studentId),
      eq(students.userId, actor.userId), isNull(students.disabledAt))).limit(1);
    const [schoolClass] = await tx.select().from(classes).where(and(eq(classes.id, classId),
      eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt))).limit(1);
    const [membership] = await tx.select().from(classMemberships).where(and(
      eq(classMemberships.classId, classId), eq(classMemberships.studentId, actor.studentId),
      isNull(classMemberships.leftAt),
    )).limit(1);
    if (!student || !schoolClass || !membership) return "به این کلاس دسترسی ندارید.";
    const [existingSession] = await tx.select().from(botSessions).where(and(
      eq(botSessions.userId, actor.userId), eq(botSessions.chatId, BigInt(actor.chatId)),
    )).limit(1);
    if (!existingSession) throw new Error("Session unavailable");
    const [openDraft] = await tx.select({ id: homeworkDrafts.id }).from(homeworkDrafts)
      .where(and(eq(homeworkDrafts.sessionId, existingSession.id), eq(homeworkDrafts.status, "open"))).limit(1);
    if (openDraft) return "ابتدا پیش‌نویس قبلی را با /finalize ذخیره یا با /cancel لغو کنید.";

    let baseVersionId: string | null = null;
    let title: string | null = null;
    if (homeworkId) {
      const [homework] = await tx.select().from(homeworks).where(and(eq(homeworks.id, homeworkId),
        eq(homeworks.teacherId, actor.teacherId), eq(homeworks.studentId, actor.studentId),
        eq(homeworks.classId, classId), eq(homeworks.schoolDate, schoolDate), isNull(homeworks.deletedAt))).limit(1);
      if (!homework) return "تکلیف امروز پیدا نشد.";
      const [version] = await tx.select().from(homeworkVersions)
        .where(eq(homeworkVersions.id, homework.currentVersionId)).limit(1);
      if (!version) throw new Error("Version unavailable");
      baseVersionId = version.id;
      title = version.title;
    }
    const [draft] = await tx.insert(homeworkDrafts).values({
      teacherId: actor.teacherId, studentId: actor.studentId, classId,
      sessionId: existingSession.id, schoolDate, homeworkId, baseVersionId,
      title, operationId: crypto.randomUUID(), expiresAt: getTehranHourInstant(schoolDate, 22),
    }).returning({ id: homeworkDrafts.id });
    if (!draft) throw new Error("Draft creation failed");
    if (baseVersionId) {
      const files = await tx.select().from(homeworkVersionFiles)
        .where(eq(homeworkVersionFiles.versionId, baseVersionId)).orderBy(asc(homeworkVersionFiles.position));
      if (files.length) await tx.insert(draftFiles).values(files.map((file) => ({
        teacherId: actor.teacherId, draftId: draft.id, assetId: file.assetId, position: file.position,
      })));
    }
    await tx.update(botSessions).set({ state: title ? "HOMEWORK_FILES" : "HOMEWORK_TITLE", context: { draftId: draft.id },
      revision: sql`${botSessions.revision} + 1`, expiresAt: getTehranHourInstant(schoolDate, 22),
    }).where(eq(botSessions.id, existingSession.id));
    return homeworkId
      ? "ویرایش آغاز شد. فایل بفرستید، /remove شماره برای حذف فایل، /title عنوان جدید و /finalize برای ذخیره."
      : "پیش‌نویس ساخته شد. با /title عنوان را ثبت کنید، فایل بفرستید و با /finalize ذخیره کنید.";
  });
}

export async function handleAuthorizedMessage(input: RouterContext): Promise<RouterReply> {
  const { db, actor, message } = input;
  let text = message.text?.trim() ?? "";
  if (actor.role !== "student" && (text === "/report" || text === "/week" || text === "/month")) {
    text += ` ${getTehranTime(new Date()).schoolDate}`;
  }
  const session = await sessionFor(db, actor);
  const draft = await activeDraft(db, actor, session.context);

  if (text === "/menu" && session.state !== "IDLE") text = "/cancel";
  if (text === "/start" && (session.state === "CANCEL_CONFIRM" || session.state !== "IDLE" && !draft)) {
    text = "/cancel";
  }
  if (text === "/start" && draft && session.state !== "CANCEL_CONFIRM") return draftReview(db, draft);

  if (text === "/cancel") {
    if (session.state === "IDLE" && !draft) return { text: "عملیات فعالی برای لغو وجود ندارد.",
      buttons: [{ label: "🏠 منوی اصلی", command: "/menu" }] };
    if (session.state === "CANCEL_CONFIRM") {
      return { text: "از لغو این عملیات مطمئن هستید؟",
        buttons: [{ label: "بله، لغو شود", command: "/confirmcancel", style: "danger" },
          { label: "ادامه می‌دهم", command: "/keepdraft" }] };
    }
    await db.update(botSessions).set({ state: "CANCEL_CONFIRM",
      context: { ...(typeof session.context === "object" && session.context !== null && !Array.isArray(session.context)
        ? session.context as Record<string, unknown> : {}), resumeState: session.state },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "از لغو این عملیات مطمئن هستید؟",
      buttons: [{ label: "بله، لغو شود", command: "/confirmcancel", style: "danger" },
        { label: "ادامه می‌دهم", command: "/keepdraft" }] };
  }
  if (text === "/confirmcancel" && session.state === "CANCEL_CONFIRM") {
    if (draft) await db.update(homeworkDrafts).set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(homeworkDrafts.id, draft.id));
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "عملیات لغو شد.", buttons: [{ label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (text === "/keepdraft" && session.state === "CANCEL_CONFIRM") {
    const context = session.context;
    const resumeState = typeof context === "object" && context !== null && !Array.isArray(context)
      ? (context as Record<string, unknown>).resumeState : null;
    const state = typeof resumeState === "string" && resumeState !== "CANCEL_CONFIRM" ? resumeState : "IDLE";
    await db.update(botSessions).set({ state, context: {
      ...(typeof context === "object" && context !== null && !Array.isArray(context) ? context as Record<string, unknown> : {}),
      resumeState: undefined,
    }, revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return draft ? draftReview(db, draft) : { text: "عملیات ادامه دارد. مرحلهٔ قبلی را تکمیل کنید." };
  }
  if (session.state === "CANCEL_CONFIRM") {
    return { text: "برای لغو /confirmcancel و برای ادامه /keepdraft را بفرستید." };
  }
  if (text === "/start" || text === "/menu") {
    if (actor.role === "student") {
      const [student] = await db.select({ firstName: students.firstName, lastName: students.lastName })
        .from(students).where(eq(students.id, actor.studentId)).limit(1);
      return { text: `سلام ${student?.firstName ?? "دانش‌آموز"} ${student?.lastName ?? ""}\nبازهٔ ثبت و ویرایش تکلیف: ۱۴:۰۰ تا ۲۲:۰۰ تهران.`,
      buttons: [
        { label: "📤 ثبت تکلیف", command: "/submit" },
        { label: "🏫 کلاس‌های من", command: "/classes" },
        { label: "📝 تکلیف‌های امروز", command: "/today" },
        { label: "📚 تاریخچه", command: "/history" },
        { label: "💬 بازخوردها", command: "/feedbacks" },
      ] };
    }
    const [staff] = actor.role === "teacher"
      ? await db.select({ name: teachers.displayName }).from(teachers)
        .where(eq(teachers.id, actor.teacherId)).limit(1)
      : await db.select({ name: assistants.displayName }).from(assistants)
        .where(eq(assistants.id, actor.assistantId)).limit(1);
    return { text: `سلام ${staff?.name ?? "همکار"}\n${actor.role === "teacher" ? "منوی معلم" : "دسترسی شما: مشاهده و ارسال بازخورد"}`,
      buttons: [
        { label: "🏫 کلاس‌ها", command: "/classes" },
        { label: "👥 دانش‌آموزان", command: "/students" },
        ...(actor.role === "teacher" ? [{ label: "🤝 دستیاران", command: "/assistants" }] : []),
        { label: "📥 تکلیف‌ها", command: "/homeworkmenu" },
        { label: "📊 گزارش‌ها", command: "/reports" },
      ] };
  }
  if (actor.role !== "student" && session.state === "IDLE" && text === "/reports") {
    return { text: "گزارش موردنظر را انتخاب کنید.",
      buttons: [{ label: "📊 امروز", command: "/report" },
        { label: "📅 این هفته", command: "/week" },
        { label: "🗓 این ماه", command: "/month" },
        { label: "🔎 گزارش روز دیگر", command: "/reportdate daily" },
        { label: "🔎 هفتهٔ دیگر", command: "/reportdate week" },
        { label: "🔎 ماه دیگر", command: "/reportdate month" },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role !== "student" && session.state === "IDLE"
    && (text === "/homeworkmenu" || text.startsWith("/homeworkmenu "))) {
    const page = pageNumber(text.slice(13).trim() || undefined);
    if (!page) return { text: "فرمت: /homeworkmenu [صفحه]" };
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classes)
      .where(and(eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt)))
      .orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
    const today = getTehranTime(new Date()).schoolDate;
    return { text: `تکلیف‌های امروز — صفحه ${page}؛ کلاس را انتخاب کنید.\n${rows.map((row) => row.name).join("\n") || "کلاسی در این صفحه نیست."}`,
      buttons: [...rows.map((row) => ({ label: row.name, command: `/homeworks ${today} ${row.id} 1 all` })),
        ...navigation("/homeworkmenu", page, rows.length, 8).filter((button) => button.command !== "/menu"),
        { label: "🏫 همهٔ کلاس‌ها", command: "/classes" },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }

  if (actor.role !== "student" && session.state === "IDLE" && text.startsWith("/reportdate ")) {
    const kind = text.slice(12).trim();
    if (kind !== "daily" && kind !== "week" && kind !== "month") {
      return { text: "نوع گزارش نامعتبر است." };
    }
    await db.update(botSessions).set({ state: "REPORT_DATE_INPUT", context: { kind },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "تاریخ موردنظر را در تقویم شمسی، مانند ۱۴۰۵/۰۹/۰۵، بفرستید.",
      buttons: [{ label: "◀️ گزارش‌ها", command: "/cancel" }] };
  }
  if (actor.role !== "student" && session.state === "REPORT_DATE_INPUT" && text && !text.startsWith("/")) {
    const date = parseSchoolDateInput(text);
    if (!date) return { text: "تاریخ معتبر نیست. نمونه: ۱۴۰۵/۰۹/۰۵",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
    const context = session.context as Record<string, unknown>;
    const kind = context.kind;
    if (kind !== "daily" && kind !== "week" && kind !== "month") throw new Error("Invalid report date session");
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    const command = kind === "daily" ? `/report ${date}` : `/${kind} ${date}`;
    return handleAuthorizedMessage({ ...input, message: { ...message, text: command } });
  }
  if (actor.role !== "student" && session.state === "IDLE" && text.startsWith("/homeworkdate ")) {
    const classId = text.slice(14).trim();
    const [schoolClass] = await db.select({ id: classes.id, name: classes.name }).from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, actor.teacherId))).limit(1);
    if (!schoolClass) return { text: "کلاس پیدا نشد." };
    await db.update(botSessions).set({ state: "HOMEWORK_DATE_INPUT",
      context: { classId }, revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `تاریخ تکلیف‌های «${schoolClass.name}» را در تقویم شمسی بفرستید. نمونه: ۱۴۰۵/۰۹/۰۵`,
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && session.state === "HOMEWORK_DATE_INPUT" && text && !text.startsWith("/")) {
    const date = parseSchoolDateInput(text);
    const context = session.context as Record<string, unknown>;
    if (!date) return { text: "تاریخ معتبر نیست. نمونه: ۱۴۰۵/۰۹/۰۵",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
    if (typeof context.classId !== "string") throw new Error("Invalid homework date session");
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return handleAuthorizedMessage({ ...input,
      message: { ...message, text: `/homeworks ${date} ${context.classId} 1 all` } });
  }
  if (actor.role === "student" && session.state === "IDLE" && text === "/historydate") {
    await db.update(botSessions).set({ state: "STUDENT_HISTORY_DATE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "تاریخ تکلیف را در تقویم شمسی بفرستید. نمونه: ۱۴۰۵/۰۹/۰۵",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "student" && session.state === "STUDENT_HISTORY_DATE" && text && !text.startsWith("/")) {
    const date = parseSchoolDateInput(text);
    if (!date) return { text: "تاریخ معتبر نیست. نمونه: ۱۴۰۵/۰۹/۰۵",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return handleAuthorizedMessage({ ...input, message: { ...message, text: `/historyon ${date}` } });
  }

  if (actor.role === "teacher" && session.state === "IDLE" && text === "/newclass") {
    await db.update(botSessions).set({ state: "CLASS_CREATE",
      context: { operationId: crypto.randomUUID() }, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: "نام کلاس جدید را بفرستید (حداکثر ۸۰ نویسه).",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && session.state === "CLASS_CREATE" && text && !text.startsWith("/")) {
    const name = text.replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) return { text: "نام کلاس باید بین ۱ تا ۸۰ نویسه باشد." };
    await db.update(botSessions).set({ state: "CLASS_CONFIRM",
      context: { ...(session.context as Record<string, unknown>), name },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `کلاس «${name}» ساخته شود؟`, buttons: [
      { label: "✅ تأیید", command: "/confirmclass", style: "success" }, { label: "❌ لغو", command: "/cancel" },
    ] };
  }
  if (actor.role === "teacher" && session.state === "CLASS_CONFIRM" && text === "/confirmclass") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.name !== "string" || typeof context.operationId !== "string") throw new Error("Invalid class session");
    const id = await createClass(db, actor, context.name, context.operationId);
    await db.update(botSessions).set({ state: "IDLE", context: {}, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: `کلاس ثبت شد: ${context.name}`, buttons: [
      { label: "🏫 جزئیات کلاس", command: `/classinfo ${id}` }, { label: "🏠 منوی اصلی", command: "/menu" },
    ] };
  }
  if (actor.role === "teacher" && session.state === "IDLE" && text === "/newassistant") {
    await db.update(botSessions).set({ state: "ASSISTANT_CREATE",
      context: { operationId: crypto.randomUUID() }, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: "نام نمایشی دستیار را بفرستید (حداکثر ۱۲۰ نویسه).",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && session.state === "ASSISTANT_CREATE" && text && !text.startsWith("/")) {
    const name = text.replace(/\s+/g, " ").trim();
    if (!name || name.length > 120) return { text: "نام دستیار باید بین ۱ تا ۱۲۰ نویسه باشد." };
    await db.update(botSessions).set({ state: "ASSISTANT_CONFIRM",
      context: { ...(session.context as Record<string, unknown>), name },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `دستیار «${name}» ساخته شود؟`, buttons: [
      { label: "✅ تأیید", command: "/confirmassistant", style: "success" }, { label: "❌ لغو", command: "/cancel" },
    ] };
  }
  if (actor.role === "teacher" && session.state === "ASSISTANT_CONFIRM" && text === "/confirmassistant") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.name !== "string" || typeof context.operationId !== "string") throw new Error("Invalid assistant session");
    const id = await createAssistant(db, actor, context.name, context.operationId);
    await db.update(botSessions).set({ state: "IDLE", context: {}, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: `دستیار ثبت شد: ${context.name}`, buttons: [
      { label: "🔑 صدور دعوت", command: `/invite assistant ${id}` },
      { label: "🏠 منوی اصلی", command: "/menu" },
    ] };
  }
  if (actor.role === "teacher" && session.state === "IDLE" && text === "/newstudent") {
    await db.update(botSessions).set({ state: "STUDENT_FIRST",
      context: { operationId: crypto.randomUUID() }, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: "نام کوچک دانش‌آموز را بفرستید.", buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && session.state === "STUDENT_FIRST" && text && !text.startsWith("/")) {
    const firstName = text.replace(/\s+/g, " ").trim();
    if (!firstName || firstName.length > 80) return { text: "نام باید بین ۱ تا ۸۰ نویسه باشد." };
    await db.update(botSessions).set({ state: "STUDENT_LAST",
      context: { ...(session.context as Record<string, unknown>), firstName },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "نام خانوادگی دانش‌آموز را بفرستید.", buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && session.state === "STUDENT_LAST" && text && !text.startsWith("/")) {
    const lastName = text.replace(/\s+/g, " ").trim();
    if (!lastName || lastName.length > 80) return { text: "نام خانوادگی باید بین ۱ تا ۸۰ نویسه باشد." };
    const context = { ...(session.context as Record<string, unknown>), lastName, classIds: [] };
    await db.update(botSessions).set({ state: "STUDENT_CLASSES", context,
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return studentClassSelection(db, actor.teacherId, context, 1);
  }
  if (actor.role === "teacher" && session.state === "STUDENT_CLASSES" && text.startsWith("/studentclasses")) {
    const page = pageNumber(text.slice(15).trim() || undefined);
    return page ? studentClassSelection(db, actor.teacherId, session.context as Record<string, unknown>, page)
      : { text: "شمارهٔ صفحه نامعتبر است." };
  }
  if (actor.role === "teacher" && session.state === "STUDENT_CLASSES" && text.startsWith("/toggleclass ")) {
    const [classId, pageInput] = text.slice(13).trim().split(/\s+/);
    const page = pageNumber(pageInput);
    if (!classId || !page) return { text: "انتخاب کلاس نامعتبر است." };
    const [schoolClass] = await db.select({ id: classes.id }).from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt))).limit(1);
    if (!schoolClass) return { text: "کلاس دیگر فعال نیست." };
    const context = session.context as Record<string, unknown>;
    const selected = Array.isArray(context.classIds) ? context.classIds.filter((id): id is string => typeof id === "string") : [];
    const classIds = selected.includes(classId) ? selected.filter((id) => id !== classId) : [...selected, classId];
    await db.update(botSessions).set({ context: { ...context, classIds },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return studentClassSelection(db, actor.teacherId, { ...context, classIds }, page);
  }
  if (actor.role === "teacher" && session.state === "STUDENT_CLASSES" && text === "/confirmstudent") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.firstName !== "string" || typeof context.lastName !== "string"
      || typeof context.operationId !== "string" || !Array.isArray(context.classIds)
      || !context.classIds.every((id) => typeof id === "string")) throw new Error("Invalid student session");
    const id = await createStudent(db, actor, context.firstName, context.lastName,
      context.classIds, context.operationId);
    await db.update(botSessions).set({ state: "IDLE", context: {}, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: `دانش‌آموز ثبت شد: ${context.firstName} ${context.lastName}`,
      buttons: [{ label: "🔑 صدور دعوت", command: `/invite student ${id}` },
        { label: "👤 جزئیات", command: `/studentinfo ${id}` }] };
  }
  if (actor.role === "teacher" && session.state === "IDLE" && text.startsWith("/renamerequest ")) {
    const [kind, id] = text.slice(15).trim().split(/\s+/);
    if ((kind !== "class" && kind !== "student" && kind !== "assistant") || !id) {
      return { text: "درخواست تغییر نام نامعتبر است." };
    }
    const target = kind === "class"
      ? await db.select({ name: classes.name }).from(classes).where(and(
        eq(classes.id, id), eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt))).limit(1)
      : kind === "student"
        ? await db.select({ name: sql<string>`${students.firstName} || ' ' || ${students.lastName}` }).from(students)
          .where(and(eq(students.id, id), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt))).limit(1)
        : await db.select({ name: assistants.displayName }).from(assistants).where(and(
          eq(assistants.id, id), eq(assistants.teacherId, actor.teacherId), isNull(assistants.disabledAt))).limit(1);
    if (!target[0]) return { text: "پروندهٔ فعال پیدا نشد." };
    await db.update(botSessions).set({ state: "RENAME_INPUT", context: { kind, id },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: kind === "student"
      ? `نام فعلی: ${target[0].name}\nنام و نام خانوادگی جدید را با | جدا کنید؛ نمونه: علی|احمدی`
      : `نام فعلی: ${target[0].name}\nنام جدید را بفرستید.`,
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && session.state === "RENAME_INPUT" && text && !text.startsWith("/")) {
    const context = session.context as Record<string, unknown>;
    if ((context.kind !== "class" && context.kind !== "student" && context.kind !== "assistant")
      || typeof context.id !== "string") throw new Error("Invalid rename session");
    let firstName: string | undefined;
    let lastName: string | undefined;
    let name: string | undefined;
    if (context.kind === "student") {
      const [first = "", last = "", ...extra] = text.split("|");
      if (extra.length) return { text: "نام و نام خانوادگی را فقط با یک | جدا کنید." };
      firstName = cleanInputName(first, 80) ?? undefined;
      lastName = cleanInputName(last, 80) ?? undefined;
      if (!firstName || !lastName) return { text: "نام و نام خانوادگی معتبر بفرستید؛ نمونه: علی|احمدی" };
    } else {
      name = cleanInputName(text, context.kind === "class" ? 80 : 120) ?? undefined;
      if (!name) return { text: "نام خالی یا بیش از حد طولانی است." };
    }
    await db.update(botSessions).set({ state: "RENAME_CONFIRM",
      context: { ...context, ...(name ? { name } : { firstName, lastName }) },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    const display = name ?? `${firstName} ${lastName}`;
    return { text: `نام به «${display}» تغییر کند؟`, buttons: [
      { label: "✅ تأیید تغییر نام", command: "/confirmrename", style: "success" },
      { label: "❌ لغو", command: "/cancel" },
    ] };
  }
  if (actor.role === "teacher" && session.state === "RENAME_CONFIRM" && text === "/confirmrename") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.id !== "string") throw new Error("Invalid rename session");
    if (context.kind === "class" && typeof context.name === "string") {
      await renameClass(db, actor, context.id, context.name);
    } else if (context.kind === "assistant" && typeof context.name === "string") {
      await renameAssistant(db, actor, context.id, context.name);
    } else if (context.kind === "student" && typeof context.firstName === "string"
      && typeof context.lastName === "string") {
      await renameStudent(db, actor, context.id, context.firstName, context.lastName);
    } else throw new Error("Invalid rename session");
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    const detailCommand = context.kind === "class" ? `/classinfo ${context.id}`
      : context.kind === "student" ? `/studentinfo ${context.id}` : `/assistantinfo ${context.id}`;
    return { text: "نام با موفقیت تغییر کرد.", buttons: [
      { label: "◀️ بازگشت به جزئیات", command: detailCommand },
      { label: "🏠 منوی اصلی", command: "/menu" },
    ] };
  }
  if (["CLASS_CREATE", "CLASS_CONFIRM", "ASSISTANT_CREATE", "ASSISTANT_CONFIRM",
    "STUDENT_FIRST", "STUDENT_LAST", "STUDENT_CLASSES", "RENAME_INPUT", "RENAME_CONFIRM",
    "REPORT_DATE_INPUT", "HOMEWORK_DATE_INPUT", "STUDENT_HISTORY_DATE"].includes(session.state)) {
    return { text: "مرحلهٔ جاری را کامل کنید یا /cancel را بفرستید." };
  }
  if (actor.role !== "student" && session.state === "IDLE" && text === "/findclasses") {
    await db.update(botSessions).set({ state: "CLASS_SEARCH", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "بخشی از نام کلاس را بفرستید.", buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && session.state === "IDLE" && text === "/findstudents") {
    await db.update(botSessions).set({ state: "STUDENT_SEARCH", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "بخشی از نام یا نام خانوادگی دانش‌آموز را بفرستید.",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && session.state === "IDLE" && text === "/findassistants") {
    await db.update(botSessions).set({ state: "ASSISTANT_SEARCH", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "بخشی از نام دستیار را بفرستید.",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && session.state === "CLASS_SEARCH" && text && !text.startsWith("/")) {
    text = `/findclasses ${text}|1`;
  }
  if (actor.role !== "student" && session.state === "STUDENT_SEARCH" && text && !text.startsWith("/")) {
    text = `/findstudents ${text}|1`;
  }
  if (actor.role === "teacher" && session.state === "ASSISTANT_SEARCH" && text && !text.startsWith("/")) {
    text = `/findassistants ${text}|1`;
  }
  if (["CLASS_SEARCH", "STUDENT_SEARCH"].includes(session.state)
    && !text.startsWith("/findclasses ") && !text.startsWith("/findstudents ")) {
    return { text: "عبارت جست‌وجو را بفرستید یا /cancel را انتخاب کنید." };
  }
  if (session.state === "ASSISTANT_SEARCH" && !text.startsWith("/findassistants ")) {
    return { text: "عبارت جست‌وجو را بفرستید یا /cancel را انتخاب کنید." };
  }
  if (actor.role !== "student" && (session.state === "IDLE"
    || session.state === "CLASS_SEARCH" && text.startsWith("/findclasses ")
    || session.state === "STUDENT_SEARCH" && text.startsWith("/findstudents "))
    && (text.startsWith("/findclasses ") || text.startsWith("/findstudents "))) {
    if (session.state !== "IDLE") {
      await db.update(botSessions).set({ state: "IDLE", context: {},
        revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    }
    const kind = text.startsWith("/findclasses ") ? "classes" : "students";
    const rest = text.slice(kind === "classes" ? 13 : 14).trim();
    const separator = rest.lastIndexOf("|");
    const term = (separator === -1 ? rest : rest.slice(0, separator)).trim();
    const page = pageNumber(separator === -1 ? undefined : rest.slice(separator + 1).trim());
    if (!term || term.length > 80 || !page) return { text: "عبارت جست‌وجو یا شمارهٔ صفحه نامعتبر است." };
    const pattern = `%${term}%`;
    if (kind === "classes") {
      const rows = await db.select({ id: classes.id, name: classes.name }).from(classes)
        .where(and(eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt),
          ilike(classes.name, pattern)))
        .orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
      return { text: `نتیجهٔ کلاس‌ها برای «${term}» — صفحه ${page}\n${rows.map((row) => row.name).join("\n") || "موردی نیست."}`,
        buttons: [...rows.map((row) => ({ label: `🏫 ${row.name.slice(0, 28)}`, command: `/classinfo ${row.id}` })),
          ...(page > 1 ? [{ label: "◀️ قبلی", command: `/findclasses ${term}|${page - 1}` }] : []),
          ...(rows.length === 8 ? [{ label: "بعدی ▶️", command: `/findclasses ${term}|${page + 1}` }] : []),
          { label: "🏫 کلاس‌ها", command: "/classes" }] };
    }
    const rows = await db.select({ id: students.id, firstName: students.firstName,
      lastName: students.lastName }).from(students).where(and(eq(students.teacherId, actor.teacherId),
      isNull(students.disabledAt), or(ilike(students.firstName, pattern), ilike(students.lastName, pattern))))
      .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id))
      .limit(8).offset((page - 1) * 8);
    return { text: `نتیجهٔ دانش‌آموزان برای «${term}» — صفحه ${page}\n${rows.map((row) =>
      `${row.firstName} ${row.lastName}`).join("\n") || "موردی نیست."}`,
      buttons: [...rows.map((row) => ({ label: `👤 ${row.firstName} ${row.lastName}`.slice(0, 35),
        command: `/studentinfo ${row.id}` })),
        ...(page > 1 ? [{ label: "◀️ قبلی", command: `/findstudents ${term}|${page - 1}` }] : []),
        ...(rows.length === 8 ? [{ label: "بعدی ▶️", command: `/findstudents ${term}|${page + 1}` }] : []),
        { label: "👥 دانش‌آموزان", command: "/students" }] };
  }
  if (actor.role === "teacher" && (session.state === "IDLE"
    || session.state === "ASSISTANT_SEARCH" && text.startsWith("/findassistants "))
    && text.startsWith("/findassistants ")) {
    if (session.state !== "IDLE") {
      await db.update(botSessions).set({ state: "IDLE", context: {},
        revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    }
    const rest = text.slice(16).trim();
    const separator = rest.lastIndexOf("|");
    const term = (separator === -1 ? rest : rest.slice(0, separator)).trim();
    const page = pageNumber(separator === -1 ? undefined : rest.slice(separator + 1).trim());
    if (!term || term.length > 120 || !page) return { text: "عبارت جست‌وجو یا شمارهٔ صفحه نامعتبر است." };
    const rows = await db.select({ id: assistants.id, displayName: assistants.displayName })
      .from(assistants).where(and(eq(assistants.teacherId, actor.teacherId),
        isNull(assistants.disabledAt), ilike(assistants.displayName, `%${term}%`)))
      .orderBy(asc(assistants.displayName), asc(assistants.id)).limit(8).offset((page - 1) * 8);
    return { text: `نتیجهٔ دستیاران برای «${term}» — صفحه ${page}\n${rows.map((row) =>
      row.displayName).join("\n") || "موردی نیست."}`,
      buttons: [...rows.map((row) => ({ label: `🤝 ${row.displayName.slice(0, 30)}`,
        command: `/assistantinfo ${row.id}` })),
        ...(page > 1 ? [{ label: "◀️ قبلی", command: `/findassistants ${term}|${page - 1}` }] : []),
        ...(rows.length === 8 ? [{ label: "بعدی ▶️", command: `/findassistants ${term}|${page + 1}` }] : []),
        { label: "🤝 دستیاران", command: "/assistants" }] };
  }
  const waitingForConfirmation: Record<string, string> = {
    REBIND_CONFIRM: "/confirmrebind", DEACTIVATE_CONFIRM: "/confirmdeactivate",
    MEMBERSHIP_CONFIRM: "/confirmmembership", DELETE_CONFIRM: "/confirmdelete",
    FEEDBACK_CONFIRM: "/confirmfeedback",
  };
  const expectedCommand = waitingForConfirmation[session.state];
  if (expectedCommand && text !== expectedCommand) {
    return { text: `برای تأیید ${expectedCommand} و برای لغو /cancel را بفرستید.` };
  }
  if (session.state === "FEEDBACK_INPUT" && (!text || text.startsWith("/"))) {
    return { text: "متن بازخورد را بفرستید یا /cancel را انتخاب کنید." };
  }
  if (session.state === "FEEDBACK_VOICE" && message.media?.kind !== "voice") {
    return { text: "پیام صوتی را بفرستید یا /cancel را انتخاب کنید." };
  }
  if (draft && !["/review", "/changetitle", "/finalize"].includes(text)
    && !text.startsWith("/title ") && !text.startsWith("/remove ")
    && !message.media && !(session.state === "HOMEWORK_TITLE" && text && !text.startsWith("/"))) {
    return { text: "ابتدا پیش‌نویس را ذخیره یا با /cancel لغو کنید." };
  }

  if (actor.role === "teacher" && text.startsWith("/class ")) {
    const id = await createClass(db, actor, text.slice(7), input.operationId);
    return { text: `کلاس ثبت شد. شناسه: ${id}` };
  }
  if (actor.role === "teacher" && text.startsWith("/student ")) {
    const [first, last, ids] = text.slice(9).split("|");
    if (!first || !last) return { text: "فرمت: /student نام|نام خانوادگی|شناسه کلاس‌ها با ویرگول" };
    const classIds = ids?.trim() ? ids.split(",").map((id) => id.trim()) : [];
    const id = await createStudent(db, actor, first, last, classIds, input.operationId);
    return { text: `دانش‌آموز ثبت شد. شناسه: ${id}` };
  }
  if (actor.role === "teacher" && text.startsWith("/assistant ")) {
    const id = await createAssistant(db, actor, text.slice(11), input.operationId);
    return { text: `دستیار ثبت شد. شناسه: ${id}` };
  }
  if (actor.role === "teacher" && text.startsWith("/renameclass ")) {
    const [id, ...parts] = text.slice(13).trim().split(/\s+/);
    if (!id || !parts.length) return { text: "فرمت: /renameclass شناسه نام جدید" };
    await renameClass(db, actor, id, parts.join(" "));
    return { text: "نام کلاس تغییر کرد." };
  }
  if (actor.role === "teacher" && text.startsWith("/renamestudent ")) {
    const [id, first, last] = text.slice(15).trim().split("|").map((part) => part.trim());
    if (!id || !first || !last) return { text: "فرمت: /renamestudent شناسه|نام|نام خانوادگی" };
    await renameStudent(db, actor, id, first, last);
    return { text: "نام دانش‌آموز تغییر کرد." };
  }
  if (actor.role === "teacher" && text.startsWith("/renameassistant ")) {
    const [id, ...parts] = text.slice(17).trim().split(/\s+/);
    if (!id || !parts.length) return { text: "فرمت: /renameassistant شناسه نام جدید" };
    await renameAssistant(db, actor, id, parts.join(" "));
    return { text: "نام دستیار تغییر کرد." };
  }
  if (actor.role === "teacher" && text.startsWith("/invite ")) {
    const [kind, id] = text.slice(8).split(" ");
    if ((kind !== "student" && kind !== "assistant") || !id) {
      return { text: "فرمت: /invite student شناسه یا /invite assistant شناسه" };
    }
    const code = await issueInvitation(db, actor, { kind, id }, input.inviteCodeSecret);
    return { text: `کد دعوت شخصی: ${code}\nاین کد یک‌بار و تا ۷ روز معتبر است.`, direct: true };
  }
  if (actor.role === "teacher" && text.startsWith("/rebind ")) {
    const [kind, id] = text.slice(8).trim().split(/\s+/);
    if ((kind !== "student" && kind !== "assistant") || !id) {
      return { text: "فرمت: /rebind student شناسه یا /rebind assistant شناسه" };
    }
    const code = await issueInvitation(db, actor, { kind, id }, input.inviteCodeSecret, true);
    return { text: `اتصال حساب قبلی قطع شد. کد دعوت تازه: ${code}\nاین کد یک‌بار و تا ۷ روز معتبر است.`, direct: true };
  }
  if (actor.role === "teacher" && text.startsWith("/rebindrequest ")) {
    const [kind, id] = text.slice(15).trim().split(/\s+/);
    if ((kind !== "student" && kind !== "assistant") || !id) return { text: "درخواست تغییر حساب نامعتبر است." };
    const [target] = kind === "student"
      ? await db.select({ userId: students.userId }).from(students).where(and(
        eq(students.id, id), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt))).limit(1)
      : await db.select({ userId: assistants.userId }).from(assistants).where(and(
        eq(assistants.id, id), eq(assistants.teacherId, actor.teacherId), isNull(assistants.disabledAt))).limit(1);
    if (!target?.userId) return { text: "حساب فعالی برای تغییر پیدا نشد." };
    await db.update(botSessions).set({ state: "REBIND_CONFIRM", context: { kind, id },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "حساب قبلی فوراً قطع می‌شود و کد دعوت تازه صادر خواهد شد. تاریخچه باقی می‌ماند. تأیید می‌کنید؟",
      buttons: [{ label: "✅ تغییر حساب", command: "/confirmrebind", style: "danger" },
        { label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && text === "/confirmrebind" && session.state === "REBIND_CONFIRM") {
    const context = session.context as Record<string, unknown>;
    if ((context.kind !== "student" && context.kind !== "assistant") || typeof context.id !== "string") {
      throw new Error("Invalid rebind session");
    }
    const code = await issueInvitation(db, actor, { kind: context.kind, id: context.id }, input.inviteCodeSecret, true);
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `اتصال حساب قبلی قطع شد. کد دعوت تازه: ${code}\nکد را فقط به شخص موردنظر بدهید؛ یک‌بار و تا ۷ روز معتبر است.`, direct: true };
  }
  if (session.state === "REBIND_CONFIRM") return { text: "برای تغییر حساب /confirmrebind و برای لغو /cancel را بفرستید." };
  if (actor.role === "teacher" && text.startsWith("/revokeinvite ")) {
    const [kind, id] = text.slice(14).trim().split(/\s+/);
    if ((kind !== "student" && kind !== "assistant") || !id) {
      return { text: "فرمت: /revokeinvite student شناسه یا /revokeinvite assistant شناسه" };
    }
    await revokeInvitation(db, actor, { kind, id });
    return { text: "کد دعوت فعال باطل شد.", buttons: [
      { label: "◀️ بازگشت به جزئیات",
        command: kind === "student" ? `/studentinfo ${id}` : `/assistantinfo ${id}` },
      { label: "🏠 منوی اصلی", command: "/menu" },
    ] };
  }
  if (actor.role === "teacher" && (text.startsWith("/join ") || text.startsWith("/leave "))) {
    const active = text.startsWith("/join ");
    const [studentId, classId] = text.slice(active ? 6 : 7).split(" ");
    if (!studentId || !classId) return { text: "فرمت: /join شناسه دانش‌آموز شناسه کلاس یا /leave ..." };
    await changeMembership(db, actor, studentId, classId, active);
    return { text: active ? "عضویت کلاس فعال شد." : "عضویت کلاس پایان یافت." };
  }
  if (actor.role === "teacher" && text === "/confirmmembership" && session.state === "MEMBERSHIP_CONFIRM") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.studentId !== "string" || typeof context.classId !== "string"
      || typeof context.active !== "boolean") throw new Error("Invalid membership session");
    await changeMembership(db, actor, context.studentId, context.classId, context.active);
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: context.active ? "عضویت کلاس فعال شد." : "عضویت کلاس پایان یافت.",
      buttons: [{ label: "🏫 کلاس‌های دانش‌آموز", command: `/memberships ${context.studentId}` }] };
  }
  if (session.state === "MEMBERSHIP_CONFIRM") {
    return { text: "برای تأیید /confirmmembership و برای لغو /cancel را بفرستید." };
  }
  if (actor.role === "teacher" && text.startsWith("/membershiprequest ")) {
    if (session.state !== "IDLE") return { text: "ابتدا عملیات فعلی را کامل یا لغو کنید." };
    const [studentId, classId, action] = text.slice(19).trim().split(/\s+/);
    if (!studentId || !classId || (action !== "join" && action !== "leave")) {
      return { text: "درخواست عضویت نامعتبر است." };
    }
    const [student] = await db.select({ id: students.id }).from(students).where(and(
      eq(students.id, studentId), eq(students.teacherId, actor.teacherId), isNull(students.disabledAt))).limit(1);
    const [schoolClass] = await db.select({ name: classes.name }).from(classes).where(and(
      eq(classes.id, classId), eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt))).limit(1);
    if (!student || !schoolClass) return { text: "دانش‌آموز یا کلاس فعال پیدا نشد." };
    await db.update(botSessions).set({ state: "MEMBERSHIP_CONFIRM",
      context: { studentId, classId, active: action === "join" },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `${action === "join" ? "عضویت در" : "پایان عضویت در"} کلاس «${schoolClass.name}» تأیید شود؟`,
      buttons: [{ label: "✅ تأیید", command: "/confirmmembership", style: "success" },
        { label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role === "teacher" && text.startsWith("/disconnect ")) {
    await disconnectStudent(db, actor, text.slice(12).trim());
    return { text: "اتصال حساب دانش‌آموز قطع شد. برای حساب جدید کد دعوت صادر کنید." };
  }
  if (actor.role === "teacher" && text === "/confirmdeactivate" && session.state === "DEACTIVATE_CONFIRM") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.id !== "string") throw new Error("Invalid deactivation session");
    if (context.kind === "student") await deactivateStudent(db, actor, context.id);
    else if (context.kind === "class") await deactivateClass(db, actor, context.id);
    else if (context.kind === "assistant") await deactivateAssistant(db, actor, context.id);
    else throw new Error("Invalid deactivation session");
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "غیرفعال‌سازی انجام شد؛ تاریخچه باقی می‌ماند.",
      buttons: [{ label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (session.state === "DEACTIVATE_CONFIRM") {
    return { text: "برای غیرفعال‌سازی /confirmdeactivate و برای لغو /cancel را بفرستید." };
  }
  if (actor.role === "teacher" && (text.startsWith("/deactivatestudent ")
    || text.startsWith("/deactivateclass ") || text.startsWith("/deactivateassistant "))) {
    if (session.state !== "IDLE") return { text: "ابتدا عملیات فعلی را کامل یا لغو کنید." };
    const kind = text.startsWith("/deactivatestudent ") ? "student"
      : text.startsWith("/deactivateclass ") ? "class" : "assistant";
    const id = text.slice(kind === "student" ? 19 : kind === "class" ? 17 : 21).trim();
    const [target] = kind === "student"
      ? await db.select({ id: students.id }).from(students).where(and(eq(students.id, id),
        eq(students.teacherId, actor.teacherId), isNull(students.disabledAt))).limit(1)
      : kind === "class"
        ? await db.select({ id: classes.id }).from(classes).where(and(eq(classes.id, id),
          eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt))).limit(1)
        : await db.select({ id: assistants.id }).from(assistants).where(and(eq(assistants.id, id),
          eq(assistants.teacherId, actor.teacherId), isNull(assistants.disabledAt))).limit(1);
    if (!target) return { text: "پروندهٔ فعال پیدا نشد." };
    await db.update(botSessions).set({ state: "DEACTIVATE_CONFIRM", context: { kind, id },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `این ${kind === "class" ? "کلاس" : kind === "student" ? "دانش‌آموز" : "دستیار"} غیرفعال شود؟ دسترسی جدید متوقف می‌شود و تاریخچه باقی می‌ماند.`,
      buttons: [{ label: "✅ تأیید غیرفعال‌سازی", command: "/confirmdeactivate", style: "danger" },
        { label: "❌ لغو", command: "/cancel" }] };
  }

  if (actor.role === "student" && (text === "/submit" || /^\/submit \d+$/.test(latinDigits(text)))) {
    const page = pageNumber(text.slice(8).trim() || undefined);
    if (!page) return { text: "فرمت: /submit [صفحه]" };
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classMemberships)
      .innerJoin(classes, eq(classMemberships.classId, classes.id)).where(and(
        eq(classMemberships.studentId, actor.studentId), isNull(classMemberships.leftAt),
        isNull(classes.disabledAt),
      )).orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
    return { text: rows.length ? `کلاس تکلیف را انتخاب کنید (صفحه ${page}):\n${rows.map((row) =>
      `${row.name}: /submit ${row.id}`).join("\n")}` : "کلاسی در این صفحه نیست.",
      buttons: [...rows.map((row) => ({ label: row.name, command: `/submit ${row.id}` })),
        ...navigation("/submit", page, rows.length, 8)] };
  }
  if (actor.role === "student" && text.startsWith("/submit ")) {
    const message = await beginDraft(db, actor, text.slice(8).trim());
    const updatedSession = await sessionFor(db, actor);
    const updatedDraft = await activeDraft(db, actor, updatedSession.context);
    if (!updatedDraft || !message.includes("آغاز شد") && !message.includes("ساخته شد")) return { text: message };
    const review = await draftReview(db, updatedDraft);
    return { ...review, text: `${message}\n\n${review.text}` };
  }
  if (actor.role === "student" && text.startsWith("/edit ")) {
    const homeworkId = text.slice(6).trim();
    const [homework] = await db.select({ classId: homeworks.classId }).from(homeworks).where(and(
      eq(homeworks.id, homeworkId), eq(homeworks.teacherId, actor.teacherId),
      eq(homeworks.studentId, actor.studentId), isNull(homeworks.deletedAt),
    )).limit(1);
    if (!homework) return { text: "تکلیف پیدا نشد." };
    const message = await beginDraft(db, actor, homework.classId, homeworkId);
    const updatedSession = await sessionFor(db, actor);
    const updatedDraft = await activeDraft(db, actor, updatedSession.context);
    if (!updatedDraft || !message.includes("آغاز شد")) return { text: message };
    const review = await draftReview(db, updatedDraft);
    return { ...review, text: `${message}\n\n${review.text}` };
  }
  if (actor.role === "student" && draft && text === "/review") return draftReview(db, draft);
  if (actor.role === "student" && draft && text === "/changetitle") {
    await db.update(botSessions).set({ state: "HOMEWORK_TITLE",
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "عنوان جدید را بفرستید (حداکثر ۱۲۰ نویسه).",
      buttons: [{ label: "📋 بازگشت به پیش‌نویس", command: "/review" }] };
  }
  if (actor.role === "student" && draft && (text.startsWith("/title ")
    || session.state === "HOMEWORK_TITLE" && text && !text.startsWith("/"))) {
    const title = (text.startsWith("/title ") ? text.slice(7) : text).trim();
    if (!title || title.length > 120) return { text: "عنوان باید بین ۱ تا ۱۲۰ نویسه باشد." };
    await db.update(homeworkDrafts).set({ title, updatedAt: new Date() }).where(eq(homeworkDrafts.id, draft.id));
    await db.update(botSessions).set({ state: "HOMEWORK_FILES",
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return draftReview(db, { ...draft, title });
  }
  if (actor.role === "student" && draft && text.startsWith("/remove ")) {
    const position = Number(latinDigits(text.slice(8)));
    if (!Number.isSafeInteger(position) || position < 1) return { text: "شمارهٔ فایل نامعتبر است." };
    const removed = await db.delete(draftFiles)
      .where(and(eq(draftFiles.draftId, draft.id), eq(draftFiles.position, position)))
      .returning({ assetId: draftFiles.assetId });
    if (!removed.length) return { text: "فایلی با این شماره در پیش‌نویس پیدا نشد." };
    const review = await draftReview(db, draft);
    return { ...review, text: `فایل از پیش‌نویس حذف شد. نسخهٔ قبلی تغییر نکرده است.\n\n${review.text}` };
  }
  if (actor.role === "student" && draft && text === "/finalize") {
    if (!draft.title) return { text: "ابتدا با /title عنوان تکلیف را وارد کنید." };
    const files = await db.select({ assetId: draftFiles.assetId }).from(draftFiles)
      .where(eq(draftFiles.draftId, draft.id)).orderBy(asc(draftFiles.position));
    if (!files.length) return { text: "حداقل یک فایل بفرستید." };
    const homeworkId = await saveHomework(db, actor, { operationId: draft.operationId,
      classId: draft.classId, title: draft.title, assetIds: files.map((file) => file.assetId),
      ...(draft.homeworkId && draft.baseVersionId
        ? { homeworkId: draft.homeworkId, baseVersionId: draft.baseVersionId } : {}),
    });
    await db.update(homeworkDrafts).set({ status: "committed", committedHomeworkId: homeworkId,
      updatedAt: new Date() }).where(eq(homeworkDrafts.id, draft.id));
    await db.update(botSessions).set({ state: "IDLE", context: {}, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    const [schoolClass] = await db.select({ name: classes.name }).from(classes)
      .where(and(eq(classes.id, draft.classId), eq(classes.teacherId, actor.teacherId))).limit(1);
    return { text: `✅ تکلیف ذخیره شد.\nتاریخ و زمان: ${persianTimestamp.format(new Date())}\nکلاس: ${schoolClass?.name ?? "نامشخص"}\nعنوان: ${draft.title}\nتعداد فایل‌ها: ${files.length}\nشناسه: ${homeworkId}`,
      buttons: [{ label: "👁 مشاهده تکلیف", command: `/homeworkinfo ${homeworkId}` },
        { label: "📤 ثبت تکلیف دیگر", command: "/submit" },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role === "student" && draft && message.media) {
    if (!draft.title || session.state === "HOMEWORK_TITLE") return { text: "ابتدا عنوان تکلیف را بفرستید." };
    if (draft.expiresAt <= new Date()) return { text: "بازهٔ ثبت تکلیف بسته است." };
    const [count] = await db.select({ total: sql<number>`count(*)::integer` }).from(draftFiles)
      .where(eq(draftFiles.draftId, draft.id));
    if ((count?.total ?? 0) >= 20) return { text: "هر تکلیف حداکثر ۲۰ فایل دارد." };
    if (message.media.sizeBytes && message.media.sizeBytes > 20 * 1024 * 1024) {
      return { text: "حجم فایل بیش از حد مجاز است." };
    }
    const stream = await input.bale.downloadFile(message.media.fileId);
    const stored = await input.storage.store(actor.teacherId, stream);
    const [asset] = await db.insert(fileAssets).values({ teacherId: actor.teacherId,
      kind: message.media.kind,
      mimeType: message.media.mimeType ?? (message.media.kind === "voice" ? "audio/ogg" : null),
      originalName: message.media.originalName, sizeBytes: stored.sizeBytes,
      providerFileId: message.media.fileId, storageKey: stored.storageKey,
      status: "ready", checksum: stored.sha256, createdByUserId: actor.userId,
    }).returning({ id: fileAssets.id });
    if (!asset) throw new Error("File record unavailable");
    const [last] = await db.select({ position: draftFiles.position }).from(draftFiles)
      .where(eq(draftFiles.draftId, draft.id)).orderBy(sql`${draftFiles.position} DESC`).limit(1);
    await db.insert(draftFiles).values({ teacherId: actor.teacherId, draftId: draft.id,
      assetId: asset.id, position: (last?.position ?? 0) + 1 });
    const review = await draftReview(db, draft);
    return { ...review, text: `فایل دریافت شد.\n\n${review.text}` };
  }
  if (actor.role === "student" && draft && text && !text.startsWith("/")) {
    return { text: "در این مرحله فایل بفرستید، یا برای تغییر عنوان /changetitle را انتخاب کنید." };
  }

  if (actor.role === "student" && (text === "/classes" || text.startsWith("/classes "))) {
    const page = pageNumber(text.slice(8).trim() || undefined);
    if (!page) return { text: "فرمت: /classes [صفحه]" };
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classMemberships)
      .innerJoin(classes, eq(classMemberships.classId, classes.id)).where(and(
        eq(classMemberships.studentId, actor.studentId), isNull(classMemberships.leftAt),
        isNull(classes.disabledAt),
      )).orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
    return { text: rows.length ? `کلاس‌های من — صفحه ${page}\n${rows.map((row) => row.name).join("\n")}`
      : "کلاس فعالی در این صفحه ندارید.", buttons: navigation("/classes", page, rows.length, 8) };
  }
  if (actor.role === "student" && (text === "/today" || text.startsWith("/today "))) {
    const page = pageNumber(text.slice(6).trim() || undefined);
    if (!page) return { text: "فرمت: /today [صفحه]" };
    const schoolDate = getTehranTime(new Date()).schoolDate;
    const rows = await db.select({ id: homeworks.id, versionId: homeworkVersions.id, title: homeworkVersions.title,
      className: classes.name }).from(homeworks)
      .innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id)).where(and(
        eq(homeworks.studentId, actor.studentId), eq(homeworks.teacherId, actor.teacherId),
        eq(homeworks.schoolDate, schoolDate), isNull(homeworks.deletedAt),
      )).orderBy(asc(classes.name), asc(homeworks.createdAt), asc(homeworks.id))
      .limit(8).offset((page - 1) * 8);
    return { text: rows.length ? rows.map((row) =>
      `${row.className} — ${row.title}\nتکلیف ${row.id}\nنسخه ${row.versionId}`).join("\n")
      : "امروز تکلیفی ثبت نشده است.",
      buttons: [...rows.map((row) => ({ label: `📝 ${row.title.slice(0, 28)}`, command: `/homeworkinfo ${row.id}` })),
        ...navigation("/today", page, rows.length, 8), { label: "📤 ثبت تکلیف", command: "/submit" }] };
  }
  if (actor.role === "student" && (text === "/history" || text.startsWith("/history "))) {
    const page = pageNumber(text.slice(8).trim() || undefined);
    if (!page) return { text: "فرمت: /history [صفحه]" };
    const rows = await db.select({ id: homeworks.id, title: homeworkVersions.title,
      schoolDate: homeworks.schoolDate, className: classes.name }).from(homeworks)
      .innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id)).where(and(
        eq(homeworks.studentId, actor.studentId), eq(homeworks.teacherId, actor.teacherId),
        isNull(homeworks.deletedAt),
      )).orderBy(desc(homeworks.schoolDate), desc(homeworks.createdAt), desc(homeworks.id))
      .limit(8).offset((page - 1) * 8);
    return { text: rows.length ? `تاریخچه — صفحه ${page}\n${rows.map((row) =>
      `${formatPersianSchoolDate(getTehranHourInstant(row.schoolDate, 14))} — ${row.className} — ${row.title}\n${row.id}`).join("\n")
      }` : "تکلیفی در این صفحه نیست.",
      buttons: [...rows.map((row) => ({ label: `📚 ${row.title.slice(0, 28)}`, command: `/homeworkinfo ${row.id}` })),
        ...navigation("/history", page, rows.length, 8).filter((button) => button.command !== "/menu"),
        { label: "📅 انتخاب تاریخ", command: "/historydate" },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role === "student" && text.startsWith("/historyon ")) {
    const [dateInput, pageInput] = text.slice(11).trim().split(/\s+/);
    const schoolDate = parseSchoolDateInput(dateInput ?? "");
    const page = pageNumber(pageInput);
    if (!schoolDate || !page) return { text: "فرمت: /historyon ۱۴۰۵/۰۹/۰۵ [صفحه]" };
    const rows = await db.select({ id: homeworks.id, title: homeworkVersions.title,
      className: classes.name }).from(homeworks)
      .innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id)).where(and(
        eq(homeworks.studentId, actor.studentId), eq(homeworks.teacherId, actor.teacherId),
        eq(homeworks.schoolDate, schoolDate), isNull(homeworks.deletedAt),
      )).orderBy(asc(classes.name), asc(homeworks.createdAt), asc(homeworks.id))
      .limit(8).offset((page - 1) * 8);
    const previousDate = shiftSchoolDate(schoolDate, -1);
    const nextDate = shiftSchoolDate(schoolDate, 1);
    return { text: `${formatPersianSchoolDate(getTehranHourInstant(schoolDate, 14))} — صفحه ${page}\n${rows.map((row) =>
      `${row.className} — ${row.title}`).join("\n") || "تکلیفی در این روز نیست."}`,
      buttons: [...rows.map((row) => ({ label: `📚 ${row.title.slice(0, 28)}`, command: `/homeworkinfo ${row.id}` })),
        ...(page > 1 ? [{ label: "◀️ قبلی", command: `/historyon ${schoolDate} ${page - 1}` }] : []),
        ...(rows.length === 8 ? [{ label: "بعدی ▶️", command: `/historyon ${schoolDate} ${page + 1}` }] : []),
        { label: "⬅️ روز قبل", command: `/historyon ${previousDate}` },
        { label: "روز بعد ➡️", command: `/historyon ${nextDate}` },
        { label: "📅 تاریخ دیگر", command: "/historydate" },
        { label: "📚 همهٔ تاریخچه", command: "/history" },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (text.startsWith("/homeworkinfo ")) {
    const id = text.slice(14).trim();
    const [homework] = await db.select({ id: homeworks.id, classId: homeworks.classId,
      studentId: homeworks.studentId, schoolDate: homeworks.schoolDate,
      deletedAt: homeworks.deletedAt, versionId: homeworks.currentVersionId,
      title: homeworkVersions.title, savedAt: homeworkVersions.createdAt,
      className: classes.name, firstName: students.firstName, lastName: students.lastName })
      .from(homeworks).innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id))
      .innerJoin(students, eq(homeworks.studentId, students.id))
      .where(and(eq(homeworks.id, id), eq(homeworks.teacherId, actor.teacherId),
        actor.role === "student" ? eq(homeworks.studentId, actor.studentId) : undefined)).limit(1);
    if (!homework || actor.role === "student" && homework.deletedAt) return { text: "تکلیف پیدا نشد." };
    const [fileCount] = await db.select({ total: sql<number>`count(*)::integer` }).from(homeworkVersionFiles)
      .where(eq(homeworkVersionFiles.versionId, homework.versionId));
    const withinStudentWindow = actor.role === "student" && !homework.deletedAt
      && homework.schoolDate === getTehranTime(new Date()).schoolDate && isHomeworkWindowOpen(new Date());
    const [activeMembership] = withinStudentWindow ? await db.select({ id: classMemberships.id })
      .from(classMemberships).where(and(eq(classMemberships.teacherId, actor.teacherId),
        eq(classMemberships.studentId, actor.studentId), eq(classMemberships.classId, homework.classId),
        isNull(classMemberships.leftAt))).limit(1) : [];
    const canStudentEdit = withinStudentWindow && Boolean(activeMembership);
    return { text: `تکلیف: ${homework.title}\nدانش‌آموز: ${homework.firstName} ${homework.lastName}\nکلاس: ${homework.className}\nتاریخ: ${formatPersianSchoolDate(getTehranHourInstant(homework.schoolDate, 14))}\nآخرین تغییر: ${persianTimestamp.format(homework.savedAt)}\nوضعیت: ${homework.deletedAt ? "حذف‌شده" : "فعال"}\nفایل‌ها: ${fileCount?.total ?? 0}\nشناسه: ${homework.id}`,
      buttons: [
        ...(!homework.deletedAt ? [{ label: "📎 فایل‌های فعلی", command: actor.role === "student"
          ? `/files ${id}` : `/files ${id} ${homework.versionId}` }] : []),
        ...(actor.role !== "student" ? [{ label: "🕓 تاریخچهٔ نسخه‌ها", command: `/versions ${id}` },
          { label: "💬 بازخوردها", command: `/feedbacks ${id}` },
          { label: "✍️ بازخورد متنی", command: `/feedbackstart ${id} ${homework.versionId}` },
          { label: "🎙 بازخورد صوتی", command: `/voicefeedback ${id} ${homework.versionId}` }] : []),
        ...(canStudentEdit ? [{ label: "✏️ ویرایش", command: `/edit ${id}` },
          { label: "🗑 حذف تکلیف", command: `/delete ${id} ${homework.versionId}` }] : []),
        ...(actor.role === "teacher" && !homework.deletedAt
          ? [{ label: "🗑 حذف تکلیف", command: `/delete ${id} ${homework.versionId}` }] : []),
        { label: "🏠 منوی اصلی", command: "/menu" },
      ] };
  }
  if (text.startsWith("/files ")) {
    const [homeworkId, requestedVersionId] = text.slice(7).trim().split(" ");
    if (!homeworkId) return { text: "فرمت: /files شناسه تکلیف [شناسه نسخه برای staff]" };
    const [homework] = await db.select().from(homeworks).where(and(
      eq(homeworks.id, homeworkId), eq(homeworks.teacherId, actor.teacherId),
    )).limit(1);
    if (!homework) return { text: "تکلیف پیدا نشد." };
    if (actor.role === "student" && (homework.studentId !== actor.studentId || homework.deletedAt)) {
      return { text: "به این تکلیف دسترسی ندارید." };
    }
    if (actor.role !== "student" && !requestedVersionId) {
      return { text: "برای staff، شناسهٔ نسخه را هم وارد کنید." };
    }
    const versionId = actor.role === "student" ? homework.currentVersionId : requestedVersionId;
    if (!versionId) return { text: "نسخه پیدا نشد." };
    const [version] = await db.select({ id: homeworkVersions.id }).from(homeworkVersions)
      .where(and(eq(homeworkVersions.id, versionId), eq(homeworkVersions.homeworkId, homework.id))).limit(1);
    if (!version) return { text: "نسخه پیدا نشد." };
    const files = await db.select({ assetId: homeworkVersionFiles.assetId,
      status: fileAssets.status }).from(homeworkVersionFiles)
      .innerJoin(fileAssets, eq(homeworkVersionFiles.assetId, fileAssets.id))
      .where(and(eq(homeworkVersionFiles.homeworkId, homework.id),
        eq(homeworkVersionFiles.versionId, version.id)))
      .orderBy(asc(homeworkVersionFiles.position)).limit(20);
    if (!files.length) return { text: "این نسخه فایلی ندارد." };
    const available = files.filter((file) => file.status === "ready");
    for (const [index, file] of available.entries()) {
      await db.insert(outboxMessages).values({
        teacherId: actor.teacherId,
        ...(actor.role === "student" ? { targetStudentId: actor.studentId } : { recipientUserId: actor.userId }),
        kind: "homework_file",
        idempotencyKey: `file:${input.operationId}:${index + 1}`,
        payload: { homeworkId: homework.id, versionId: version.id, assetId: file.assetId },
      }).onConflictDoNothing();
    }
    const unavailable = files.length - available.length;
    return { text: `${available.length} فایل برای ارسال در صف قرار گرفت.${unavailable
      ? ` ${unavailable} فایل دیگر در دسترس نیست.` : ""}`,
      buttons: [{ label: "◀️ بازگشت به تکلیف", command: `/homeworkinfo ${homework.id}` },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role !== "student" && text.startsWith("/versions ")) {
    const [homeworkId, pageInput] = text.slice(10).trim().split(/\s+/);
    const page = pageNumber(pageInput);
    if (!homeworkId || !page) return { text: "فرمت: /versions شناسه تکلیف [صفحه]" };
    const [homework] = await db.select({ id: homeworks.id, studentId: homeworks.studentId }).from(homeworks)
      .where(and(eq(homeworks.id, homeworkId), eq(homeworks.teacherId, actor.teacherId))).limit(1);
    if (!homework) return { text: "تکلیف پیدا نشد." };
    const versions = await db.select({ id: homeworkVersions.id, versionNo: homeworkVersions.versionNo,
      title: homeworkVersions.title, kind: homeworkVersions.kind,
      createdAt: homeworkVersions.createdAt, createdByUserId: homeworkVersions.createdByUserId })
      .from(homeworkVersions).where(eq(homeworkVersions.homeworkId, homework.id))
      .orderBy(desc(homeworkVersions.versionNo)).limit(9).offset((page - 1) * 8);
    if (!versions.length) return { text: "نسخه‌ای در این صفحه نیست." };
    const [student] = await db.select({ userId: students.userId, firstName: students.firstName,
      lastName: students.lastName }).from(students).where(eq(students.id, homework.studentId)).limit(1);
    const [teacher] = await db.select({ userId: teachers.userId, displayName: teachers.displayName })
      .from(teachers).where(eq(teachers.id, actor.teacherId)).limit(1);
    const authors = await db.select({ userId: assistants.userId, displayName: assistants.displayName })
      .from(assistants).where(and(eq(assistants.teacherId, actor.teacherId),
        inArray(assistants.userId, versions.map((version) => version.createdByUserId))));
    const fileRows = await db.select({ versionId: homeworkVersionFiles.versionId,
      assetId: homeworkVersionFiles.assetId, kind: fileAssets.kind,
      originalName: fileAssets.originalName, status: fileAssets.status })
      .from(homeworkVersionFiles)
      .innerJoin(fileAssets, eq(homeworkVersionFiles.assetId, fileAssets.id))
      .where(inArray(homeworkVersionFiles.versionId, versions.map((version) => version.id)))
      .orderBy(asc(homeworkVersionFiles.position));
    const filesByVersion = new Map(versions.map((version) => [version.id,
      fileRows.filter((file) => file.versionId === version.id)]));
    const lines = versions.slice(0, 8).map((version, index) => {
      const current = filesByVersion.get(version.id) ?? [];
      const older = filesByVersion.get(versions[index + 1]?.id ?? "") ?? [];
      const currentIds = new Set(current.map((file) => file.assetId));
      const olderIds = new Set(older.map((file) => file.assetId));
      const added = current.filter((file) => !olderIds.has(file.assetId)).map((file) =>
        (file.originalName ?? file.kind).slice(0, 60));
      const removed = older.filter((file) => !currentIds.has(file.assetId)).map((file) =>
        (file.originalName ?? file.kind).slice(0, 60));
      const changes = version.versionNo === 1 ? `${current.length} فایل اولیه`
        : `${added.length} افزوده، ${removed.length} حذف‌شده`;
      const addedNames = added.length ? `\n+ ${added.slice(0, 3).join("، ")}` : "";
      const removedNames = removed.length ? `\n− ${removed.slice(0, 3).join("، ")}` : "";
      const author = version.createdByUserId === student?.userId
        ? `دانش‌آموز ${student.firstName} ${student.lastName}`
        : version.createdByUserId === teacher?.userId ? `معلم ${teacher.displayName}`
          : `دستیار ${authors.find((item) => item.userId === version.createdByUserId)?.displayName ?? "نامشخص"}`;
      return `نسخه ${version.versionNo} (${version.kind}) — ${persianTimestamp.format(version.createdAt)}\n${author} — ${version.title}\n${changes}${addedNames}${removedNames}\nشناسه: ${version.id}`;
    });
    return { text: `تاریخچهٔ تکلیف — صفحه ${page}\n${lines.join("\n\n")}\nبرای دریافت فایل‌ها: /files ${homework.id} شناسهٔ نسخه`,
      buttons: [...versions.slice(0, 8).filter((version) => version.kind !== "deleted")
        .map((version) => ({ label: `📎 نسخه ${version.versionNo}`, command: `/files ${homework.id} ${version.id}` })),
        ...navigation(`/versions ${homework.id}`, page, Math.min(versions.length, 8), 8)
          .filter((button) => button.command !== "/menu"),
        { label: "◀️ بازگشت به تکلیف", command: `/homeworkinfo ${homework.id}` },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (text === "/confirmdelete" && session.state === "DELETE_CONFIRM") {
    const context = session.context as Record<string, unknown>;
    if (typeof context.homeworkId !== "string" || typeof context.versionId !== "string"
      || typeof context.operationId !== "string") throw new Error("Invalid deletion session");
    await deleteHomework(db, actor, context.homeworkId, context.versionId, context.operationId);
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "تکلیف حذف شد؛ تاریخچه برای معلم حفظ می‌شود.",
      buttons: [{ label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (session.state === "DELETE_CONFIRM") {
    return { text: "برای حذف /confirmdelete و برای لغو /cancel را بفرستید." };
  }
  if (actor.role !== "assistant" && text.startsWith("/delete ")) {
    if (draft || session.state !== "IDLE") return { text: "ابتدا عملیات فعلی را کامل یا لغو کنید." };
    const [homeworkId, versionId] = text.slice(8).trim().split(/\s+/);
    if (!homeworkId || !versionId) return { text: "فرمت: /delete شناسه تکلیف شناسه نسخه" };
    const [homework] = await db.select({ title: homeworkVersions.title,
      studentId: homeworks.studentId, currentVersionId: homeworks.currentVersionId,
      deletedAt: homeworks.deletedAt }).from(homeworks)
      .innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .where(and(eq(homeworks.id, homeworkId), eq(homeworks.teacherId, actor.teacherId),
        actor.role === "student" ? eq(homeworks.studentId, actor.studentId) : undefined)).limit(1);
    if (!homework || homework.deletedAt || homework.currentVersionId !== versionId) {
      return { text: "نسخهٔ فعلی تکلیف پیدا نشد؛ فهرست را تازه کنید." };
    }
    await db.update(botSessions).set({ state: "DELETE_CONFIRM",
      context: { homeworkId, versionId, operationId: input.operationId },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `تکلیف «${homework.title}» حذف شود؟ نسخه‌ها و تاریخچه برای staff باقی می‌ماند.`,
      buttons: [{ label: "🗑 بله، حذف شود", command: "/confirmdelete", style: "danger" },
        { label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && (text === "/classes" || text.startsWith("/classes "))) {
    const args = text.slice(8).trim().split(/\s+/).filter(Boolean);
    const archived = args[0] === "archived";
    const page = pageNumber(archived ? args[1] : args[0]);
    if (!page) return { text: "فرمت: /classes [archived] [صفحه]" };
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classes)
      .where(and(eq(classes.teacherId, actor.teacherId),
        archived ? isNotNull(classes.disabledAt) : isNull(classes.disabledAt)))
      .orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
    return { text: rows.length ? `کلاس‌های ${archived ? "آرشیوشده" : "فعال"} — صفحه ${page}\n${rows.map((row) => `${row.name}: ${row.id}`).join("\n")}`
      : "کلاسی در این صفحه نیست.",
      buttons: [...rows.map((row) => ({ label: `🏫 ${row.name.slice(0, 30)}`, command: `/classinfo ${row.id}` })),
        ...navigation(archived ? "/classes archived" : "/classes", page, rows.length, 8),
        { label: archived ? "🏫 کلاس‌های فعال" : "🗂 کلاس‌های آرشیوشده",
          command: archived ? "/classes" : "/classes archived" },
        ...(archived ? [] : [{ label: "🔎 جست‌وجو", command: "/findclasses" }]),
        ...(actor.role === "teacher" && !archived ? [{ label: "➕ کلاس جدید", command: "/newclass" }] : [])] };
  }
  if (actor.role !== "student" && text.startsWith("/classinfo ")) {
    const classId = text.slice(11).trim();
    const [schoolClass] = await db.select({ id: classes.id, name: classes.name,
      disabledAt: classes.disabledAt }).from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, actor.teacherId))).limit(1);
    if (!schoolClass) return { text: "کلاس پیدا نشد." };
    const [members] = await db.select({ total: sql<number>`count(*)::integer` }).from(classMemberships)
      .where(and(eq(classMemberships.teacherId, actor.teacherId),
        eq(classMemberships.classId, classId), isNull(classMemberships.leftAt)));
    const today = getTehranTime(new Date()).schoolDate;
    return { text: `کلاس: ${schoolClass.name}\nوضعیت: ${schoolClass.disabledAt ? "آرشیوشده" : "فعال"}\nاعضای فعال: ${members?.total ?? 0}\nشناسه: ${classId}`,
      buttons: [{ label: "👥 اعضا", command: `/classmembers ${classId}` },
        { label: "📥 تکلیف‌های امروز", command: `/homeworks ${today} ${classId} 1 all` },
        { label: "📅 تکلیف‌های تاریخ دیگر", command: `/homeworkdate ${classId}` },
        { label: "📊 گزارش امروز", command: `/report ${today}` },
        ...(actor.role === "teacher" && !schoolClass.disabledAt
          ? [{ label: "✏️ تغییر نام", command: `/renamerequest class ${classId}` }] : []),
        ...(actor.role === "teacher" && !schoolClass.disabledAt
          ? [{ label: "🗑 غیرفعال‌سازی", command: `/deactivateclass ${classId}` }] : []),
        { label: "◀️ کلاس‌ها", command: schoolClass.disabledAt ? "/classes archived" : "/classes" }] };
  }
  if (actor.role !== "student" && text.startsWith("/classmembers ")) {
    const [classId, pageInput] = text.slice(14).trim().split(/\s+/);
    const page = pageNumber(pageInput);
    if (!classId || !page) return { text: "فرمت: /classmembers شناسه کلاس [صفحه]" };
    const [schoolClass] = await db.select({ name: classes.name }).from(classes)
      .where(and(eq(classes.id, classId), eq(classes.teacherId, actor.teacherId))).limit(1);
    if (!schoolClass) return { text: "کلاس پیدا نشد." };
    const rows = await db.select({ id: students.id, firstName: students.firstName,
      lastName: students.lastName }).from(classMemberships)
      .innerJoin(students, eq(classMemberships.studentId, students.id))
      .where(and(eq(classMemberships.classId, classId),
        eq(classMemberships.teacherId, actor.teacherId), isNull(classMemberships.leftAt)))
      .orderBy(asc(students.lastName), asc(students.firstName), asc(students.id))
      .limit(8).offset((page - 1) * 8);
    return { text: `${schoolClass.name} — صفحه ${page}\n${rows.map((row) =>
      `${row.firstName} ${row.lastName}: ${row.id}`).join("\n") || "عضوی در این صفحه نیست."}`,
      buttons: [...rows.map((row) => ({ label: `👤 ${row.firstName} ${row.lastName}`.slice(0, 35),
        command: `/studentinfo ${row.id}` })),
        ...navigation(`/classmembers ${classId}`, page, rows.length, 8)
          .filter((button) => button.command !== "/menu"),
        { label: "◀️ جزئیات کلاس", command: `/classinfo ${classId}` },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role !== "student" && (text === "/students" || text.startsWith("/students "))) {
    const args = text.slice(9).trim().split(/\s+/).filter(Boolean);
    const archived = args[0] === "archived";
    const page = pageNumber(archived ? args[1] : args[0]);
    if (!page) return { text: "فرمت: /students [archived] [صفحه]" };
    const rows = await db.select({ id: students.id, firstName: students.firstName,
      lastName: students.lastName }).from(students).where(and(
      eq(students.teacherId, actor.teacherId),
      archived ? isNotNull(students.disabledAt) : isNull(students.disabledAt),
    )).orderBy(asc(students.lastName), asc(students.firstName), asc(students.id))
      .limit(8).offset((page - 1) * 8);
    return { text: rows.length ? `دانش‌آموزان ${archived ? "غیرفعال" : "فعال"} — صفحه ${page}\n${rows.map((row) =>
      `${row.firstName} ${row.lastName}: ${row.id}`).join("\n")}` : "دانش‌آموزی در این صفحه نیست.",
      buttons: [...rows.map((row) => ({ label: `👤 ${row.firstName} ${row.lastName}`.slice(0, 35),
        command: `/studentinfo ${row.id}` })),
        ...navigation(archived ? "/students archived" : "/students", page, rows.length, 8),
        { label: archived ? "👥 دانش‌آموزان فعال" : "🗂 دانش‌آموزان غیرفعال",
          command: archived ? "/students" : "/students archived" },
        ...(archived ? [] : [{ label: "🔎 جست‌وجو", command: "/findstudents" }]),
        ...(actor.role === "teacher" && !archived
          ? [{ label: "➕ دانش‌آموز جدید", command: "/newstudent" }] : [])] };
  }
  if (actor.role !== "student" && text.startsWith("/studentinfo ")) {
    const studentId = text.slice(13).trim();
    const [student] = await db.select().from(students).where(and(
      eq(students.id, studentId), eq(students.teacherId, actor.teacherId))).limit(1);
    if (!student) return { text: "دانش‌آموز پیدا نشد." };
    const memberships = await db.select({ name: classes.name }).from(classMemberships)
      .innerJoin(classes, eq(classMemberships.classId, classes.id))
      .where(and(eq(classMemberships.teacherId, actor.teacherId),
        eq(classMemberships.studentId, student.id), isNull(classMemberships.leftAt)))
      .orderBy(asc(classes.name)).limit(20);
    const [invitation] = await db.select({ id: invitations.id }).from(invitations).where(and(
      eq(invitations.teacherId, actor.teacherId), eq(invitations.studentId, student.id),
      isNull(invitations.consumedAt), isNull(invitations.revokedAt),
      sql`${invitations.expiresAt} > clock_timestamp()`)).limit(1);
    return { text: `${student.firstName} ${student.lastName}\nوضعیت: ${student.disabledAt ? "غیرفعال" : "فعال"}\nحساب: ${student.userId ? "متصل" : invitation ? "دعوت صادر شده" : "بدون اتصال"}\nکلاس‌ها: ${memberships.map((row) => row.name).join("، ") || "ندارد"}\nشناسه: ${student.id}`,
      buttons: [
        ...(actor.role === "teacher" && !student.disabledAt && !student.userId && !invitation
          ? [{ label: "🔑 صدور دعوت", command: `/invite student ${student.id}` }] : []),
        ...(actor.role === "teacher" && !student.disabledAt && invitation
          ? [{ label: "🚫 لغو دعوت فعال", command: `/revokeinvite student ${student.id}` }] : []),
        ...(actor.role === "teacher" && !student.disabledAt && student.userId
          ? [{ label: "🔄 تغییر حساب", command: `/rebindrequest student ${student.id}` }] : []),
        ...(actor.role === "teacher" && !student.disabledAt
          ? [{ label: "✏️ تغییر نام", command: `/renamerequest student ${student.id}` }] : []),
        ...(actor.role === "teacher" && !student.disabledAt
          ? [{ label: "🏫 مدیریت کلاس‌ها", command: `/memberships ${student.id}` }] : []),
        ...(actor.role === "teacher" && !student.disabledAt
          ? [{ label: "🗑 غیرفعال‌سازی", command: `/deactivatestudent ${student.id}` }] : []),
        { label: "◀️ دانش‌آموزان", command: student.disabledAt ? "/students archived" : "/students" },
      ] };
  }
  if (actor.role === "teacher" && text.startsWith("/memberships ")) {
    const [studentId, pageInput] = text.slice(13).trim().split(/\s+/);
    const page = pageNumber(pageInput);
    if (!studentId || !page) return { text: "فرمت: /memberships شناسه دانش‌آموز [صفحه]" };
    const [student] = await db.select({ firstName: students.firstName, lastName: students.lastName })
      .from(students).where(and(eq(students.id, studentId), eq(students.teacherId, actor.teacherId),
        isNull(students.disabledAt))).limit(1);
    if (!student) return { text: "دانش‌آموز فعال پیدا نشد." };
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classes)
      .where(and(eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt)))
      .orderBy(asc(classes.name), asc(classes.id)).limit(8).offset((page - 1) * 8);
    const active = rows.length ? await db.select({ classId: classMemberships.classId }).from(classMemberships)
      .where(and(eq(classMemberships.studentId, studentId), isNull(classMemberships.leftAt),
        inArray(classMemberships.classId, rows.map((row) => row.id)))) : [];
    const selected = new Set(active.map((row) => row.classId));
    return { text: `کلاس‌های ${student.firstName} ${student.lastName} — صفحه ${page}\n${rows.map((row) =>
      `${selected.has(row.id) ? "✅" : "▫️"} ${row.name}`).join("\n") || "کلاسی در این صفحه نیست."}`,
      buttons: [...rows.map((row) => ({ label: `${selected.has(row.id) ? "✅ پایان" : "➕ افزودن"}: ${row.name}`.slice(0, 38),
        command: `/membershiprequest ${studentId} ${row.id} ${selected.has(row.id) ? "leave" : "join"}` })),
        ...navigation(`/memberships ${studentId}`, page, rows.length, 8)
          .filter((button) => button.command !== "/menu"),
        { label: "◀️ جزئیات دانش‌آموز", command: `/studentinfo ${studentId}` },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role === "teacher" && (text === "/assistants" || text.startsWith("/assistants "))) {
    const args = text.slice(12).trim().split(/\s+/).filter(Boolean);
    const archived = args[0] === "archived";
    const page = pageNumber(archived ? args[1] : args[0]);
    if (!page) return { text: "فرمت: /assistants [archived] [صفحه]" };
    const rows = await db.select({ id: assistants.id, displayName: assistants.displayName,
      userId: assistants.userId }).from(assistants).where(and(
      eq(assistants.teacherId, actor.teacherId),
      archived ? isNotNull(assistants.disabledAt) : isNull(assistants.disabledAt),
    )).orderBy(asc(assistants.displayName), asc(assistants.id))
      .limit(8).offset((page - 1) * 8);
    return { text: rows.length ? rows.map((row) =>
      `${row.displayName} — ${row.userId ? "متصل" : "بدون حساب"}\n${row.id}`).join("\n")
      : "دستیاری در این صفحه نیست.",
      buttons: [...rows.map((row) => ({ label: `🤝 ${row.displayName.slice(0, 30)}`,
        command: `/assistantinfo ${row.id}` })),
        ...navigation(archived ? "/assistants archived" : "/assistants", page, rows.length, 8),
        { label: archived ? "🤝 دستیاران فعال" : "🗂 دستیاران غیرفعال",
          command: archived ? "/assistants" : "/assistants archived" },
        ...(archived ? [] : [{ label: "🔎 جست‌وجو", command: "/findassistants" },
          { label: "➕ دستیار جدید", command: "/newassistant" }])] };
  }
  if (actor.role === "teacher" && text.startsWith("/assistantinfo ")) {
    const id = text.slice(15).trim();
    const [assistant] = await db.select().from(assistants)
      .where(and(eq(assistants.id, id), eq(assistants.teacherId, actor.teacherId))).limit(1);
    if (!assistant) return { text: "دستیار پیدا نشد." };
    const [invitation] = await db.select({ id: invitations.id }).from(invitations).where(and(
      eq(invitations.teacherId, actor.teacherId), eq(invitations.assistantId, assistant.id),
      isNull(invitations.consumedAt), isNull(invitations.revokedAt),
      sql`${invitations.expiresAt} > clock_timestamp()`)).limit(1);
    return { text: `${assistant.displayName}\nوضعیت: ${assistant.disabledAt ? "غیرفعال" : "فعال"}\nحساب: ${assistant.userId ? "متصل" : "بدون اتصال"}\nشناسه: ${id}`,
      buttons: [
        ...(!assistant.disabledAt && !assistant.userId && !invitation
          ? [{ label: "🔑 صدور دعوت", command: `/invite assistant ${id}` }] : []),
        ...(!assistant.disabledAt && invitation
          ? [{ label: "🚫 لغو دعوت فعال", command: `/revokeinvite assistant ${id}` }] : []),
        ...(!assistant.disabledAt && assistant.userId
          ? [{ label: "🔄 تغییر حساب", command: `/rebindrequest assistant ${id}` }] : []),
        ...(!assistant.disabledAt
          ? [{ label: "✏️ تغییر نام", command: `/renamerequest assistant ${id}` }] : []),
        ...(!assistant.disabledAt
          ? [{ label: "🗑 غیرفعال‌سازی", command: `/deactivateassistant ${id}` }] : []),
        { label: "◀️ دستیاران", command: assistant.disabledAt ? "/assistants archived" : "/assistants" },
      ] };
  }
  if (actor.role !== "student" && text.startsWith("/homeworks ")) {
    const [dateInput, classId, pageInput, filterInput] = text.slice(11).trim().split(/\s+/);
    const schoolDate = parseSchoolDateInput(dateInput ?? "");
    const page = pageNumber(pageInput);
    const filter = filterInput ?? "active";
    if (!schoolDate || !classId || !page || !["active", "deleted", "all"].includes(filter)) {
      return { text: "فرمت: /homeworks ۱۴۰۵/۰۹/۰۵ شناسه کلاس [صفحه] [active|deleted|all]" };
    }
    const previousDate = shiftSchoolDate(schoolDate, -1);
    const nextDate = shiftSchoolDate(schoolDate, 1);
    const rows = await db.select({ id: homeworks.id, versionId: homeworkVersions.id,
      title: homeworkVersions.title, firstName: students.firstName, lastName: students.lastName,
      deletedAt: homeworks.deletedAt })
      .from(homeworks).innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(students, eq(homeworks.studentId, students.id)).where(and(
        eq(homeworks.teacherId, actor.teacherId), eq(homeworks.classId, classId),
        eq(homeworks.schoolDate, schoolDate),
        filter === "active" ? isNull(homeworks.deletedAt)
          : filter === "deleted" ? isNotNull(homeworks.deletedAt) : undefined,
      )).orderBy(asc(students.lastName), asc(homeworks.createdAt), asc(homeworks.id))
      .limit(8).offset((page - 1) * 8);
    return { text: rows.length ? `تکلیف‌ها — صفحه ${page}\n${rows.map((row) =>
      `${row.firstName} ${row.lastName} — ${row.title}${row.deletedAt ? " (حذف‌شده)" : ""}\nتکلیف ${row.id}\nنسخه ${row.versionId}`).join("\n")
      }` : "تکلیفی در این صفحه نیست.",
      buttons: [...rows.map((row) => ({ label: `📚 ${row.firstName} ${row.lastName}: ${row.title}`.slice(0, 40),
        command: `/homeworkinfo ${row.id}` })),
        { label: "✅ فعال", command: `/homeworks ${schoolDate} ${classId} 1 active` },
        { label: "🗑 حذف‌شده", command: `/homeworks ${schoolDate} ${classId} 1 deleted` },
        { label: "👥 همه", command: `/homeworks ${schoolDate} ${classId} 1 all` },
        ...(page > 1 ? [{ label: "◀️ قبلی", command: `/homeworks ${schoolDate} ${classId} ${page - 1} ${filter}` }] : []),
        ...(rows.length === 8 ? [{ label: "بعدی ▶️", command: `/homeworks ${schoolDate} ${classId} ${page + 1} ${filter}` }] : []),
        { label: "⬅️ روز قبل", command: `/homeworks ${previousDate} ${classId} 1 ${filter}` },
        { label: "روز بعد ➡️", command: `/homeworks ${nextDate} ${classId} 1 ${filter}` },
        { label: "📅 تاریخ دیگر", command: `/homeworkdate ${classId}` },
        { label: "◀️ جزئیات کلاس", command: `/classinfo ${classId}` },
        { label: "🏠 منوی اصلی", command: "/menu" },
      ] };
  }
  if (text === "/feedbacks" || text.startsWith("/feedbacks ")) {
    const args = text.slice(10).trim().split(/\s+/).filter(Boolean);
    const homeworkId = actor.role === "student" || args[0] === "all" ? undefined : args[0];
    const page = pageNumber(actor.role === "student" ? args[0] : args[1]);
    if (!page) return { text: actor.role === "student"
      ? "فرمت: /feedbacks [صفحه]" : "فرمت: /feedbacks [شناسه تکلیف] [صفحه]" };
    const rows = await db.select({ id: feedbacks.id, createdAt: feedbacks.createdAt,
      body: feedbacks.body, kind: feedbacks.kind, authorDisplayName: feedbacks.authorDisplayName,
      authorRole: feedbacks.authorRole, homeworkId: feedbacks.homeworkId,
      title: homeworkVersions.title, className: classes.name })
      .from(feedbacks).innerJoin(homeworks, eq(feedbacks.homeworkId, homeworks.id))
      .innerJoin(homeworkVersions, eq(feedbacks.versionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id))
      .where(and(eq(feedbacks.teacherId, actor.teacherId),
        actor.role === "student" ? eq(homeworks.studentId, actor.studentId) : undefined,
        homeworkId ? eq(feedbacks.homeworkId, homeworkId) : undefined))
      .orderBy(desc(feedbacks.createdAt), desc(feedbacks.id)).limit(8).offset((page - 1) * 8);
    if (!rows.length) return { text: "بازخوردی در این صفحه نیست." };
    const deliveries = await db.select({ feedbackId: outboxMessages.feedbackId,
      kind: outboxMessages.kind, status: outboxMessages.status })
      .from(outboxMessages).where(inArray(outboxMessages.feedbackId, rows.map((row) => row.id)));
    const lines = rows.map((row) => {
      const status = deliveries.filter((delivery) => delivery.feedbackId === row.id)
        .map((delivery) => `${delivery.kind === "feedback_voice" ? "صوت" : "متن"}: ${delivery.status}`).join("، ");
      const body = row.body ? `\n${row.body.slice(0, 180)}${row.body.length > 180 ? "…" : ""}` : "\nپیام صوتی";
      return `${row.className} — ${row.title}\n${row.authorRole === "teacher" ? "معلم" : "دستیار"} ${row.authorDisplayName} — ${persianTimestamp.format(row.createdAt)}${body}\n${status}\nشناسه: ${row.id}`;
    });
    const base = actor.role === "student" ? "/feedbacks" : `/feedbacks ${homeworkId ?? "all"}`;
    return { text: `بازخوردها — صفحه ${page}\n${lines.join("\n\n")}`,
      buttons: [...rows.filter((row) => row.kind === "voice")
        .map((row) => ({ label: `🎙 ${row.title.slice(0, 26)}`, command: `/feedbackfile ${row.id}` })),
        ...navigation(base, page, rows.length, 8).filter((button) => button.command !== "/menu"),
        ...(homeworkId ? [{ label: "◀️ بازگشت به تکلیف", command: `/homeworkinfo ${homeworkId}` }] : []),
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (text.startsWith("/feedbackfile ")) {
    const feedbackId = text.slice(14).trim();
    const [feedback] = await db.select({ id: feedbacks.id, assetId: feedbacks.voiceAssetId,
      studentId: homeworks.studentId }).from(feedbacks)
      .innerJoin(homeworks, eq(feedbacks.homeworkId, homeworks.id))
      .where(and(eq(feedbacks.id, feedbackId), eq(feedbacks.teacherId, actor.teacherId),
        actor.role === "student" ? eq(homeworks.studentId, actor.studentId) : undefined))
      .limit(1);
    if (!feedback?.assetId) return { text: "بازخورد صوتی پیدا نشد." };
    const [voiceAsset] = await db.select({ status: fileAssets.status }).from(fileAssets)
      .where(and(eq(fileAssets.id, feedback.assetId), eq(fileAssets.teacherId, actor.teacherId))).limit(1);
    if (voiceAsset?.status !== "ready") return { text: "فایل صوتی طبق سیاست نگهداری دیگر در دسترس نیست." };
    await db.insert(outboxMessages).values({ teacherId: actor.teacherId,
      ...(actor.role === "student" ? { targetStudentId: actor.studentId } : { recipientUserId: actor.userId }),
      feedbackId: feedback.id, kind: "feedback_voice",
      idempotencyKey: `feedbackfile:${input.operationId}`,
      payload: { assetId: feedback.assetId },
    }).onConflictDoNothing();
    return { text: "بازخورد صوتی برای ارسال در صف قرار گرفت." };
  }
  if (actor.role !== "student" && text.startsWith("/feedbackstart ")) {
    if (session.state !== "IDLE") return { text: "ابتدا عملیات فعلی را کامل یا لغو کنید." };
    const [homeworkId, versionId] = text.slice(15).trim().split(/\s+/);
    if (!homeworkId || !versionId) return { text: "فرمت: /feedbackstart شناسه تکلیف شناسه نسخه" };
    const [version] = await db.select({ title: homeworkVersions.title }).from(homeworkVersions)
      .innerJoin(homeworks, eq(homeworkVersions.homeworkId, homeworks.id))
      .where(and(eq(homeworkVersions.id, versionId), eq(homeworkVersions.homeworkId, homeworkId),
        eq(homeworks.teacherId, actor.teacherId))).limit(1);
    if (!version) return { text: "نسخهٔ تکلیف پیدا نشد." };
    await db.update(botSessions).set({ state: "FEEDBACK_INPUT", context: { homeworkId, versionId },
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: `متن بازخورد برای «${version.title}» را بفرستید.`,
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && session.state === "FEEDBACK_INPUT") {
    if (!text || text.startsWith("/")) return { text: "متن بازخورد را بفرستید یا /cancel را انتخاب کنید." };
    const context = session.context as Record<string, unknown>;
    if (typeof context.homeworkId !== "string" || typeof context.versionId !== "string") {
      throw new Error("Invalid feedback input session");
    }
    text = `/feedback ${context.homeworkId} ${context.versionId} ${text}`;
  }
  if (actor.role !== "student" && text === "/confirmfeedback" && session.state === "FEEDBACK_CONFIRM") {
    const context = session.context;
    if (typeof context !== "object" || context === null || Array.isArray(context)) throw new Error("Invalid feedback session");
    const { homeworkId, versionId, body, assetId, operationId } = context as Record<string, unknown>;
    if (typeof homeworkId !== "string" || typeof versionId !== "string" || typeof operationId !== "string") {
      throw new Error("Invalid feedback session");
    }
    const content = typeof body === "string" ? { kind: "text" as const, body }
      : typeof assetId === "string" ? { kind: "voice" as const, assetId } : null;
    if (!content) throw new Error("Invalid feedback session");
    await recordFeedback(db, actor, { homeworkId, versionId, operationId, content });
    await db.update(botSessions).set({ state: "IDLE", context: {},
      revision: sql`${botSessions.revision} + 1` }).where(eq(botSessions.id, session.id));
    return { text: "بازخورد ثبت شد و برای ارسال در صف قرار گرفت.",
      buttons: [{ label: "📚 بازگشت به تکلیف", command: `/homeworkinfo ${homeworkId}` },
        { label: "🏠 منوی اصلی", command: "/menu" }] };
  }
  if (actor.role !== "student" && session.state === "FEEDBACK_CONFIRM") {
    return { text: "بازخورد آماده است. برای ارسال /confirmfeedback و برای لغو /cancel را بفرستید." };
  }
  if (actor.role !== "student" && text.startsWith("/feedback ")) {
    const [homeworkId, versionId, ...words] = text.slice(10).split(" ");
    const body = words.join(" ").trim();
    if (!homeworkId || !versionId || !body) {
      return { text: "فرمت: /feedback شناسه تکلیف شناسه نسخه متن بازخورد" };
    }
    if (body.length > 4096) return { text: "متن بازخورد بیش از حد طولانی است." };
    const [target] = await db.select({ title: homeworkVersions.title, className: classes.name,
      firstName: students.firstName, lastName: students.lastName }).from(homeworkVersions)
      .innerJoin(homeworks, eq(homeworkVersions.homeworkId, homeworks.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id))
      .innerJoin(students, eq(homeworks.studentId, students.id))
      .where(and(eq(homeworkVersions.id, versionId), eq(homeworkVersions.homeworkId, homeworkId),
        eq(homeworks.teacherId, actor.teacherId))).limit(1);
    if (!target) return { text: "نسخهٔ تکلیف پیدا نشد." };
    await db.update(botSessions).set({ state: "FEEDBACK_CONFIRM",
      context: { homeworkId, versionId, body, operationId: input.operationId },
      revision: sql`${botSessions.revision} + 1`,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).where(eq(botSessions.id, session.id));
    return { text: `بازخورد برای ${target.firstName} ${target.lastName}\n${target.className} — ${target.title}\nنسخه: ${versionId}\nمتن: ${body.slice(0, 300)}${body.length > 300 ? "…" : ""}\nبرای ارسال /confirmfeedback و برای لغو /cancel را بفرستید.`,
      buttons: [{ label: "✅ ارسال بازخورد", command: "/confirmfeedback", style: "success" },
        { label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && text.startsWith("/voicefeedback ")) {
    const [homeworkId, versionId] = text.slice(15).split(" ");
    if (!homeworkId || !versionId) {
      return { text: "فرمت: /voicefeedback شناسه تکلیف شناسه نسخه" };
    }
    const [version] = await db.select({ id: homeworkVersions.id }).from(homeworkVersions)
      .innerJoin(homeworks, eq(homeworkVersions.homeworkId, homeworks.id))
      .where(and(eq(homeworkVersions.id, versionId), eq(homeworkVersions.homeworkId, homeworkId),
        eq(homeworks.teacherId, actor.teacherId))).limit(1);
    if (!version) return { text: "نسخهٔ تکلیف پیدا نشد." };
    await db.update(botSessions).set({ state: "FEEDBACK_VOICE", context: { homeworkId, versionId },
      revision: sql`${botSessions.revision} + 1`, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      .where(eq(botSessions.id, session.id));
    return { text: "پیام صوتی را بفرستید؛ با /cancel می‌توانید لغو کنید.",
      buttons: [{ label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && session.state === "FEEDBACK_VOICE" && message.media?.kind === "voice") {
    const context = session.context;
    if (typeof context !== "object" || context === null || Array.isArray(context)) throw new Error("Invalid feedback session");
    const { homeworkId, versionId } = context as Record<string, unknown>;
    if (typeof homeworkId !== "string" || typeof versionId !== "string") throw new Error("Invalid feedback session");
    const stream = await input.bale.downloadFile(message.media.fileId);
    const stored = await input.storage.store(actor.teacherId, stream);
    const [asset] = await db.insert(fileAssets).values({ teacherId: actor.teacherId,
      kind: "voice", mimeType: "audio/ogg", sizeBytes: stored.sizeBytes,
      providerFileId: message.media.fileId, storageKey: stored.storageKey,
      status: "ready", checksum: stored.sha256, createdByUserId: actor.userId,
    }).returning({ id: fileAssets.id });
    if (!asset) throw new Error("Voice file record unavailable");
    await db.update(botSessions).set({ state: "FEEDBACK_CONFIRM",
      context: { homeworkId, versionId, assetId: asset.id, operationId: input.operationId },
      revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: "بازخورد صوتی آماده است. برای ارسال /confirmfeedback و برای لغو /cancel را بفرستید.",
      buttons: [{ label: "✅ ارسال بازخورد", command: "/confirmfeedback", style: "success" },
        { label: "❌ لغو", command: "/cancel" }] };
  }
  if (actor.role !== "student" && text.startsWith("/report ")) {
    const [dateInput, pageInput, filterInput] = text.slice(8).trim().split(/\s+/);
    const date = parseSchoolDateInput(dateInput ?? "");
    const page = pageNumber(pageInput);
    const filter = filterInput ?? "all";
    if (!date || !page || !["all", "submitted", "missing"].includes(filter)) {
      return { text: "فرمت: /report ۱۴۰۵/۰۹/۰۵ [صفحه] [all|submitted|missing]" };
    }
    const final = await readDailyReport(db, actor, date);
    const provisional = final ? null : await readProvisionalDailyReport(db, actor, date);
    if (!final && !provisional) return { text: "گزارش این روز در دسترس نیست." };
    const summaries = final ? final.report.classSummaries : provisional?.classSummaries;
    if (!Array.isArray(summaries)) throw new Error("Invalid report summary");
    const lines = summaries.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid report summary");
      const summary = value as Record<string, unknown>;
      const submitted = Number(summary.submitted);
      const missing = Number(summary.missing);
      const percent = submitted + missing ? `${((submitted / (submitted + missing)) * 100).toFixed(1)}٪` : "بدون داده";
      return `${String(summary.name)}: تحویل‌داده ${submitted}، تحویل‌نداده ${missing} (${percent})`;
    });
    const displayDate = formatPersianSchoolDate(getTehranHourInstant(date, 14));
    const previousDate = shiftSchoolDate(date, -1);
    const nextDate = shiftSchoolDate(date, 1);
    const allEntries = (final?.entries ?? provisional?.entries ?? []).filter((entry) =>
      filter === "all" || entry.submitted === (filter === "submitted"));
    const entries = allEntries.slice((page - 1) * 8, page * 8).map((entry) =>
      `${entry.classNameSnapshot}: ${entry.studentNameSnapshot} — ${entry.submitted ? "تحویل داده" : "تحویل نداده"}`);
    return { text: `گزارش ${final ? "نهایی" : "موقت"} ${displayDate}\n${lines.join("\n")}\nصفحه ${page}\n${entries.join("\n") || "موردی در این صفحه نیست."}`.slice(0, 4000),
      buttons: [{ label: "✅ تحویل‌داده‌ها", command: `/report ${date} 1 submitted` },
        { label: "❌ تحویل‌نداده‌ها", command: `/report ${date} 1 missing` },
        { label: "👥 همه", command: `/report ${date} 1 all` },
        ...(page > 1 ? [{ label: "◀️ قبلی", command: `/report ${date} ${page - 1} ${filter}` }] : []),
        ...(allEntries.length > page * 8 ? [{ label: "بعدی ▶️", command: `/report ${date} ${page + 1} ${filter}` }] : []),
        { label: "⬅️ روز قبل", command: `/report ${previousDate}` },
        { label: "روز بعد ➡️", command: `/report ${nextDate}` },
        { label: "📅 تاریخ دیگر", command: "/reportdate daily" },
        { label: "📊 گزارش‌ها", command: "/reports" }] };
  }
  if (actor.role !== "student" && (text.startsWith("/week ") || text.startsWith("/month "))) {
    const period = text.startsWith("/week ") ? "week" : "month";
    const [dateInput, pageInput] = text.slice(period === "week" ? 6 : 7).trim().split(/\s+/);
    const date = parseSchoolDateInput(dateInput ?? "");
    const page = pageNumber(pageInput);
    if (!date || !page) return { text: "فرمت: /week ۱۴۰۵/۰۹/۰۵ [صفحه] یا /month ۱۴۰۵/۰۹/۰۵ [صفحه]" };
    const reference = getTehranHourInstant(date, 14);
    const result = await readPeriodReport(db, actor, reference, period);
    const previousReference = shiftPeriodReference(date, period, -1);
    const nextReference = shiftPeriodReference(date, period, 1);
    const lastDate = new Date(Date.parse(`${result.endExclusive}T00:00:00.000Z`) - 86_400_000)
      .toISOString().slice(0, 10);
    const today = getTehranTime(new Date()).schoolDate;
    const provisional = today >= result.start && today < result.endExclusive
      ? await readProvisionalDailyReport(db, actor, today) : null;
    const provisionalText = provisional ? `\nامروز (موقت): ${provisional.classSummaries.map((item) =>
      `${item.name} ${item.submitted}/${item.submitted + item.missing}`).join("، ")}` : "";
    return { text: result.rows.length || provisional
      ? `از ${formatPersianSchoolDate(getTehranHourInstant(result.start, 14))} تا ${formatPersianSchoolDate(getTehranHourInstant(lastDate, 14))} — روزهای نهایی‌شده، صفحه ${page}\n${result.rows.slice((page - 1) * 20, page * 20).map((row) => {
      const submitted = Number(row.submitted_days);
      const eligible = Number(row.eligible_days);
      const percent = eligible ? `${((submitted / eligible) * 100).toFixed(1)}٪` : "بدون داده";
      return `${row.student_name} — ${row.class_name}: ${submitted}/${eligible} (${percent})`;
    }).join("\n") || "دادهٔ نهایی در این صفحه نیست."}${provisionalText}`
      : "دادهٔ نهایی برای این بازه موجود نیست.",
      buttons: [
        ...(page > 1 ? [{ label: "◀️ قبلی", command: `/${period} ${date} ${page - 1}` }] : []),
        ...(result.rows.length > page * 20 ? [{ label: "بعدی ▶️", command: `/${period} ${date} ${page + 1}` }] : []),
        { label: period === "week" ? "⬅️ هفتهٔ قبل" : "⬅️ ماه قبل",
          command: `/${period} ${previousReference}` },
        { label: period === "week" ? "هفتهٔ بعد ➡️" : "ماه بعد ➡️",
          command: `/${period} ${nextReference}` },
        { label: "📅 انتخاب تاریخ", command: `/reportdate ${period}` },
        ...(provisional ? [{ label: "📊 گزارش موقت امروز", command: `/report ${today}` }] : []),
        { label: "📊 گزارش‌ها", command: "/reports" },
      ] };
  }
  if (actor.role === "teacher") {
    return { text: "دستورها: /class، /student، /assistant، /invite، /rebind، /revokeinvite، /classes، /students، /assistants، /homeworks، /versions، /files، /feedback، /voicefeedback، /feedbacks، /report، /week، /month" };
  }
  if (actor.role === "student") {
    return { text: "دستورها: /classes، /submit، /title عنوان، ارسال فایل، /finalize، /today، /history، /edit شناسه، /files شناسه، /feedbacks، /feedbackfile شناسه، /cancel" };
  }
  return { text: "دستورها: /classes، /students، /homeworks، /versions، /files، /feedback، /voicefeedback، /feedbacks، /report، /week، /month" };
}
