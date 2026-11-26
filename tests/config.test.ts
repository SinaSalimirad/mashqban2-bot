import { expect, test } from "bun:test";
import { readConfig } from "../src/shared/config.ts";

const valid = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/mashqban",
  BALE_BOT_TOKEN: "synthetic-token",
  TEACHER_BALE_ID: "9007199254740993",
  BOT_INSTANCE_KEY: "test",
  INVITE_CODE_SECRET: "synthetic-secret",
};

test("keeps large Bale identifiers as strings", () => {
  expect(readConfig(valid).teacherBaleId).toBe("9007199254740993");
});

test("rejects missing secrets without exposing values", () => {
  expect(() => readConfig({ ...valid, INVITE_CODE_SECRET: "" })).toThrow("INVITE_CODE_SECRET is required");
});

test("rejects invalid owner ID and database URL", () => {
  expect(() => readConfig({ ...valid, TEACHER_BALE_ID: "1.2" })).toThrow();
  expect(() => readConfig({ ...valid, DATABASE_URL: "https://example.com" })).toThrow();
  expect(() => readConfig({ ...valid, DATABASE_URL: "postgresql://user:CHANGE_ME@localhost/mashqban" })).toThrow();
});
