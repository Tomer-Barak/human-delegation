import nodemailer from "nodemailer";
import type { AppConfig } from "../config.js";
import type { ChannelAdapter, ChannelContext } from "./types.js";

export class EmailChannel implements ChannelAdapter {
  readonly type = "email" as const;
  private readonly transporter;

  constructor(private readonly config: AppConfig["smtp"]) {
    this.transporter = config
      ? nodemailer.createTransport({
          host: config.host,
          port: config.port,
          secure: config.secure,
          ...(config.user
            ? { auth: { user: config.user, pass: config.password ?? "" } }
            : {}),
        })
      : undefined;
  }

  isConfigured(): boolean {
    return this.transporter !== undefined;
  }

  async healthCheck() {
    if (!this.transporter) return { ok: false, message: "SMTP is not configured" };
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deliver(context: ChannelContext): Promise<void> {
    if (!this.transporter || !this.config) {
      throw new Error("SMTP is not configured");
    }
    const address = context.config.address;
    if (typeof address !== "string" || !address) {
      throw new Error("Email channel has no address");
    }
    const criteria = context.task.acceptanceCriteria.length
      ? `\nAcceptance criteria:\n${context.task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : "";
    const message = context.message ? `\n\nMessage:\n${context.message}` : "";
    await this.transporter.sendMail({
      from: this.config.from,
      to: address,
      subject: `[Human delegation] ${context.task.title}`,
      text: `${context.task.instructions}${criteria}${message}\n\nOpen the task securely:\n${context.accessUrl}`,
    });
  }
}
