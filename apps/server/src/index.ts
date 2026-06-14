import { loadConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { Repository } from "./db/repository.js";
import { LocalAttachmentStorage } from "./storage.js";
import { ChannelDispatcher } from "./channels/dispatcher.js";
import { TaskService } from "./domain/task-service.js";
import { buildApp } from "./routes.js";

const config = loadConfig();
const connection = createDatabase(config);
const repository = new Repository(connection);
const storage = new LocalAttachmentStorage(config.attachmentDir);
const dispatcher = new ChannelDispatcher(config, repository);
const taskService = new TaskService(config, repository, storage, dispatcher);
const app = await buildApp({ config, repository, taskService, storage, dispatcher });

const deadlineTimer = setInterval(() => {
  const expired = taskService.expireOverdue();
  if (expired > 0) app.log.info({ expired }, "Expired overdue human tasks");
}, config.deadlinePollIntervalMs);
deadlineTimer.unref();

await taskService.processPendingDeliveries();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  clearInterval(deadlineTimer);
  await app.close();
  repository.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
