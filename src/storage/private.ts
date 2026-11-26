import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type StoredFile = { storageKey: string; sizeBytes: number; sha256: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PrivateFileStorage {
  private readonly root: string;

  constructor(root: string, private readonly maxBytes = 20 * 1024 * 1024) {
    if (!root || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("Invalid private storage configuration");
    }
    this.root = resolve(root);
  }

  private path(ownerId: string, storageKey: string): string {
    if (!uuidPattern.test(ownerId) || !uuidPattern.test(storageKey)) {
      throw new Error("Invalid private file identifier");
    }
    return join(this.root, ownerId, storageKey);
  }

  async store(ownerId: string, input: ReadableStream<Uint8Array>): Promise<StoredFile> {
    const storageKey = randomUUID();
    const path = this.path(ownerId, storageKey);
    await mkdir(join(this.root, ownerId), { recursive: true, mode: 0o700 });
    const file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    let complete = false;
    try {
      for await (const chunk of input) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > this.maxBytes) throw new Error("File exceeds size limit");
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
          if (bytesWritten === 0) throw new Error("Unable to write private file");
          offset += bytesWritten;
        }
      }
      if (sizeBytes === 0) throw new Error("Empty files are not accepted");
      await file.sync();
      complete = true;
      return { storageKey, sizeBytes, sha256: hash.digest("hex") };
    } finally {
      await file.close();
      if (!complete) await unlink(path);
    }
  }

  open(ownerId: string, storageKey: string) {
    return createReadStream(this.path(ownerId, storageKey));
  }

  async read(ownerId: string, storageKey: string): Promise<Uint8Array> {
    return readFile(this.path(ownerId, storageKey));
  }

  async remove(ownerId: string, storageKey: string): Promise<void> {
    try {
      await unlink(this.path(ownerId, storageKey));
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
