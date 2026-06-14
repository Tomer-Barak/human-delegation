import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { Repository } from "./db/repository.js";
import { LocalAttachmentStorage } from "./storage.js";
import { ChannelDispatcher } from "./channels/dispatcher.js";
import { TaskService } from "./domain/task-service.js";

export function createTestContext() {
  const root = mkdtempSync(join(tmpdir(), "delegate-to-human-"));
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: "http://localhost:3000",
    basePath: "",
    databasePath: join(root, "test.db"),
    attachmentDir: join(root, "attachments"),
    tokenSecret: "test-token-secret-at-least-thirty-two-bytes",
    encryptionKey: Buffer.alloc(32, 7),
    adminToken: "test-admin-token",
    maxAttachmentFiles: 5,
    maxAttachmentTotalBytes: 10 * 1024 * 1024,
    signedLinkTtlSeconds: 3600,
    deadlinePollIntervalMs: 30_000,
  };
  const connection = createDatabase(config);
  const repository = new Repository(connection);
  const storage = new LocalAttachmentStorage(config.attachmentDir);
  const dispatcher = new ChannelDispatcher(config, repository);
  const taskService = new TaskService(config, repository, storage, dispatcher);

  return {
    root,
    config,
    repository,
    storage,
    dispatcher,
    taskService,
    cleanup() {
      repository.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
