import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import {
  assistants, classes, dailyReportEntries, dailyReports, outboxMessages,
  teachers, users,
} from "../../database/schema.ts";
import { getPeriodBounds, getTehranHourInstant, getTehranTime } from "../../shared/calendar.ts";
import { authoritativeTime } from "../homeworks/service.ts";
import type { Actor } from "../auth/service.ts";

type ReportRow = {
  class_id: string;
  student_id: string;
  class_name: string;
  first_name: string;
  last_name: string;
  active_count: string | number;
  had_deleted: boolean;
};

export async function closeSchoolDay(db: Database, teacherId: string, schoolDate: string): Promise<string> {
  const windowStart = getTehranHourInstant(schoolDate, 14);
  const windowEnd = getTehranHourInstant(schoolDate, 22);
  return db.transaction(async (tx) => {
    const ownerLock = await tx.execute(sql`SELECT id FROM teachers WHERE id = ${teacherId} AND disabled_at IS NULL FOR UPDATE`);
    if (ownerLock.length !== 1) throw new Error("Teacher unavailable");
    const [teacher] = await tx.select().from(teachers).where(eq(teachers.id, teacherId)).limit(1);
    if (!teacher || teacher.createdAt >= windowEnd) throw new Error("Day predates teacher activation");
    if (await authoritativeTime(tx) < windowEnd) throw new Error("School day is still open");
    const [existing] = await tx.select({ id: dailyReports.id }).from(dailyReports)
      .where(and(eq(dailyReports.teacherId, teacherId), eq(dailyReports.schoolDate, schoolDate))).limit(1);
    if (existing) return existing.id;

    const rawRows = await tx.execute(sql`
      WITH valid_homeworks AS (
        SELECT h.id, h.class_id, h.student_id, latest.kind
        FROM homeworks h
        JOIN LATERAL (
          SELECT v.kind FROM homework_versions v
          WHERE v.homework_id = h.id AND v.created_at < ${windowEnd.toISOString()}::timestamptz
          ORDER BY v.version_no DESC LIMIT 1
        ) latest ON true
        WHERE h.teacher_id = ${teacherId} AND h.school_date = ${schoolDate}::date
      ), eligible AS (
        SELECT m.class_id, m.student_id FROM class_memberships m
        WHERE m.teacher_id = ${teacherId} AND m.joined_at < ${windowEnd.toISOString()}::timestamptz
          AND (m.left_at IS NULL OR m.left_at > ${windowStart.toISOString()}::timestamptz)
        UNION
        SELECT h.class_id, h.student_id FROM valid_homeworks h WHERE h.kind <> 'deleted'
      )
      SELECT e.class_id, e.student_id, c.name AS class_name,
        s.first_name, s.last_name,
        count(h.id) FILTER (WHERE h.kind <> 'deleted')::integer AS active_count,
        (count(h.id) FILTER (WHERE h.kind = 'deleted') > 0) AS had_deleted
      FROM eligible e
      JOIN classes c ON c.id = e.class_id AND c.teacher_id = ${teacherId}
      JOIN students s ON s.id = e.student_id AND s.teacher_id = ${teacherId}
      LEFT JOIN valid_homeworks h ON h.class_id = e.class_id AND h.student_id = e.student_id
      GROUP BY e.class_id, e.student_id, c.name, s.first_name, s.last_name
      ORDER BY c.name, s.last_name, s.first_name, e.student_id
    `);
    const rows = rawRows as unknown as ReportRow[];
    const allClasses = await tx.select({ id: classes.id, name: classes.name }).from(classes)
      .where(and(eq(classes.teacherId, teacherId), sql`${classes.createdAt} < ${windowEnd.toISOString()}::timestamptz`));
    const summaries = allClasses.map((schoolClass) => {
      const entries = rows.filter((row) => row.class_id === schoolClass.id);
      return { classId: schoolClass.id, name: schoolClass.name,
        submitted: entries.filter((row) => Number(row.active_count) > 0).length,
        missing: entries.filter((row) => Number(row.active_count) === 0).length };
    });
    const [report] = await tx.insert(dailyReports).values({
      teacherId, schoolDate, closedAt: windowEnd, policyVersion: "v1", classSummaries: summaries,
    }).returning({ id: dailyReports.id });
    if (!report) throw new Error("Daily report creation failed");
    if (rows.length) {
      await tx.insert(dailyReportEntries).values(rows.map((row) => ({
        teacherId, reportId: report.id, classId: row.class_id, studentId: row.student_id,
        classNameSnapshot: row.class_name,
        studentNameSnapshot: `${row.first_name} ${row.last_name}`,
        activeHomeworkCount: Number(row.active_count), submitted: Number(row.active_count) > 0,
        hadDeletedHomework: row.had_deleted,
        accountConnectedSnapshot: null,
      })));
    }

    const recipientIds = [teacher.userId];
    const activeAssistants = await tx.select({ userId: assistants.userId }).from(assistants)
      .innerJoin(users, eq(assistants.userId, users.id))
      .where(and(eq(assistants.teacherId, teacherId), isNull(assistants.disabledAt),
        sql`${users.privateChatId} IS NOT NULL`));
    recipientIds.push(...activeAssistants.flatMap((assistant) => assistant.userId ? [assistant.userId] : []));
    for (const userId of recipientIds) {
      await tx.insert(outboxMessages).values({ teacherId, dailyReportId: report.id,
        recipientUserId: userId, kind: "daily_report", idempotencyKey: `daily:${teacherId}:${schoolDate}:${userId}:1`,
        payload: { schoolDate, summaries },
      });
    }
    return report.id;
  });
}

async function requireActiveStaff(db: Database, actor: Actor): Promise<void> {
  if (actor.role === "student") throw new Error("Forbidden");
  const [owner] = await db.select({ id: teachers.id }).from(teachers).where(and(
    eq(teachers.id, actor.teacherId), isNull(teachers.disabledAt),
  )).limit(1);
  if (!owner) throw new Error("Forbidden");
  if (actor.role === "teacher") {
    const [match] = await db.select({ id: teachers.id }).from(teachers)
      .where(and(eq(teachers.id, actor.teacherId), eq(teachers.userId, actor.userId))).limit(1);
    if (!match) throw new Error("Forbidden");
  } else {
    const [match] = await db.select({ id: assistants.id }).from(assistants).where(and(
      eq(assistants.id, actor.assistantId), eq(assistants.teacherId, actor.teacherId),
      eq(assistants.userId, actor.userId), isNull(assistants.disabledAt),
    )).limit(1);
    if (!match) throw new Error("Forbidden");
  }
}

export async function readDailyReport(db: Database, actor: Actor, schoolDate: string) {
  await requireActiveStaff(db, actor);
  const [report] = await db.select().from(dailyReports).where(and(
    eq(dailyReports.teacherId, actor.teacherId), eq(dailyReports.schoolDate, schoolDate),
  )).limit(1);
  if (!report) return null;
  const entries = await db.select().from(dailyReportEntries)
    .where(and(eq(dailyReportEntries.teacherId, actor.teacherId), eq(dailyReportEntries.reportId, report.id)))
    .orderBy(dailyReportEntries.classNameSnapshot, dailyReportEntries.studentNameSnapshot,
      dailyReportEntries.studentId);
  return { report, entries };
}

export async function readProvisionalDailyReport(db: Database, actor: Actor, schoolDate: string) {
  await requireActiveStaff(db, actor);
  const now = new Date();
  if (getTehranTime(now).schoolDate !== schoolDate || now >= getTehranHourInstant(schoolDate, 22)) {
    return null;
  }
  const windowStart = getTehranHourInstant(schoolDate, 14);
  const rawRows = await db.execute(sql`
    WITH eligible AS (
      SELECT m.class_id, m.student_id FROM class_memberships m
      WHERE m.teacher_id = ${actor.teacherId} AND m.joined_at <= ${now.toISOString()}::timestamptz
        AND (m.left_at IS NULL OR m.left_at > ${windowStart.toISOString()}::timestamptz)
      UNION
      SELECT h.class_id, h.student_id FROM homeworks h
      WHERE h.teacher_id = ${actor.teacherId} AND h.school_date = ${schoolDate}::date
        AND h.deleted_at IS NULL
    )
    SELECT e.class_id, e.student_id, c.name AS class_name,
      s.first_name, s.last_name,
      count(h.id)::integer AS active_count
    FROM eligible e
    JOIN classes c ON c.id = e.class_id AND c.teacher_id = ${actor.teacherId}
    JOIN students s ON s.id = e.student_id AND s.teacher_id = ${actor.teacherId}
    LEFT JOIN homeworks h ON h.class_id = e.class_id AND h.student_id = e.student_id
      AND h.school_date = ${schoolDate}::date AND h.deleted_at IS NULL
    GROUP BY e.class_id, e.student_id, c.name, s.first_name, s.last_name
    ORDER BY c.name, s.last_name, s.first_name, e.student_id
  `) as unknown as Array<Omit<ReportRow, "had_deleted">>;
  const classesForDay = await db.select({ id: classes.id, name: classes.name }).from(classes)
    .where(and(eq(classes.teacherId, actor.teacherId), sql`${classes.createdAt} <= ${now.toISOString()}::timestamptz`));
  const classSummaries = classesForDay.map((schoolClass) => {
    const entries = rawRows.filter((row) => row.class_id === schoolClass.id);
    return { classId: schoolClass.id, name: schoolClass.name,
      submitted: entries.filter((row) => Number(row.active_count) > 0).length,
      missing: entries.filter((row) => Number(row.active_count) === 0).length };
  });
  return { classSummaries, entries: rawRows.map((row) => ({
    classNameSnapshot: row.class_name, studentNameSnapshot: `${row.first_name} ${row.last_name}`,
    submitted: Number(row.active_count) > 0,
  })) };
}

export async function readPeriodReport(db: Database, actor: Actor, reference: Date, period: "week" | "month") {
  await requireActiveStaff(db, actor);
  const bounds = getPeriodBounds(reference, period);
  const rows = await db.execute(sql`
    SELECT e.class_id, e.student_id,
      (array_agg(e.class_name_snapshot ORDER BY r.school_date DESC))[1] AS class_name,
      (array_agg(e.student_name_snapshot ORDER BY r.school_date DESC))[1] AS student_name,
      count(*)::integer AS eligible_days,
      count(*) FILTER (WHERE e.submitted)::integer AS submitted_days
    FROM daily_report_entries e
    JOIN daily_reports r ON r.id = e.report_id AND r.teacher_id = e.teacher_id
    WHERE e.teacher_id = ${actor.teacherId}
      AND r.school_date >= ${bounds.start}::date
      AND r.school_date < ${bounds.endExclusive}::date
    GROUP BY e.class_id, e.student_id
    ORDER BY class_name, student_name, e.student_id
  `);
  return { ...bounds, rows };
}
