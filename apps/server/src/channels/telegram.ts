import type { ChannelAdapter, ChannelContext } from "./types.js";

export class TelegramChannel implements ChannelAdapter {
  readonly type = "telegram" as const;

  constructor(private readonly botToken?: string) {}

  isConfigured(): boolean {
    return Boolean(this.botToken);
  }

  async healthCheck() {
    if (!this.botToken) return { ok: false, message: "Telegram is not configured" };
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getMe`,
      );
      if (!response.ok) {
        return { ok: false, message: `Telegram API returned ${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deliver(context: ChannelContext): Promise<void> {
    if (!this.botToken) {
      throw new Error("Telegram is not configured");
    }
    const chatId = context.config.chatId;
    if (typeof chatId !== "string" && typeof chatId !== "number") {
      throw new Error("Telegram channel has no chatId");
    }
    const prefix =
      context.event === "assignment"
        ? `New delegated task: ${context.task.title}\n\n${context.task.instructions}`
        : `${context.event.replaceAll("_", " ")}: ${context.task.title}`;
    const message = context.message ? `\n\n${context.message}` : "";
    const commands =
      `\n\nReply with:\n/question ${context.task.id} <question>` +
      `\n/message ${context.task.id} <message>` +
      `\n/result ${context.task.id} <final result>`;
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: `${prefix}${message}${commands}\n\nFiles and full thread: ${context.accessUrl}`,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Telegram API returned ${response.status}: ${await response.text()}`);
    }
  }
}
