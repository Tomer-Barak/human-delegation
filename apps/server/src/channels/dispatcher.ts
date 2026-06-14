import type { ChannelType } from "@delegate-to-human/shared";
import type { AppConfig } from "../config.js";
import type { Repository } from "../db/repository.js";
import type { ChannelBindingRow, HumanRow } from "../db/schema.js";
import { decryptJson } from "../security.js";
import { EmailChannel } from "./email.js";
import { TelegramChannel } from "./telegram.js";
import type { ChannelAdapter } from "./types.js";
import { WebChannel } from "./web.js";

export class ChannelDispatcher {
  private readonly adapters: Map<ChannelType, ChannelAdapter>;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: Repository,
  ) {
    const adapters: ChannelAdapter[] = [
      new EmailChannel(config.smtp),
      new TelegramChannel(config.telegramBotToken),
      new WebChannel(),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.type, adapter]));
  }

  async health() {
    return Promise.all(
      Array.from(this.adapters.values()).map(async (adapter) => ({
        channel: adapter.type,
        configured: adapter.isConfigured(),
        ...(await adapter.healthCheck()),
      })),
    );
  }

  async dispatch(
    taskId: string,
    event: "assignment" | "message" | "revision_requested" | "status",
    message?: string,
  ): Promise<ChannelType> {
    const detail = this.repository.getDetailedTask(taskId);
    if (!detail) throw new Error("Task not found");
    const allBindings = this.repository.getChannelBindings(detail.human.id);
    const bindings = detail.task.requestedChannel
      ? allBindings.filter((binding) => binding.type === detail.task.requestedChannel)
      : allBindings;
    if (bindings.length === 0) {
      throw new Error("No eligible channel binding");
    }

    const errors: string[] = [];
    for (const binding of bindings) {
      const type = binding.type as ChannelType;
      const adapter = this.adapters.get(type);
      if (!adapter?.isConfigured()) {
        const error = `${type} adapter is not configured`;
        this.repository.recordDelivery(taskId, type, "failed", error);
        errors.push(error);
        continue;
      }
      try {
        const accessUrl = this.createAccessUrl(detail.human, detail.task.id);
        await adapter.deliver({
          task: this.repository.toHumanTask(detail, () => accessUrl),
          human: detail.human,
          config: this.decryptBinding(binding),
          accessUrl,
          event,
          ...(message ? { message } : {}),
        });
        this.repository.recordDelivery(taskId, type, "succeeded");
        return type;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.repository.recordDelivery(taskId, type, "failed", message);
        errors.push(`${type}: ${message}`);
        if (detail.task.requestedChannel) break;
      }
    }
    throw new Error(errors.join("; ") || "All delivery channels failed");
  }

  createAccessUrl(human: HumanRow, taskId: string): string {
    const token = this.repository.createMagicLink(
      human.id,
      taskId,
      this.config.signedLinkTtlSeconds,
    );
    return `${this.config.publicBaseUrl}/auth?token=${encodeURIComponent(token)}`;
  }

  private decryptBinding(binding: ChannelBindingRow): Record<string, unknown> {
    if (!binding.encryptedConfig) return {};
    return decryptJson<Record<string, unknown>>(
      binding.encryptedConfig,
      this.config.encryptionKey,
    );
  }
}
