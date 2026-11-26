export const SCHOOL_TIME_ZONE = "Asia/Tehran";

export type SchoolDate = string;

export type TehranTime = {
  schoolDate: SchoolDate;
  hour: number;
  minute: number;
  second: number;
};

const tehranClock = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHOOL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const persianCalendar = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  timeZone: SCHOOL_TIME_ZONE,
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function getTehranTime(instant: Date): TehranTime {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("Invalid instant");
  }

  const parts = new Map(tehranClock.formatToParts(instant).map(({ type, value }) => [type, value]));
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  const second = parts.get("second");
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error("Tehran date formatting failed");
  }

  return {
    schoolDate: `${year}-${month}-${day}`,
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

export function isHomeworkWindowOpen(instant: Date): boolean {
  const { hour } = getTehranTime(instant);
  return hour >= 14 && hour < 22;
}

export function getSchoolWeekStart(instant: Date): SchoolDate {
  const { schoolDate } = getTehranTime(instant);
  const date = new Date(`${schoolDate}T00:00:00.000Z`);
  const daysSinceSaturday = (date.getUTCDay() + 1) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceSaturday);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatPersianSchoolDate(instant: Date): string {
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError("Invalid instant");
  }
  return persianCalendar.format(instant);
}

export function getTehranHourInstant(schoolDate: SchoolDate, hour: 14 | 22): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(schoolDate)) throw new RangeError("Invalid school date");
  const midnightUtc = Date.parse(`${schoolDate}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc) || new Date(midnightUtc).toISOString().slice(0, 10) !== schoolDate) {
    throw new RangeError("Invalid school date");
  }

  let low = midnightUtc - 12 * 60 * 60 * 1000;
  let high = midnightUtc + 36 * 60 * 60 * 1000;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const local = getTehranTime(new Date(middle));
    if (local.schoolDate > schoolDate || (local.schoolDate === schoolDate && local.hour >= hour)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const result = new Date(low);
  const local = getTehranTime(result);
  if (local.schoolDate !== schoolDate || local.hour !== hour || local.minute !== 0 || local.second !== 0) {
    throw new RangeError("Tehran hour is unavailable on this day");
  }
  return result;
}

function shiftSchoolDate(schoolDate: SchoolDate, days: number): SchoolDate {
  const date = new Date(`${schoolDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const persianMonth = new Intl.DateTimeFormat("en-US-u-ca-persian", {
  timeZone: SCHOOL_TIME_ZONE, year: "numeric", month: "numeric",
});

function persianMonthKey(schoolDate: SchoolDate): string {
  const parts = persianMonth.formatToParts(getTehranHourInstant(schoolDate, 14));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Persian calendar unavailable");
  return `${year}-${month}`;
}

export function getPeriodBounds(reference: Date, period: "week" | "month"): {
  start: SchoolDate; endExclusive: SchoolDate;
} {
  const schoolDate = getTehranTime(reference).schoolDate;
  if (period === "week") {
    const start = getSchoolWeekStart(reference);
    return { start, endExclusive: shiftSchoolDate(start, 7) };
  }
  const key = persianMonthKey(schoolDate);
  let start = schoolDate;
  for (let day = 0; day < 31; day += 1) {
    const previous = shiftSchoolDate(start, -1);
    if (persianMonthKey(previous) !== key) break;
    start = previous;
  }
  let endExclusive = schoolDate;
  for (let day = 0; day < 32; day += 1) {
    endExclusive = shiftSchoolDate(endExclusive, 1);
    if (persianMonthKey(endExclusive) !== key) break;
  }
  return { start, endExclusive };
}
