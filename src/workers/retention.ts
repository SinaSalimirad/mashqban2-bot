import { sql } from "drizzle-orm";
import type { Database } from "../database/client.ts";
import { getTehranHourInstant, parseSchoolDateInput } from "../shared/calendar.ts";
import type { PrivateFileStorage } from "../storage/private.ts";

const persianDate = new Intl.DateTimeFormat("en-US-u-ca-persian", {
  timeZone: "Asia/Tehran", year: "numeric", month: "numeric", day: "numeric",
});

export function expiredFileCutoff(now: Date): { schoolDate: string; instant: Date } {
  const parts = persianDate.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month)) throw new Error("Persian calendar unavailable");
  // Files from a school year expire after the following 31 Shahrivar has ended.
  const firstRetainedYear = month >= 7 ? year - 1 : year - 2;
  const schoolDate = parseSchoolDateInput(`${firstRetainedYear}/07/01`);
  if (!schoolDate) throw new Error("Unable to calculate file retention cutoff");
  return { schoolDate, instant: getTehranHourInstant(schoolDate, 0) };
}

type Candidate = { id: string; teacher_id: string; storage_key: string };

export async function purgeExpiredFiles(db: Database, storage: PrivateFileStorage, limit = 50): Promise<number> {
  const cutoff = expiredFileCutoff(new Date());
  const candidates = await db.execute(sql`
    SELECT a.id, a.teacher_id, a.storage_key
    FROM file_assets a
    WHERE a.status = 'ready' AND a.storage_key IS NOT NULL
      AND a.created_at < ${cutoff.instant.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM homework_version_files vf
        JOIN homeworks h ON h.id = vf.homework_id
        WHERE vf.asset_id = a.id AND h.school_date >= ${cutoff.schoolDate}::date
      )
      AND NOT EXISTS (
        SELECT 1 FROM feedbacks f
        JOIN homeworks h ON h.id = f.homework_id
        WHERE f.voice_asset_id = a.id AND h.school_date >= ${cutoff.schoolDate}::date
      )
      AND NOT EXISTS (
        SELECT 1 FROM draft_files df
        JOIN homework_drafts d ON d.id = df.draft_id
        WHERE df.asset_id = a.id AND d.status = 'open' AND d.expires_at > clock_timestamp()
      )
    ORDER BY a.created_at, a.id LIMIT ${limit}
  `) as unknown as Candidate[];

  let purged = 0;
  for (const candidate of candidates) {
    await storage.remove(candidate.teacher_id, candidate.storage_key);
    const changed = await db.execute(sql`
      UPDATE file_assets SET status = 'purged', storage_key = NULL,
        provider_file_id = NULL, original_name = NULL, checksum = NULL
      WHERE id = ${candidate.id} AND teacher_id = ${candidate.teacher_id}
        AND storage_key = ${candidate.storage_key} AND status = 'ready'
      RETURNING id
    `);
    purged += changed.length;
  }
  return purged;
}
