import { expect, test } from "bun:test";
import { expiredFileCutoff } from "../src/workers/retention.ts";

test("retains files through one year after the 31 Shahrivar school-year end", () => {
  const beforeNewSchoolYear = expiredFileCutoff(new Date("2026-09-22T12:00:00Z"));
  expect(beforeNewSchoolYear.schoolDate).toBe("2024-09-22");

  const afterNewSchoolYear = expiredFileCutoff(new Date("2026-09-23T12:00:00Z"));
  expect(afterNewSchoolYear.schoolDate).toBe("2025-09-23");
  expect(afterNewSchoolYear.instant.toISOString()).toBe("2025-09-22T20:30:00.000Z");
});
