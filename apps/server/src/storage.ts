import { createReadStream, mkdirSync, promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredFile {
  storageKey: string;
  sizeBytes: number;
}

export class LocalAttachmentStorage {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  async put(data: Buffer): Promise<StoredFile> {
    const storageKey = randomUUID();
    const directory = join(this.root, storageKey.slice(0, 2));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(join(directory, storageKey), data, { flag: "wx", mode: 0o600 });
    return { storageKey, sizeBytes: data.length };
  }

  open(storageKey: string) {
    const safeKey = basename(storageKey);
    if (safeKey !== storageKey) {
      throw new Error("Invalid storage key");
    }
    return createReadStream(join(this.root, safeKey.slice(0, 2), safeKey));
  }
}
