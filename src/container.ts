const password = Bun.env.POSTGRES_PASSWORD;
if (!password || password === "CHANGE_ME") throw new Error("POSTGRES_PASSWORD is required");

const databaseUrl = new URL("postgresql://mashqban@db:5432/mashqban");
databaseUrl.password = password;
process.env.DATABASE_URL = databaseUrl.toString();

const task = Bun.argv[2];
if (task === "migrate") {
  const migration = Bun.spawn(["bun", "run", "db:migrate"], {
    cwd: "/app", env: process.env, stdout: "inherit", stderr: "inherit",
  });
  process.exit(await migration.exited);
}
if (task === "app") {
  await import("./index.ts");
} else if (task === "outbox") {
  await import("./operator.ts");
} else {
  throw new Error("Unknown container task");
}
