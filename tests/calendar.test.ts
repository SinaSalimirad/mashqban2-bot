import { expect, test } from "bun:test";
import {
  formatPersianSchoolDate,
  getSchoolWeekStart,
  getTehranTime,
  isHomeworkWindowOpen,
} from "../src/shared/calendar.ts";

test.each([
  ["2026-11-25T10:29:59.000Z", false],
  ["2026-11-25T10:30:00.000Z", true],
  ["2026-11-25T18:29:59.000Z", true],
  ["2026-11-25T18:30:00.000Z", false],
] as const)("homework window at %s", (instant, expected) => {
  expect(isHomeworkWindowOpen(new Date(instant))).toBe(expected);
});

test("school date follows Tehran across UTC midnight", () => {
  expect(getTehranTime(new Date("2026-11-24T21:00:00.000Z")).schoolDate).toBe("2026-11-25");
});

test("uses historical Tehran timezone rules instead of a fixed offset", () => {
  expect(isHomeworkWindowOpen(new Date("2022-07-01T09:29:59.000Z"))).toBe(false);
  expect(isHomeworkWindowOpen(new Date("2022-07-01T09:30:00.000Z"))).toBe(true);
});

test("school week begins on Saturday across a Gregorian year", () => {
  expect(getSchoolWeekStart(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-12-26");
  expect(getSchoolWeekStart(new Date("2027-01-02T12:00:00.000Z"))).toBe("2027-01-02");
});

test("Persian display uses the Tehran school date", () => {
  expect(formatPersianSchoolDate(new Date("2026-11-24T21:00:00.000Z"))).toContain("آذر");
});

test("invalid instants fail explicitly", () => {
  expect(() => getTehranTime(new Date(Number.NaN))).toThrow(RangeError);
});
