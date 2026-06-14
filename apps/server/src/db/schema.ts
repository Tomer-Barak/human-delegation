import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const humans = sqliteTable("humans", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  skillsJson: text("skills_json").notNull().default("[]"),
  availability: text("availability").notNull().default("available"),
  timezone: text("timezone").notNull().default("UTC"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const channelBindings = sqliteTable("channel_bindings", {
  id: text("id").primaryKey(),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["email", "telegram", "web"] }).notNull(),
  encryptedConfig: text("encrypted_config").notNull(),
  preferenceOrder: integer("preference_order").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [uniqueIndex("api_keys_hash_idx").on(table.keyHash)],
);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  apiKeyId: text("api_key_id")
    .notNull()
    .references(() => apiKeys.id),
  humanId: text("human_id")
    .notNull()
    .references(() => humans.id),
  title: text("title").notNull(),
  instructions: text("instructions").notNull(),
  acceptanceCriteriaJson: text("acceptance_criteria_json").notNull().default("[]"),
  status: text("status").notNull(),
  requestedChannel: text("requested_channel"),
  deliveredChannel: text("delivered_channel"),
  deadline: text("deadline"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  author: text("author").notNull(),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
});

export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mediaType: text("media_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: text("created_at").notNull(),
});

export const deliveryAttempts = sqliteTable("delivery_attempts", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey(),
    humanId: text("human_id")
      .notNull()
      .references(() => humans.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("magic_links_hash_idx").on(table.tokenHash)],
);

export const telegramUpdates = sqliteTable("telegram_updates", {
  updateId: text("update_id").primaryKey(),
  createdAt: text("created_at").notNull(),
});

export type HumanRow = typeof humans.$inferSelect;
export type ChannelBindingRow = typeof channelBindings.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
