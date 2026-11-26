import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAssets } from "../src/database/schema.ts";
import { PrivateFileStorage } from "../src/storage/private.ts";
import { purgeExpiredFiles } from "../src/workers/retention.ts";
import { openTestDatabase, resetTestDatabase, seedTeacher, type TestDatabase } from "./helpers/database.ts";

const databaseUrl = Bun.env.TEST_DATABASE_URL ?? "";
const integration = describe.skipIf(!databaseUrl);
let database: TestDatabase;
let root = "";

integration("private-file retention", () => {
  beforeAll(async () => { database = await openTestDatabase(databaseUrl); });
  beforeEach(async () => {
    await resetTestDatabase(database.db);
    root = await mkdtemp(join(tmpdir(), "mashqban-retention-"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  afterAll(async () => { await database?.close(); });

  test("purges expired bytes but preserves the historical asset row", async () => {
    const teacher = await seedTeacher(database.db);
    const storage = new PrivateFileStorage(root);
    const stored = await storage.store(teacher.teacherId, new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); },
    }));
    const [asset] = await database.db.insert(fileAssets).values({
      teacherId: teacher.teacherId, kind: "document", status: "ready",
      storageKey: stored.storageKey, checksum: stored.sha256, sizeBytes: stored.sizeBytes,
      createdByUserId: teacher.userId, createdAt: new Date("2020-01-01T00:00:00Z"),
    }).returning({ id: fileAssets.id });
    if (!asset) throw new Error("Asset missing");
    expect(await purgeExpiredFiles(database.db, storage)).toBe(1);
    const [purged] = await database.db.select().from(fileAssets).where(eq(fileAssets.id, asset.id));
    expect(purged).toMatchObject({ status: "purged", storageKey: null,
      providerFileId: null, originalName: null, checksum: null });
    await expect(storage.read(teacher.teacherId, stored.storageKey)).rejects.toThrow();
  });
});
