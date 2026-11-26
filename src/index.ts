import postgres from "postgres";
import { BaleClient } from "./bot/bale/client.ts";
import { createDatabase } from "./database/client.ts";
import { bootstrapTeacher } from "./modules/auth/service.ts";
import { runDailyScheduler } from "./scheduler/daily.ts";
import { readConfig } from "./shared/config.ts";
import { PrivateFileStorage } from "./storage/private.ts";
import { pollIntoInbox, processOneUpdate, recoverExpiredInboxLeases } from "./workers/inbox.ts";
import { dispatchOneOutbox, recoverExpiredOutboxLeases } from "./workers/outbox.ts";

const config = readConfig(Bun.env);
const storageDirectory = Bun.env.FILE_STORAGE_DIR?.trim();
if (!storageDirectory) throw new Error("FILE_STORAGE_DIR is required");
const storage = new PrivateFileStorage(storageDirectory);
const { db, close } = createDatabase(config.databaseUrl);
const bale = new BaleClient(config.baleBotToken);
const lockClient = postgres(config.databaseUrl, { max: 1, idle_timeout: 0, prepare: false });
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

try {
  const [lock] = await lockClient`SELECT pg_try_advisory_lock(hashtext(${config.botInstanceKey})) AS acquired`;
  if (lock?.acquired !== true) throw new Error("Another poller owns this bot instance");
  await bootstrapTeacher(db, config.teacherBaleId);
  await recoverExpiredInboxLeases(db);
  await recoverExpiredOutboxLeases(db);
  let lastScheduleAt = 0;

  while (!stopping) {
    try {
      if (Date.now() - lastScheduleAt >= 60_000) {
        await runDailyScheduler(db);
        lastScheduleAt = Date.now();
      }
      let handled = 0;
      while (handled < 100 && await processOneUpdate(db, config.botInstanceKey,
        bale, storage, config.inviteCodeSecret)) handled += 1;
      let delivered = 0;
      while (delivered < 100 && await dispatchOneOutbox(db, bale, storage)) delivered += 1;
      if (handled === 100 || delivered === 100) continue;
      await pollIntoInbox(db, bale, config.botInstanceKey, config.inviteCodeSecret);
    } catch {
      console.error("Bot loop failed; retrying after a short delay.");
      await Bun.sleep(2_000);
    }
  }
} finally {
  await lockClient.end();
  await close();
}
