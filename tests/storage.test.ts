import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateFileStorage } from "../src/storage/private.ts";

const roots: string[] = [];
const ownerId = "11111111-1111-4111-8111-111111111111";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage(maxBytes = 1024) {
  const root = await mkdtemp(join(tmpdir(), "mashqban-storage-"));
  roots.push(root);
  return { root, storage: new PrivateFileStorage(root, maxBytes) };
}

function stream(bytes: number[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

describe("private file storage", () => {
  test("stores private bytes, checksum and restrictive permissions", async () => {
    const target = await storage();
    const stored = await target.storage.store(ownerId, stream([1, 2, 3]));
    expect(stored).toEqual({ storageKey: expect.any(String), sizeBytes: 3,
      sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" });
    expect(await target.storage.read(ownerId, stored.storageKey)).toEqual(new Uint8Array([1, 2, 3]));
    const mode = (await stat(join(target.root, ownerId, stored.storageKey))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("removes partial files after size and empty-file failures", async () => {
    const target = await storage(2);
    await expect(target.storage.store(ownerId, stream([1, 2, 3]))).rejects.toThrow("size limit");
    await expect(target.storage.store(ownerId, stream([]))).rejects.toThrow("Empty files");
    expect(await readdir(join(target.root, ownerId))).toHaveLength(0);
  });

  test("prevents path traversal and makes repeated removal safe", async () => {
    const target = await storage();
    await expect(target.storage.read(ownerId, "../../secret")).rejects.toThrow("Invalid private file identifier");
    const stored = await target.storage.store(ownerId, stream([7]));
    await target.storage.remove(ownerId, stored.storageKey);
    await expect(target.storage.remove(ownerId, stored.storageKey)).resolves.toBeUndefined();
  });
});
