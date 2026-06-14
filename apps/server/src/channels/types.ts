import type { ChannelType, HumanTask } from "@delegate-to-human/shared";
import type { HumanRow } from "../db/schema.js";

export interface ChannelContext {
  task: HumanTask;
  human: HumanRow;
  config: Record<string, unknown>;
  accessUrl: string;
  event: "assignment" | "message" | "revision_requested" | "status";
  message?: string;
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  isConfigured(): boolean;
  healthCheck(): Promise<{ ok: boolean; message?: string }>;
  deliver(context: ChannelContext): Promise<void>;
}
