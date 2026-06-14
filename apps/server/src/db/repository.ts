import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import type {
  AttachmentSummary,
  ChannelType,
  HumanSummary,
  HumanTask,
  MessageAuthor,
  MessageKind,
  TaskStatus,
} from "@delegate-to-human/shared";
import type { DatabaseConnection } from "./database.js";
import {
  apiKeys,
  attachments,
  auditLogs,
  channelBindings,
  deliveryAttempts,
  humans,
  magicLinks,
  messages,
  tasks,
  telegramUpdates,
  type ApiKeyRow,
  type AttachmentRow,
  type ChannelBindingRow,
  type HumanRow,
  type MessageRow,
  type TaskRow,
} from "./schema.js";
import { createApiKey, hashToken } from "../security.js";

const now = () => new Date().toISOString();

function parseJsonArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
    ? parsed
    : [];
}

export interface NewChannelBinding {
  type: ChannelType;
  encryptedConfig: string;
  preferenceOrder: number;
  enabled?: boolean;
}

export interface NewHuman {
  displayName: string;
  skills: string[];
  availability: string;
  timezone: string;
  active?: boolean;
  channels: NewChannelBinding[];
}

export interface TaskAttachmentRecord {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  storageKey: string;
  messageId?: string;
}

export interface NewTaskRecord {
  id: string;
  apiKeyId: string;
  humanId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  requestedChannel?: ChannelType;
  deadline?: string;
  attachments: TaskAttachmentRecord[];
}

export interface TaskFilters {
  status?: TaskStatus;
  humanId?: string;
  createdAfter?: string;
}

export interface DetailedTask {
  task: TaskRow;
  human: HumanRow;
  messages: MessageRow[];
  attachments: AttachmentRow[];
}

export class Repository {
  constructor(private readonly connection: DatabaseConnection) {}

  close(): void {
    this.connection.sqlite.close();
  }

  createHuman(input: NewHuman): HumanRow {
    const id = randomUUID();
    const timestamp = now();
    const bindings = input.channels.some((channel) => channel.type === "web")
      ? input.channels
      : [
          ...input.channels,
          {
            type: "web" as const,
            encryptedConfig: "",
            preferenceOrder: Math.max(0, ...input.channels.map((item) => item.preferenceOrder)) + 1,
            enabled: true,
          },
        ];

    this.connection.db.transaction((tx) => {
      tx.insert(humans)
        .values({
          id,
          displayName: input.displayName,
          skillsJson: JSON.stringify(input.skills),
          availability: input.availability,
          timezone: input.timezone,
          active: input.active ?? true,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      if (bindings.length > 0) {
        tx.insert(channelBindings)
          .values(
            bindings.map((binding) => ({
              id: randomUUID(),
              humanId: id,
              type: binding.type,
              encryptedConfig: binding.encryptedConfig,
              preferenceOrder: binding.preferenceOrder,
              enabled: binding.enabled ?? true,
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .run();
      }
    });
    return this.getHuman(id) as HumanRow;
  }

  updateHuman(
    id: string,
    input: Partial<Omit<NewHuman, "channels">> & { channels?: NewChannelBinding[] },
  ): HumanRow | undefined {
    const current = this.getHuman(id);
    if (!current) return undefined;
    const timestamp = now();
    this.connection.db.transaction((tx) => {
      tx.update(humans)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.skills !== undefined ? { skillsJson: JSON.stringify(input.skills) } : {}),
          ...(input.availability !== undefined ? { availability: input.availability } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          updatedAt: timestamp,
        })
        .where(eq(humans.id, id))
        .run();
      if (input.channels) {
        tx.delete(channelBindings).where(eq(channelBindings.humanId, id)).run();
        const values = input.channels.some((channel) => channel.type === "web")
          ? input.channels
          : [
              ...input.channels,
              {
                type: "web" as const,
                encryptedConfig: "",
                preferenceOrder:
                  Math.max(0, ...input.channels.map((item) => item.preferenceOrder)) + 1,
                enabled: true,
              },
            ];
        tx.insert(channelBindings)
          .values(
            values.map((binding) => ({
              id: randomUUID(),
              humanId: id,
              type: binding.type,
              encryptedConfig: binding.encryptedConfig,
              preferenceOrder: binding.preferenceOrder,
              enabled: binding.enabled ?? true,
              createdAt: timestamp,
              updatedAt: timestamp,
            })),
          )
          .run();
      }
    });
    return this.getHuman(id);
  }

  getHuman(id: string): HumanRow | undefined {
    return this.connection.db.select().from(humans).where(eq(humans.id, id)).get();
  }

  listHumans(activeOnly = true): HumanSummary[] {
    const rows = activeOnly
      ? this.connection.db.select().from(humans).where(eq(humans.active, true)).all()
      : this.connection.db.select().from(humans).all();
    const bindings = this.connection.db
      .select()
      .from(channelBindings)
      .where(eq(channelBindings.enabled, true))
      .all();
    return rows.map((human) => ({
      id: human.id,
      displayName: human.displayName,
      skills: parseJsonArray(human.skillsJson),
      availability: human.availability,
      timezone: human.timezone,
      channels: bindings
        .filter((binding) => binding.humanId === human.id)
        .sort((a, b) => a.preferenceOrder - b.preferenceOrder)
        .map((binding) => binding.type),
    }));
  }

  getChannelBindings(humanId: string): ChannelBindingRow[] {
    return this.connection.db
      .select()
      .from(channelBindings)
      .where(
        and(eq(channelBindings.humanId, humanId), eq(channelBindings.enabled, true)),
      )
      .orderBy(asc(channelBindings.preferenceOrder))
      .all();
  }

  createApiKeyRecord(name: string): { key: ApiKeyRow; raw: string } {
    const generated = createApiKey();
    const row: ApiKeyRow = {
      id: randomUUID(),
      name,
      prefix: generated.prefix,
      keyHash: generated.hash,
      createdAt: now(),
      revokedAt: null,
    };
    this.connection.db.insert(apiKeys).values(row).run();
    return { key: row, raw: generated.raw };
  }

  findApiKey(raw: string): ApiKeyRow | undefined {
    return this.connection.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hashToken(raw)), isNull(apiKeys.revokedAt)))
      .get();
  }

  listApiKeys(): ApiKeyRow[] {
    return this.connection.db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all();
  }

  revokeApiKey(id: string): boolean {
    return (
      this.connection.db
        .update(apiKeys)
        .set({ revokedAt: now() })
        .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
        .run().changes > 0
    );
  }

  createTask(input: NewTaskRecord): TaskRow {
    const timestamp = now();
    this.connection.db.transaction((tx) => {
      tx.insert(tasks)
        .values({
          id: input.id,
          apiKeyId: input.apiKeyId,
          humanId: input.humanId,
          title: input.title,
          instructions: input.instructions,
          acceptanceCriteriaJson: JSON.stringify(input.acceptanceCriteria),
          status: "pending_delivery",
          ...(input.requestedChannel ? { requestedChannel: input.requestedChannel } : {}),
          ...(input.deadline ? { deadline: input.deadline } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      if (input.attachments.length > 0) {
        tx.insert(attachments)
          .values(
            input.attachments.map((attachment) => ({
              ...attachment,
              taskId: input.id,
              messageId: null,
              createdAt: timestamp,
            })),
          )
          .run();
      }
      tx.insert(auditLogs)
        .values({
          id: randomUUID(),
          taskId: input.id,
          actor: `agent:${input.apiKeyId}`,
          action: "task.created",
          metadataJson: "{}",
          createdAt: timestamp,
        })
        .run();
    });
    return this.getTaskRow(input.id) as TaskRow;
  }

  getTaskRow(id: string): TaskRow | undefined {
    return this.connection.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  getDetailedTask(id: string): DetailedTask | undefined {
    const task = this.getTaskRow(id);
    if (!task) return undefined;
    const human = this.getHuman(task.humanId);
    if (!human) return undefined;
    return {
      task,
      human,
      messages: this.connection.db
        .select()
        .from(messages)
        .where(eq(messages.taskId, id))
        .orderBy(asc(messages.createdAt))
        .all(),
      attachments: this.connection.db
        .select()
        .from(attachments)
        .where(eq(attachments.taskId, id))
        .orderBy(asc(attachments.createdAt))
        .all(),
    };
  }

  listTasksForAgent(apiKeyId: string, filters: TaskFilters): TaskRow[] {
    const conditions = [eq(tasks.apiKeyId, apiKeyId)];
    if (filters.status) conditions.push(eq(tasks.status, filters.status));
    if (filters.humanId) conditions.push(eq(tasks.humanId, filters.humanId));
    if (filters.createdAfter) conditions.push(gt(tasks.createdAt, filters.createdAfter));
    return this.connection.db
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt))
      .all();
  }

  listTasksForHuman(humanId: string): TaskRow[] {
    return this.connection.db
      .select()
      .from(tasks)
      .where(eq(tasks.humanId, humanId))
      .orderBy(desc(tasks.updatedAt))
      .all();
  }

  listTasksByStatus(statuses: TaskStatus[]): TaskRow[] {
    return this.connection.db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, statuses))
      .orderBy(asc(tasks.createdAt))
      .all();
  }

  listOverdueTasks(timestamp: string): TaskRow[] {
    return this.connection.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, [
            "pending_delivery",
            "awaiting_human",
            "awaiting_agent",
            "awaiting_agent_review",
          ]),
          lt(tasks.deadline, timestamp),
        ),
      )
      .all();
  }

  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    actor: string,
    action: string,
    metadata: Record<string, unknown> = {},
    deliveredChannel?: ChannelType,
  ): TaskRow {
    const timestamp = now();
    this.connection.db.transaction((tx) => {
      tx.update(tasks)
        .set({
          status,
          updatedAt: timestamp,
          ...(deliveredChannel ? { deliveredChannel } : {}),
        })
        .where(eq(tasks.id, taskId))
        .run();
      tx.insert(auditLogs)
        .values({
          id: randomUUID(),
          taskId,
          actor,
          action,
          metadataJson: JSON.stringify(metadata),
          createdAt: timestamp,
        })
        .run();
    });
    return this.getTaskRow(taskId) as TaskRow;
  }

  addMessage(input: {
    taskId: string;
    author: MessageAuthor;
    kind: MessageKind;
    body: string;
    attachments?: TaskAttachmentRecord[];
  }): MessageRow {
    const timestamp = now();
    const id = randomUUID();
    this.connection.db.transaction((tx) => {
      tx.insert(messages)
        .values({
          id,
          taskId: input.taskId,
          author: input.author,
          kind: input.kind,
          body: input.body,
          createdAt: timestamp,
        })
        .run();
      if (input.attachments && input.attachments.length > 0) {
        tx.insert(attachments)
          .values(
            input.attachments.map((attachment) => ({
              ...attachment,
              taskId: input.taskId,
              messageId: id,
              createdAt: timestamp,
            })),
          )
          .run();
      }
      tx.insert(auditLogs)
        .values({
          id: randomUUID(),
          taskId: input.taskId,
          actor: input.author,
          action: `message.${input.kind}`,
          metadataJson: "{}",
          createdAt: timestamp,
        })
        .run();
    });
    return this.connection.db.select().from(messages).where(eq(messages.id, id)).get() as MessageRow;
  }

  recordDelivery(
    taskId: string,
    channel: ChannelType,
    status: "succeeded" | "failed",
    error?: string,
  ): void {
    this.connection.db
      .insert(deliveryAttempts)
      .values({
        id: randomUUID(),
        taskId,
        channel,
        status,
        ...(error ? { error } : {}),
        createdAt: now(),
      })
      .run();
  }

  listDeliveryAttempts(taskId?: string) {
    const query = this.connection.db.select().from(deliveryAttempts);
    return taskId
      ? query.where(eq(deliveryAttempts.taskId, taskId)).orderBy(desc(deliveryAttempts.createdAt)).all()
      : query.orderBy(desc(deliveryAttempts.createdAt)).limit(200).all();
  }

  createMagicLink(humanId: string, taskId: string | undefined, ttlSeconds: number): string {
    const raw = randomBytes(32).toString("base64url");
    const timestamp = now();
    this.connection.db
      .insert(magicLinks)
      .values({
        id: randomUUID(),
        humanId,
        ...(taskId ? { taskId } : {}),
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        usedAt: null,
        createdAt: timestamp,
      })
      .run();
    return raw;
  }

  consumeMagicLink(raw: string): { humanId: string; taskId: string | null } | undefined {
    const row = this.connection.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, hashToken(raw)))
      .get();
    if (!row || row.usedAt || row.expiresAt <= now()) return undefined;
    this.connection.db
      .update(magicLinks)
      .set({ usedAt: now() })
      .where(eq(magicLinks.id, row.id))
      .run();
    return { humanId: row.humanId, taskId: row.taskId };
  }

  claimTelegramUpdate(updateId: string): boolean {
    try {
      this.connection.db
        .insert(telegramUpdates)
        .values({ updateId, createdAt: now() })
        .run();
      return true;
    } catch {
      return false;
    }
  }

  findHumanByTelegramChat(
    encryptedMatcher: (binding: ChannelBindingRow) => boolean,
  ): HumanRow | undefined {
    const bindings = this.connection.db
      .select()
      .from(channelBindings)
      .where(and(eq(channelBindings.type, "telegram"), eq(channelBindings.enabled, true)))
      .all();
    const binding = bindings.find(encryptedMatcher);
    return binding ? this.getHuman(binding.humanId) : undefined;
  }

  toHumanTask(detail: DetailedTask, attachmentUrl: (id: string) => string): HumanTask {
    const topLevel = detail.attachments.filter((attachment) => !attachment.messageId);
    const messageAttachments = new Map<string, AttachmentSummary[]>();
    for (const attachment of detail.attachments.filter((item) => item.messageId)) {
      const list = messageAttachments.get(attachment.messageId as string) ?? [];
      list.push(this.toAttachment(attachment, attachmentUrl));
      messageAttachments.set(attachment.messageId as string, list);
    }
    return {
      id: detail.task.id,
      humanId: detail.human.id,
      humanName: detail.human.displayName,
      title: detail.task.title,
      instructions: detail.task.instructions,
      acceptanceCriteria: parseJsonArray(detail.task.acceptanceCriteriaJson),
      status: detail.task.status as TaskStatus,
      ...(detail.task.requestedChannel
        ? { requestedChannel: detail.task.requestedChannel as ChannelType }
        : {}),
      ...(detail.task.deliveredChannel
        ? { deliveredChannel: detail.task.deliveredChannel as ChannelType }
        : {}),
      ...(detail.task.deadline ? { deadline: detail.task.deadline } : {}),
      createdAt: detail.task.createdAt,
      updatedAt: detail.task.updatedAt,
      attachments: topLevel.map((attachment) => this.toAttachment(attachment, attachmentUrl)),
      messages: detail.messages.map((message) => ({
        id: message.id,
        author: message.author as MessageAuthor,
        kind: message.kind as MessageKind,
        body: message.body,
        createdAt: message.createdAt,
        attachments: messageAttachments.get(message.id) ?? [],
      })),
    };
  }

  getAttachment(id: string): AttachmentRow | undefined {
    return this.connection.db.select().from(attachments).where(eq(attachments.id, id)).get();
  }

  private toAttachment(
    attachment: AttachmentRow,
    attachmentUrl: (id: string) => string,
  ): AttachmentSummary {
    return {
      id: attachment.id,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      downloadUrl: attachmentUrl(attachment.id),
    };
  }
}
