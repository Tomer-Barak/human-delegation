import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

export interface AppConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  attachmentDir: string;
  tokenSecret: string;
  encryptionKey: Buffer;
  adminToken: string;
  maxAttachmentFiles: number;
  maxAttachmentTotalBytes: number;
  signedLinkTtlSeconds: number;
  deadlinePollIntervalMs: number;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
  };
  telegramBotToken?: string;
  telegramWebhookSecret?: string;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function encryptionKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 32) {
    return decoded;
  }
  return createHash("sha256").update(value).digest();
}

export function loadConfig(): AppConfig {
  const databasePath = resolve(required("DATABASE_PATH", "./data/delegate-to-human.db"));
  const attachmentDir = resolve(required("ATTACHMENT_DIR", "./data/attachments"));
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(attachmentDir, { recursive: true });

  const smtpHost = process.env.SMTP_HOST;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  if (telegramBotToken && !process.env.TELEGRAM_WEBHOOK_SECRET) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set");
  }
  return {
    host: required("HOST", "0.0.0.0"),
    port: positiveInteger("PORT", 3000),
    publicBaseUrl: required("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
    databasePath,
    attachmentDir,
    tokenSecret: required("TOKEN_SECRET"),
    encryptionKey: encryptionKey(required("ENCRYPTION_KEY")),
    adminToken: required("ADMIN_TOKEN"),
    maxAttachmentFiles: positiveInteger("MAX_ATTACHMENT_FILES", 5),
    maxAttachmentTotalBytes: positiveInteger("MAX_ATTACHMENT_TOTAL_BYTES", 10 * 1024 * 1024),
    signedLinkTtlSeconds: positiveInteger("SIGNED_LINK_TTL_SECONDS", 7 * 24 * 60 * 60),
    deadlinePollIntervalMs: positiveInteger("DEADLINE_POLL_INTERVAL_MS", 30_000),
    ...(smtpHost
      ? {
          smtp: {
            host: smtpHost,
            port: positiveInteger("SMTP_PORT", 587),
            secure: process.env.SMTP_SECURE === "true",
            ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER } : {}),
            ...(process.env.SMTP_PASSWORD ? { password: process.env.SMTP_PASSWORD } : {}),
            from: required("SMTP_FROM", "Delegate to Human <noreply@example.com>"),
          },
        }
      : {}),
    ...(telegramBotToken ? { telegramBotToken } : {}),
    ...(process.env.TELEGRAM_WEBHOOK_SECRET
      ? { telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET }
      : {}),
  };
}
