const password = Bun.env.POSTGRES_PASSWORD;
if (!password || password === "CHANGE_ME") throw new Error("POSTGRES_PASSWORD is required");

const databaseUrl = new URL("postgresql://mashqban@db:5432/mashqban");
databaseUrl.password = password;
process.env.DATABASE_URL = databaseUrl.toString();

const task = Bun.argv[2];
switch (task) {
  case "migrate":
    await import("./migrate.ts");
    break;
  case "app":
    await import("./migrate.ts");
    await import("./index.ts");
    break;
  case "outbox":
    await import("./operator.ts");
    break;
  case "check":
    await import("./check-config.ts");
    break;
  default:
    throw new Error("Unknown container task");
}
