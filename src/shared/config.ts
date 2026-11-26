export type AppConfig = {
  databaseUrl: string;
  baleBotToken: string;
  teacherBaleId: string;
  botInstanceKey: string;
  inviteCodeSecret: string;
};

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value || value === "CHANGE_ME") {
      throw new Error(`${name} is required`);
    }
    return value;
  }

  const databaseUrl = required("DATABASE_URL");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname && url.pathname.length > 1)) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!url.username || !url.password || url.password === "CHANGE_ME") {
    throw new Error("DATABASE_URL must include non-placeholder credentials");
  }

  const teacherBaleId = required("TEACHER_BALE_ID");
  if (!/^[1-9]\d*$/.test(teacherBaleId)) {
    throw new Error("TEACHER_BALE_ID must be a positive integer string");
  }

  return {
    databaseUrl,
    baleBotToken: required("BALE_BOT_TOKEN"),
    teacherBaleId,
    botInstanceKey: required("BOT_INSTANCE_KEY"),
    inviteCodeSecret: required("INVITE_CODE_SECRET"),
  };
}
