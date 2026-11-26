const databaseUrl = Bun.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("TEST_DATABASE_URL is required for integration tests.");
  process.exit(1);
}

const files = [
  "tests/identity.integration.test.ts",
  "tests/homework-report.integration.test.ts",
  "tests/feedback.integration.test.ts",
  "tests/router.integration.test.ts",
  "tests/outbox.integration.test.ts",
  "tests/inbox.integration.test.ts",
  "tests/retention.integration.test.ts",
];

for (const file of files) {
  const process = Bun.spawn(["bun", "test", "--check", file], {
    cwd: import.meta.dir + "/..",
    env: { ...Bun.env, TEST_DATABASE_URL: databaseUrl },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) globalThis.process.exit(exitCode);
}
