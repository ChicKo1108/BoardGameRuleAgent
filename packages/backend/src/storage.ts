import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
export const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export function validateKey(key: string) {
  if (!/^(documents\/[a-f0-9]{64}\.pdf|parses\/[a-f0-9]{64}\.json)$/.test(key))
    throw new Error("INVALID_STORAGE_KEY");
}
/** Private filesystem adapter. Multi-host deployments require a shared volume or another BlobStore. */
export class LocalBlobStore implements BlobStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async get(key: string) {
    validateKey(key);
    const file = await open(
      join(this.root, key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
        throw new Error("INVALID_STORED_OBJECT");
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async put(key: string, bytes: Uint8Array) {
    validateKey(key);
    const expected = key.split("/")[1].split(".")[0];
    if (sha256(bytes) !== expected) throw new Error("HASH_MISMATCH");
    const folder = join(this.root, key.split("/")[0]);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `.upload-${randomUUID()}`);
    const file = await open(temporary, "wx", 0o600);
    try {
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, join(this.root, key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (sha256(await this.get(key)) !== expected)
          throw new Error("STORED_OBJECT_CORRUPTED");
      }
    } finally {
      await unlink(temporary);
    }
  }
}
