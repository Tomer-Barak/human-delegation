export const taskStatuses = [
  "pending_delivery",
  "awaiting_human",
  "awaiting_agent",
  "awaiting_agent_review",
  "completed",
  "declined",
  "expired",
  "canceled",
  "delivery_failed",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type ChannelType = "email" | "telegram" | "web";
export type MessageAuthor = "agent" | "human" | "system";
export type MessageKind = "message" | "question" | "result" | "review";

export interface HumanSummary {
  id: string;
  displayName: string;
  skills: string[];
  availability: string;
  timezone: string;
  channels: ChannelType[];
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  downloadUrl?: string;
}

export interface TaskMessage {
  id: string;
  author: MessageAuthor;
  kind: MessageKind;
  body: string;
  createdAt: string;
  attachments: AttachmentSummary[];
}

export interface HumanTask {
  id: string;
  humanId: string;
  humanName: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  status: TaskStatus;
  requestedChannel?: ChannelType;
  deliveredChannel?: ChannelType;
  deadline?: string;
  createdAt: string;
  updatedAt: string;
  messages: TaskMessage[];
  attachments: AttachmentSummary[];
}
