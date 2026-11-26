import { eq, isNull } from "drizzle-orm";
import type { Database } from "../database/client.ts";
import { schedulerState, teachers } from "../database/schema.ts";
import { getTehranHourInstant, getTehranTime } from "../shared/calendar.ts";
import { closeSchoolDay } from "../modules/reports/service.ts";

function nextDate(date: string): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

export async function runDailyScheduler(db: Database, maxDaysPerTeacher = 31): Promise<number> {
  const owners = await db.select().from(teachers).where(isNull(teachers.disabledAt));
  let completed = 0;
  for (const owner of owners) {
    const jobName = `daily:${owner.id}`;
    const [cursor] = await db.select().from(schedulerState)
      .where(eq(schedulerState.jobName, jobName)).limit(1);
    let date = cursor?.lastCompletedSchoolDate
      ? nextDate(cursor.lastCompletedSchoolDate)
      : getTehranTime(owner.createdAt).schoolDate;
    for (let index = 0; index < maxDaysPerTeacher; index += 1) {
      const end = getTehranHourInstant(date, 22);
      if (end > new Date()) break;
      if (owner.createdAt < end) await closeSchoolDay(db, owner.id, date);
      await db.insert(schedulerState).values({ jobName, lastCompletedSchoolDate: date })
        .onConflictDoUpdate({ target: schedulerState.jobName,
          set: { lastCompletedSchoolDate: date, updatedAt: new Date() } });
      completed += 1;
      date = nextDate(date);
    }
  }
  return completed;
}
