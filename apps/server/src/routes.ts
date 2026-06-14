import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { ChannelType } from "@delegate-to-human/shared";
import type { AppConfig } from "./config.js";
import type { Repository } from "./db/repository.js";
import type { TaskService, EncodedAttachment } from "./domain/task-service.js";
import type { LocalAttachmentStorage } from "./storage.js";
import {
  createHumanSession,
  requireAdmin,
  requireApiKey,
  requireHumanSession,
  setHumanSessionCookie,
  type AttachmentToken,
} from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { decryptJson, encryptJson, signPayload, verifyPayload } from "./security.js";

interface Dependencies {
  config: AppConfig;
  repository: Repository;
  taskService: TaskService;
  storage: LocalAttachmentStorage;
  dispatcher?: {
    health(): Promise<Array<{
      channel: ChannelType;
      configured: boolean;
      ok: boolean;
      message?: string;
    }>>;
  };
}

function statusCode(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  const message = error instanceof Error ? error.message : "";
  if (message.includes("not found") || message.includes("not found")) return 404;
  if (
    message.includes("cannot") ||
    message.includes("Invalid") ||
    message.includes("required") ||
    message.includes("At most") ||
    message.includes("exceed") ||
    message.includes("must be")
  ) {
    return 400;
  }
  return 500;
}

function errorBody(error: unknown) {
  return { error: error instanceof Error ? error.message : "Internal server error" };
}

function secureCookies(config: AppConfig): boolean {
  return config.publicBaseUrl.startsWith("https://");
}

async function parseHumanSubmission(
  request: FastifyRequest,
): Promise<{ body: string; kind?: "message" | "question"; attachments: EncodedAttachment[] }> {
  if (!request.isMultipart()) {
    const payload = request.body as {
      body?: string;
      kind?: "message" | "question";
      attachments?: EncodedAttachment[];
    };
    return {
      body: payload.body ?? "",
      ...(payload.kind ? { kind: payload.kind } : {}),
      attachments: payload.attachments ?? [],
    };
  }
  let body = "";
  let kind: "message" | "question" | undefined;
  const attachments: EncodedAttachment[] = [];
  for await (const part of request.parts()) {
    if (part.type === "file") {
      const data = await part.toBuffer();
      attachments.push({
        filename: part.filename,
        mediaType: part.mimetype,
        contentBase64: data.toString("base64"),
      });
    } else if (part.fieldname === "body") {
      body = String(part.value);
    } else if (part.fieldname === "kind") {
      const value = String(part.value);
      if (value === "message" || value === "question") kind = value;
    }
  }
  return { body, ...(kind ? { kind } : {}), attachments };
}

function parseTelegramCommand(text: string):
  | { command: "message" | "question" | "result"; taskId: string; body: string }
  | undefined {
  const match = text.match(/^\/(message|question|result)(?:@\w+)?\s+([0-9a-f-]{36})\s+([\s\S]+)$/i);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    command: match[1].toLowerCase() as "message" | "question" | "result",
    taskId: match[2],
    body: match[3].trim(),
  };
}

export async function buildApp(deps: Dependencies): Promise<FastifyInstance> {
  const { config, repository, taskService, storage } = deps;
  const app = Fastify({ logger: true, bodyLimit: config.maxAttachmentTotalBytes * 2 });

  await app.register(cors, {
    origin: true,
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "mcp-session-id"],
    exposedHeaders: ["mcp-session-id"],
  });
  await app.register(multipart, {
    limits: {
      files: config.maxAttachmentFiles,
      fileSize: config.maxAttachmentTotalBytes,
      fields: 10,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    const code = statusCode(error);
    if (code >= 500) app.log.error(error);
    void reply.code(code).send(errorBody(error));
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.all("/mcp", async (request, reply) => {
    if (request.method !== "POST") {
      return reply.code(405).send({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
    }
    let apiKey;
    try {
      apiKey = requireApiKey(request, repository);
    } catch {
      return reply.code(401).send({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
    }
    const mcp = createMcpServer(apiKey, repository, taskService);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await mcp.close();
    }
  });

  app.get("/api/humans", async () => ({ humans: taskService.listHumans() }));

  app.get("/api/admin/humans", async (request) => {
    requireAdmin(request, config);
    return { humans: repository.listHumans(false) };
  });

  app.post("/api/admin/humans", async (request, reply) => {
    requireAdmin(request, config);
    const body = request.body as {
      displayName: string;
      skills?: string[];
      availability?: string;
      timezone?: string;
      active?: boolean;
      channels?: Array<{
        type: ChannelType;
        preferenceOrder: number;
        enabled?: boolean;
        config?: Record<string, unknown>;
      }>;
    };
    if (!body.displayName?.trim()) return reply.code(400).send({ error: "displayName is required" });
    const human = repository.createHuman({
      displayName: body.displayName.trim(),
      skills: body.skills ?? [],
      availability: body.availability ?? "available",
      timezone: body.timezone ?? "UTC",
      active: body.active ?? true,
      channels: (body.channels ?? []).map((channel) => ({
        type: channel.type,
        preferenceOrder: channel.preferenceOrder,
        enabled: channel.enabled ?? true,
        encryptedConfig:
          channel.type === "web"
            ? ""
            : encryptJson(channel.config ?? {}, config.encryptionKey),
      })),
    });
    return reply.code(201).send({ human });
  });

  app.patch("/api/admin/humans/:id", async (request, reply) => {
    requireAdmin(request, config);
    const { id } = request.params as { id: string };
    const body = request.body as {
      displayName?: string;
      skills?: string[];
      availability?: string;
      timezone?: string;
      active?: boolean;
      channels?: Array<{
        type: ChannelType;
        preferenceOrder: number;
        enabled?: boolean;
        config?: Record<string, unknown>;
      }>;
    };
    const human = repository.updateHuman(id, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.skills !== undefined ? { skills: body.skills } : {}),
      ...(body.availability !== undefined ? { availability: body.availability } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.channels
        ? {
            channels: body.channels.map((channel) => ({
              type: channel.type,
              preferenceOrder: channel.preferenceOrder,
              enabled: channel.enabled ?? true,
              encryptedConfig:
                channel.type === "web"
                  ? ""
                  : encryptJson(channel.config ?? {}, config.encryptionKey),
            })),
          }
        : {}),
    });
    return human ? { human } : reply.code(404).send({ error: "Human not found" });
  });

  app.post("/api/admin/humans/:id/login-link", async (request, reply) => {
    requireAdmin(request, config);
    const { id } = request.params as { id: string };
    const human = repository.getHuman(id);
    if (!human) return reply.code(404).send({ error: "Human not found" });
    const token = repository.createMagicLink(id, undefined, config.signedLinkTtlSeconds);
    return { url: `${config.publicBaseUrl}/auth?token=${encodeURIComponent(token)}` };
  });

  app.get("/api/admin/api-keys", async (request) => {
    requireAdmin(request, config);
    return {
      apiKeys: repository.listApiKeys().map(({ keyHash: _keyHash, ...key }) => key),
    };
  });

  app.post("/api/admin/api-keys", async (request, reply) => {
    requireAdmin(request, config);
    const body = request.body as { name?: string };
    if (!body.name?.trim()) return reply.code(400).send({ error: "name is required" });
    const created = repository.createApiKeyRecord(body.name.trim());
    const { keyHash: _keyHash, ...key } = created.key;
    return reply.code(201).send({ apiKey: key, token: created.raw });
  });

  app.delete("/api/admin/api-keys/:id", async (request, reply) => {
    requireAdmin(request, config);
    const { id } = request.params as { id: string };
    return repository.revokeApiKey(id)
      ? reply.code(204).send()
      : reply.code(404).send({ error: "API key not found" });
  });

  app.get("/api/admin/deliveries", async (request) => {
    requireAdmin(request, config);
    const query = request.query as { taskId?: string };
    return { deliveries: repository.listDeliveryAttempts(query.taskId) };
  });

  app.get("/api/admin/channel-health", async (request) => {
    requireAdmin(request, config);
    return { channels: deps.dispatcher ? await deps.dispatcher.health() : [] };
  });

  app.post("/api/auth/magic", async (request, reply) => {
    const body = request.body as { token?: string };
    if (!body.token) return reply.code(400).send({ error: "token is required" });
    const consumed = repository.consumeMagicLink(body.token);
    if (!consumed) return reply.code(401).send({ error: "Invalid or expired link" });
    const session = createHumanSession(consumed.humanId, config);
    setHumanSessionCookie(reply, session, secureCookies(config));
    return { taskId: consumed.taskId };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header(
      "set-cookie",
      `dth_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookies(config) ? "; Secure" : ""}`,
    );
    return reply.code(204).send();
  });

  app.get("/api/human/me", async (request) => {
    const session = requireHumanSession(request, config);
    const human = repository.getHuman(session.humanId);
    if (!human) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    return {
      human: {
        id: human.id,
        displayName: human.displayName,
        skills: JSON.parse(human.skillsJson) as string[],
        availability: human.availability,
        timezone: human.timezone,
      },
    };
  });

  app.get("/api/human/tasks", async (request) => {
    const session = requireHumanSession(request, config);
    return { tasks: taskService.listForHuman(session.humanId) };
  });

  app.get("/api/human/tasks/:id", async (request) => {
    const session = requireHumanSession(request, config);
    const { id } = request.params as { id: string };
    return { task: taskService.getForHuman(session.humanId, id) };
  });

  app.post("/api/human/tasks/:id/messages", async (request) => {
    const session = requireHumanSession(request, config);
    const { id } = request.params as { id: string };
    const submission = await parseHumanSubmission(request);
    if (!submission.body.trim()) throw new Error("body is required");
    return {
      task: await taskService.humanMessage(
        session.humanId,
        id,
        submission.body,
        submission.kind ?? "message",
        submission.attachments,
      ),
    };
  });

  app.post("/api/human/tasks/:id/result", async (request) => {
    const session = requireHumanSession(request, config);
    const { id } = request.params as { id: string };
    const submission = await parseHumanSubmission(request);
    if (!submission.body.trim()) throw new Error("body is required");
    return {
      task: await taskService.submitResult(
        session.humanId,
        id,
        submission.body,
        submission.attachments,
      ),
    };
  });

  app.post("/api/human/tasks/:id/decline", async (request) => {
    const session = requireHumanSession(request, config);
    const { id } = request.params as { id: string };
    const body = request.body as { reason?: string };
    return { task: taskService.decline(session.humanId, id, body.reason) };
  });

  app.get("/api/human/attachments/:id", async (request, reply) => {
    const session = requireHumanSession(request, config);
    const { id } = request.params as { id: string };
    const attachment = repository.getAttachment(id);
    const task = attachment ? repository.getTaskRow(attachment.taskId) : undefined;
    if (!attachment || !task || task.humanId !== session.humanId) {
      return reply.code(404).send({ error: "Attachment not found" });
    }
    reply.type(attachment.mediaType);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    return reply.send(storage.open(attachment.storageKey));
  });

  app.get("/api/attachments/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { token?: string };
    if (!query.token) return reply.code(401).send({ error: "Missing token" });
    let payload: AttachmentToken;
    try {
      payload = verifyPayload<AttachmentToken>(query.token, config.tokenSecret);
    } catch {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
    const attachment = repository.getAttachment(id);
    const task = attachment ? repository.getTaskRow(attachment.taskId) : undefined;
    if (
      payload.purpose !== "attachment" ||
      payload.attachmentId !== id ||
      !attachment ||
      !task ||
      task.apiKeyId !== payload.apiKeyId
    ) {
      return reply.code(404).send({ error: "Attachment not found" });
    }
    reply.type(attachment.mediaType);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
    return reply.send(storage.open(attachment.storageKey));
  });

  app.post("/api/telegram/webhook", async (request, reply) => {
    if (
      config.telegramWebhookSecret &&
      request.headers["x-telegram-bot-api-secret-token"] !== config.telegramWebhookSecret
    ) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    const update = request.body as {
      update_id?: number;
      message?: { text?: string; chat?: { id?: number }; from?: { id?: number } };
    };
    if (update.update_id === undefined || !repository.claimTelegramUpdate(String(update.update_id))) {
      return { ok: true };
    }
    const text = update.message?.text;
    const chatId = update.message?.chat?.id;
    const command = text ? parseTelegramCommand(text) : undefined;
    if (!command || chatId === undefined) return { ok: true };
    const human = repository.findHumanByTelegramChat((binding) => {
      const bindingConfig = decryptJson<Record<string, unknown>>(
        binding.encryptedConfig,
        config.encryptionKey,
      );
      const configuredUserId = bindingConfig.userId;
      const senderId = update.message?.from?.id;
      return (
        String(bindingConfig.chatId) === String(chatId) &&
        (configuredUserId === undefined || String(configuredUserId) === String(senderId))
      );
    });
    if (!human) return reply.code(403).send({ error: "Unknown Telegram identity" });
    if (command.command === "result") {
      await taskService.submitResult(human.id, command.taskId, command.body);
    } else {
      await taskService.humanMessage(
        human.id,
        command.taskId,
        command.body,
        command.command,
      );
    }
    return { ok: true };
  });

  const webDist = resolve(process.cwd(), "apps/web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/mcp") {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      name: "delegate-to-human",
      message: "Web UI has not been built. Run pnpm --filter @delegate-to-human/web build.",
    }));
  }

  return app;
}
