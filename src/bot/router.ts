import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { BaleClient, BaleMessage } from "./bale/client.ts";
import type { Database } from "../database/client.ts";
import {
  assistants, botSessions, classes, classMemberships, draftFiles, feedbacks, fileAssets,
  homeworkDrafts, homeworks, homeworkVersionFiles, homeworkVersions, students,
} from "../database/schema.ts";
import type { Actor } from "../modules/auth/service.ts";
import { issueInvitation } from "../modules/invitations/service.ts";
import {
  changeMembership, createAssistant, createClass, createStudent,
  deactivateAssistant, deactivateClass, deactivateStudent, disconnectStudent,
} from "../modules/roster/service.ts";
import { deleteHomework, saveHomework } from "../modules/homeworks/service.ts";
import { recordFeedback } from "../modules/feedbacks/service.ts";
import { readDailyReport, readPeriodReport } from "../modules/reports/service.ts";
import { formatPersianSchoolDate, getTehranHourInstant, getTehranTime, isHomeworkWindowOpen } from "../shared/calendar.ts";
import type { PrivateFileStorage } from "../storage/private.ts";

export type RouterReply = { text: string; direct?: boolean };

type RouterContext = { db: Database; bale: BaleClient; storage: PrivateFileStorage;
  actor: Actor; userId: string; message: BaleMessage; inviteCodeSecret: string; operationId: string };

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
    await tx.update(botSessions).set({ state: "HOMEWORK_FILES", context: { draftId: draft.id },
      revision: sql`${botSessions.revision} + 1`, expiresAt: getTehranHourInstant(schoolDate, 22),
    }).where(eq(botSessions.id, existingSession.id));
    return homeworkId
      ? "ویرایش آغاز شد. فایل بفرستید، /remove شماره برای حذف فایل، /title عنوان جدید و /finalize برای ذخیره."
      : "پیش‌نویس ساخته شد. با /title عنوان را ثبت کنید، فایل بفرستید و با /finalize ذخیره کنید.";
  });
}

export async function handleAuthorizedMessage(input: RouterContext): Promise<RouterReply> {
  const { db, actor, message } = input;
  const text = message.text?.trim() ?? "";
  const session = await sessionFor(db, actor);
  const draft = await activeDraft(db, actor, session.context);

  if (text === "/cancel") {
    if (draft) await db.update(homeworkDrafts).set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(homeworkDrafts.id, draft.id));
    await db.update(botSessions).set({ state: "IDLE", context: {}, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: "عملیات لغو شد." };
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
  if (actor.role === "teacher" && text.startsWith("/invite ")) {
    const [kind, id] = text.slice(8).split(" ");
    if ((kind !== "student" && kind !== "assistant") || !id) {
      return { text: "فرمت: /invite student شناسه یا /invite assistant شناسه" };
    }
    const code = await issueInvitation(db, actor, { kind, id }, input.inviteCodeSecret);
    return { text: `کد دعوت شخصی: ${code}\nاین کد فقط یک‌بار معتبر است.`, direct: true };
  }
  if (actor.role === "teacher" && (text.startsWith("/join ") || text.startsWith("/leave "))) {
    const active = text.startsWith("/join ");
    const [studentId, classId] = text.slice(active ? 6 : 7).split(" ");
    if (!studentId || !classId) return { text: "فرمت: /join شناسه دانش‌آموز شناسه کلاس یا /leave ..." };
    await changeMembership(db, actor, studentId, classId, active);
    return { text: active ? "عضویت کلاس فعال شد." : "عضویت کلاس پایان یافت." };
  }
  if (actor.role === "teacher" && text.startsWith("/disconnect ")) {
    await disconnectStudent(db, actor, text.slice(12).trim());
    return { text: "اتصال حساب دانش‌آموز قطع شد. برای حساب جدید کد دعوت صادر کنید." };
  }
  if (actor.role === "teacher" && text.startsWith("/deactivatestudent ")) {
    await deactivateStudent(db, actor, text.slice(19).trim());
    return { text: "پروندهٔ دانش‌آموز غیرفعال شد؛ تاریخچه باقی می‌ماند." };
  }
  if (actor.role === "teacher" && text.startsWith("/deactivateclass ")) {
    await deactivateClass(db, actor, text.slice(17).trim());
    return { text: "کلاس غیرفعال شد؛ تاریخچه باقی می‌ماند." };
  }
  if (actor.role === "teacher" && text.startsWith("/deactivateassistant ")) {
    await deactivateAssistant(db, actor, text.slice(21).trim());
    return { text: "دسترسی دستیار غیرفعال شد." };
  }

  if (actor.role === "student" && text.startsWith("/submit ")) {
    return { text: await beginDraft(db, actor, text.slice(8).trim()) };
  }
  if (actor.role === "student" && text.startsWith("/edit ")) {
    const homeworkId = text.slice(6).trim();
    const [homework] = await db.select({ classId: homeworks.classId }).from(homeworks).where(and(
      eq(homeworks.id, homeworkId), eq(homeworks.teacherId, actor.teacherId),
      eq(homeworks.studentId, actor.studentId), isNull(homeworks.deletedAt),
    )).limit(1);
    return { text: homework ? await beginDraft(db, actor, homework.classId, homeworkId) : "تکلیف پیدا نشد." };
  }
  if (actor.role === "student" && draft && text.startsWith("/title ")) {
    const title = text.slice(7).trim();
    if (!title || title.length > 120) return { text: "عنوان باید بین ۱ تا ۱۲۰ نویسه باشد." };
    await db.update(homeworkDrafts).set({ title, updatedAt: new Date() }).where(eq(homeworkDrafts.id, draft.id));
    return { text: "عنوان پیش‌نویس ثبت شد." };
  }
  if (actor.role === "student" && draft && text.startsWith("/remove ")) {
    const position = Number(text.slice(8));
    if (!Number.isSafeInteger(position) || position < 1) return { text: "شمارهٔ فایل نامعتبر است." };
    await db.delete(draftFiles).where(and(eq(draftFiles.draftId, draft.id), eq(draftFiles.position, position)));
    return { text: "فایل از پیش‌نویس حذف شد. نسخهٔ قبلی تغییر نکرده است." };
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
    return { text: `تکلیف ذخیره شد. شناسه: ${homeworkId}` };
  }
  if (actor.role === "student" && draft && message.media) {
    if (draft.expiresAt <= new Date()) return { text: "بازهٔ ثبت تکلیف بسته است." };
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
    return { text: "فایل به پیش‌نویس اضافه شد. برای ثبت نهایی /finalize را بفرستید." };
  }

  if (actor.role === "student" && text === "/classes") {
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classMemberships)
      .innerJoin(classes, eq(classMemberships.classId, classes.id)).where(and(
        eq(classMemberships.studentId, actor.studentId), isNull(classMemberships.leftAt),
        isNull(classes.disabledAt),
      ));
    return { text: rows.length ? rows.map((row) => `${row.name}: ${row.id}`).join("\n") : "کلاس فعالی ندارید." };
  }
  if (actor.role === "student" && text === "/today") {
    const schoolDate = getTehranTime(new Date()).schoolDate;
    const rows = await db.select({ id: homeworks.id, versionId: homeworkVersions.id, title: homeworkVersions.title,
      className: classes.name }).from(homeworks)
      .innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id)).where(and(
        eq(homeworks.studentId, actor.studentId), eq(homeworks.teacherId, actor.teacherId),
        eq(homeworks.schoolDate, schoolDate), isNull(homeworks.deletedAt),
      ));
    return { text: rows.length ? rows.map((row) =>
      `${row.className} — ${row.title}\nتکلیف ${row.id}\nنسخه ${row.versionId}`).join("\n")
      : "امروز تکلیفی ثبت نشده است." };
  }
  if (actor.role === "student" && text === "/history") {
    const rows = await db.select({ id: homeworks.id, title: homeworkVersions.title,
      schoolDate: homeworks.schoolDate, className: classes.name }).from(homeworks)
      .innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(classes, eq(homeworks.classId, classes.id)).where(and(
        eq(homeworks.studentId, actor.studentId), eq(homeworks.teacherId, actor.teacherId),
        isNull(homeworks.deletedAt),
      )).orderBy(desc(homeworks.schoolDate), desc(homeworks.createdAt)).limit(20);
    return { text: rows.length ? rows.map((row) =>
      `${row.schoolDate} — ${row.className} — ${row.title}\n${row.id}`).join("\n") : "تکلیفی در تاریخچه نیست." };
  }
  if (actor.role === "student" && text.startsWith("/delete ")) {
    const [homeworkId, versionId] = text.slice(8).split(" ");
    if (!homeworkId || !versionId) return { text: "فرمت: /delete شناسه تکلیف شناسه نسخه" };
    await deleteHomework(db, actor, homeworkId, versionId, input.operationId);
    return { text: "تکلیف حذف شد؛ تاریخچه برای معلم حفظ می‌شود." };
  }
  if (actor.role !== "student" && text === "/classes") {
    const rows = await db.select({ id: classes.id, name: classes.name }).from(classes)
      .where(and(eq(classes.teacherId, actor.teacherId), isNull(classes.disabledAt)))
      .orderBy(asc(classes.name)).limit(20);
    return { text: rows.length ? rows.map((row) => `${row.name}: ${row.id}`).join("\n") : "کلاسی ثبت نشده است." };
  }
  if (actor.role !== "student" && text === "/students") {
    const rows = await db.select({ id: students.id, firstName: students.firstName,
      lastName: students.lastName }).from(students).where(and(
      eq(students.teacherId, actor.teacherId), isNull(students.disabledAt),
    )).orderBy(asc(students.lastName), asc(students.firstName)).limit(20);
    return { text: rows.length ? rows.map((row) =>
      `${row.firstName} ${row.lastName}: ${row.id}`).join("\n") : "دانش‌آموزی ثبت نشده است." };
  }
  if (actor.role !== "student" && text.startsWith("/homeworks ")) {
    const [schoolDate, classId] = text.slice(11).split(" ");
    if (!schoolDate || !classId || !/^\d{4}-\d{2}-\d{2}$/.test(schoolDate)) {
      return { text: "فرمت: /homeworks YYYY-MM-DD شناسه کلاس" };
    }
    const rows = await db.select({ id: homeworks.id, versionId: homeworkVersions.id,
      title: homeworkVersions.title, firstName: students.firstName, lastName: students.lastName })
      .from(homeworks).innerJoin(homeworkVersions, eq(homeworks.currentVersionId, homeworkVersions.id))
      .innerJoin(students, eq(homeworks.studentId, students.id)).where(and(
        eq(homeworks.teacherId, actor.teacherId), eq(homeworks.classId, classId),
        eq(homeworks.schoolDate, schoolDate), isNull(homeworks.deletedAt),
      )).orderBy(asc(students.lastName), asc(homeworks.createdAt)).limit(20);
    return { text: rows.length ? rows.map((row) =>
      `${row.firstName} ${row.lastName} — ${row.title}\nتکلیف ${row.id}\nنسخه ${row.versionId}`).join("\n")
      : "تکلیفی برای این کلاس و روز نیست." };
  }
  if (actor.role !== "student" && text.startsWith("/feedback ")) {
    const [homeworkId, versionId, ...words] = text.slice(10).split(" ");
    const body = words.join(" ").trim();
    if (!homeworkId || !versionId || !body) {
      return { text: "فرمت: /feedback شناسه تکلیف شناسه نسخه متن بازخورد" };
    }
    await recordFeedback(db, actor, { homeworkId, versionId,
      operationId: input.operationId, content: { kind: "text", body } });
    return { text: "بازخورد ثبت شد و برای ارسال در صف قرار گرفت." };
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
    return { text: "پیام صوتی را بفرستید؛ با /cancel می‌توانید لغو کنید." };
  }
  if (actor.role !== "student" && session.state === "FEEDBACK_VOICE" && message.media?.kind === "voice") {
    const context = session.context;
    if (typeof context !== "object" || context === null || Array.isArray(context)) throw new Error("Invalid feedback session");
    const { homeworkId, versionId } = context as Record<string, unknown>;
    if (typeof homeworkId !== "string" || typeof versionId !== "string") throw new Error("Invalid feedback session");
    const [previous] = await db.select({ id: feedbacks.id }).from(feedbacks)
      .where(eq(feedbacks.operationId, input.operationId)).limit(1);
    if (!previous) {
      const stream = await input.bale.downloadFile(message.media.fileId);
      const stored = await input.storage.store(actor.teacherId, stream);
      const [asset] = await db.insert(fileAssets).values({ teacherId: actor.teacherId,
        kind: "voice", mimeType: "audio/ogg", sizeBytes: stored.sizeBytes,
        providerFileId: message.media.fileId, storageKey: stored.storageKey,
        status: "ready", checksum: stored.sha256, createdByUserId: actor.userId,
      }).returning({ id: fileAssets.id });
      if (!asset) throw new Error("Voice file record unavailable");
      await recordFeedback(db, actor, { homeworkId, versionId,
        operationId: input.operationId, content: { kind: "voice", assetId: asset.id } });
    }
    await db.update(botSessions).set({ state: "IDLE", context: {}, revision: sql`${botSessions.revision} + 1` })
      .where(eq(botSessions.id, session.id));
    return { text: "بازخورد صوتی ثبت شد و برای ارسال در صف قرار گرفت." };
  }
  if (actor.role !== "student" && text.startsWith("/report ")) {
    const date = text.slice(8).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { text: "فرمت: /report YYYY-MM-DD" };
    const result = await readDailyReport(db, actor, date);
    if (!result) return { text: "گزارش این روز هنوز نهایی نشده است." };
    const summaries = result.report.classSummaries;
    if (!Array.isArray(summaries)) throw new Error("Invalid report summary");
    const lines = summaries.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid report summary");
      const summary = value as Record<string, unknown>;
      return `${String(summary.name)}: تحویل‌داده ${String(summary.submitted)}، تحویل‌نداده ${String(summary.missing)}`;
    });
    const displayDate = formatPersianSchoolDate(getTehranHourInstant(date, 14));
    return { text: `گزارش ${displayDate}\n${lines.join("\n")}` };
  }
  if (actor.role !== "student" && (text.startsWith("/week ") || text.startsWith("/month "))) {
    const period = text.startsWith("/week ") ? "week" : "month";
    const date = text.slice(period === "week" ? 6 : 7).trim();
    const reference = new Date(`${date}T12:00:00.000Z`);
    if (Number.isNaN(reference.getTime())) return { text: "فرمت: /week YYYY-MM-DD یا /month YYYY-MM-DD" };
    const result = await readPeriodReport(db, actor, reference, period);
    return { text: result.rows.length ? `از ${result.start} تا ${result.endExclusive}\n${result.rows.map((row) =>
      `${row.student_name} — ${row.class_name}: ${row.submitted_days}/${row.eligible_days}`).join("\n")}`
      : "دادهٔ نهایی برای این بازه موجود نیست." };
  }
  if (actor.role === "teacher" && text.startsWith("/delete ")) {
    const [homeworkId, versionId] = text.slice(8).split(" ");
    if (!homeworkId || !versionId) return { text: "فرمت: /delete شناسه تکلیف شناسه نسخه" };
    await deleteHomework(db, actor, homeworkId, versionId, input.operationId);
    return { text: "تکلیف حذف شد؛ تاریخچه محفوظ است." };
  }
  if (actor.role === "teacher") {
    return { text: "دستورها: /class، /student، /assistant، /invite، /classes، /students، /homeworks، /feedback، /report، /week، /month" };
  }
  if (actor.role === "student") {
    return { text: "دستورها: /classes، /submit شناسه کلاس، /title عنوان، ارسال فایل، /finalize، /today، /history، /edit شناسه، /cancel" };
  }
  return { text: "دستورها: /classes، /students، /homeworks، /feedback، /report، /week، /month" };
}
