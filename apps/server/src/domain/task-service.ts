import { randomUUID } from "node:crypto";
import type {
  ChannelType,
  HumanTask,
  MessageKind,
  TaskStatus,
} from "@delegate-to-human/shared";
import type { AppConfig } from "../config.js";
import type { ChannelDispatcher } from "../channels/dispatcher.js";
import type { Repository, TaskAttachmentRecord, TaskFilters } from "../db/repository.js";
import type { ApiKeyRow, HumanRow, TaskRow } from "../db/schema.js";
import { signPayload } from "../security.js";
import type { LocalAttachmentStorage } from "../storage.js";
import {
  assertTransition,
  canAgentMessage,
  canHumanMessage,
  isTerminalStatus,
} from "./lifecycle.js";

export interface EncodedAttachment {
  filename: string;
  mediaType: string;
  contentBase64: string;
}

export interface DelegateInput {
  humanId: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  deadline?: string;
  channel?: ChannelType;
  attachments?: EncodedAttachment[];
}

export class TaskService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: Repository,
    private readonly storage: LocalAttachmentStorage,
    private readonly dispatcher: ChannelDispatcher,
  ) {}

  listHumans() {
    return this.repository.listHumans();
  }

  async delegate(apiKey: ApiKeyRow, input: DelegateInput): Promise<HumanTask> {
    const human = this.requireHuman(input.humanId);
    if (!human.active) throw new Error("Human is inactive");
    if (input.deadline && new Date(input.deadline).getTime() <= Date.now()) {
      throw new Error("Deadline must be in the future");
    }
    const taskId = randomUUID();
    const stored = await this.storeAttachments(input.attachments ?? []);
    this.repository.createTask({
      id: taskId,
      apiKeyId: apiKey.id,
      humanId: input.humanId,
      title: input.title,
      instructions: input.instructions,
      acceptanceCriteria: input.acceptanceCriteria,
      ...(input.deadline ? { deadline: new Date(input.deadline).toISOString() } : {}),
      ...(input.channel ? { requestedChannel: input.channel } : {}),
      attachments: stored,
    });
    void this.deliverAssignment(taskId);
    return this.getForAgent(apiKey, taskId);
  }

  getForAgent(apiKey: ApiKeyRow, taskId: string): HumanTask {
    const detail = this.requireDetailedTask(taskId);
    if (detail.task.apiKeyId !== apiKey.id) throw new Error("Task not found");
    return this.repository.toHumanTask(detail, (id) => this.agentAttachmentUrl(id, apiKey.id));
  }

  getForHuman(humanId: string, taskId: string): HumanTask {
    const detail = this.requireDetailedTask(taskId);
    if (detail.task.humanId !== humanId) throw new Error("Task not found");
    return this.repository.toHumanTask(
      detail,
      (id) => `${this.config.publicBaseUrl}/api/human/attachments/${id}`,
    );
  }

  listForAgent(apiKey: ApiKeyRow, filters: TaskFilters): HumanTask[] {
    return this.repository
      .listTasksForAgent(apiKey.id, filters)
      .map((task) => this.getForAgent(apiKey, task.id));
  }

  listForHuman(humanId: string): HumanTask[] {
    return this.repository
      .listTasksForHuman(humanId)
      .map((task) => this.getForHuman(humanId, task.id));
  }

  async agentMessage(
    apiKey: ApiKeyRow,
    taskId: string,
    body: string,
    files: EncodedAttachment[] = [],
  ): Promise<HumanTask> {
    const task = this.requireOwnedTask(apiKey, taskId);
    const status = task.status as TaskStatus;
    if (!canAgentMessage(status)) {
      throw new Error(`Agent cannot message task in ${status}`);
    }
    const attachments = await this.storeAttachments(files);
    this.repository.addMessage({
      taskId,
      author: "agent",
      kind: "message",
      body,
      attachments,
    });
    if (status === "awaiting_agent") {
      assertTransition(status, "awaiting_human");
      this.repository.updateTaskStatus(
        taskId,
        "awaiting_human",
        `agent:${apiKey.id}`,
        "task.agent_replied",
      );
    }
    void this.dispatcher.dispatch(taskId, "message", body).catch(() => undefined);
    return this.getForAgent(apiKey, taskId);
  }

  async humanMessage(
    humanId: string,
    taskId: string,
    body: string,
    kind: "message" | "question",
    files: EncodedAttachment[] = [],
  ): Promise<HumanTask> {
    const task = this.requireAssignedTask(humanId, taskId);
    const status = task.status as TaskStatus;
    if (!canHumanMessage(status)) {
      throw new Error(`Human cannot message task in ${status}`);
    }
    this.repository.addMessage({
      taskId,
      author: "human",
      kind,
      body,
      attachments: await this.storeAttachments(files),
    });
    if (kind === "question") {
      assertTransition(status, "awaiting_agent");
      this.repository.updateTaskStatus(
        taskId,
        "awaiting_agent",
        `human:${humanId}`,
        "task.human_question",
      );
    }
    return this.getForHuman(humanId, taskId);
  }

  async submitResult(
    humanId: string,
    taskId: string,
    body: string,
    files: EncodedAttachment[] = [],
  ): Promise<HumanTask> {
    const task = this.requireAssignedTask(humanId, taskId);
    const status = task.status as TaskStatus;
    if (status !== "awaiting_human") {
      throw new Error(`Human cannot submit a result in ${status}`);
    }
    this.repository.addMessage({
      taskId,
      author: "human",
      kind: "result",
      body,
      attachments: await this.storeAttachments(files),
    });
    assertTransition(status, "awaiting_agent_review");
    this.repository.updateTaskStatus(
      taskId,
      "awaiting_agent_review",
      `human:${humanId}`,
      "task.result_submitted",
    );
    return this.getForHuman(humanId, taskId);
  }

  review(
    apiKey: ApiKeyRow,
    taskId: string,
    decision: "accept" | "request_revision",
    feedback?: string,
  ): HumanTask {
    const task = this.requireOwnedTask(apiKey, taskId);
    const status = task.status as TaskStatus;
    if (status !== "awaiting_agent_review") {
      throw new Error(`Task is not awaiting review; current status is ${status}`);
    }
    const next = decision === "accept" ? "completed" : "awaiting_human";
    assertTransition(status, next);
    if (feedback) {
      this.repository.addMessage({
        taskId,
        author: "agent",
        kind: "review",
        body: feedback,
      });
    }
    this.repository.updateTaskStatus(
      taskId,
      next,
      `agent:${apiKey.id}`,
      decision === "accept" ? "task.result_accepted" : "task.revision_requested",
      feedback ? { feedback } : {},
    );
    if (decision === "request_revision") {
      void this.dispatcher
        .dispatch(taskId, "revision_requested", feedback)
        .catch(() => undefined);
    } else {
      void this.dispatcher
        .dispatch(taskId, "status", "The agent accepted your result.")
        .catch(() => undefined);
    }
    return this.getForAgent(apiKey, taskId);
  }

  cancel(apiKey: ApiKeyRow, taskId: string, reason?: string): HumanTask {
    const task = this.requireOwnedTask(apiKey, taskId);
    const status = task.status as TaskStatus;
    if (isTerminalStatus(status)) throw new Error(`Task is already ${status}`);
    assertTransition(status, "canceled");
    this.repository.updateTaskStatus(
      taskId,
      "canceled",
      `agent:${apiKey.id}`,
      "task.canceled",
      reason ? { reason } : {},
    );
    void this.dispatcher
      .dispatch(taskId, "status", reason ? `Task canceled: ${reason}` : "Task canceled.")
      .catch(() => undefined);
    return this.getForAgent(apiKey, taskId);
  }

  decline(humanId: string, taskId: string, reason?: string): HumanTask {
    const task = this.requireAssignedTask(humanId, taskId);
    const status = task.status as TaskStatus;
    if (status !== "awaiting_human") {
      throw new Error(`Human cannot decline task in ${status}`);
    }
    assertTransition(status, "declined");
    if (reason) {
      this.repository.addMessage({
        taskId,
        author: "human",
        kind: "message",
        body: reason,
      });
    }
    this.repository.updateTaskStatus(
      taskId,
      "declined",
      `human:${humanId}`,
      "task.declined",
      reason ? { reason } : {},
    );
    return this.getForHuman(humanId, taskId);
  }

  async processPendingDeliveries(): Promise<void> {
    for (const task of this.repository.listTasksByStatus(["pending_delivery"])) {
      await this.deliverAssignment(task.id);
    }
  }

  expireOverdue(): number {
    const overdue = this.repository.listOverdueTasks(new Date().toISOString());
    for (const task of overdue) {
      const status = task.status as TaskStatus;
      if (!isTerminalStatus(status)) {
        assertTransition(status, "expired");
        this.repository.updateTaskStatus(
          task.id,
          "expired",
          "system",
          "task.expired",
        );
        void this.dispatcher
          .dispatch(task.id, "status", "The task deadline passed and the task expired.")
          .catch(() => undefined);
      }
    }
    return overdue.length;
  }

  private async deliverAssignment(taskId: string): Promise<void> {
    const task = this.repository.getTaskRow(taskId);
    if (!task || task.status !== "pending_delivery") return;
    try {
      const channel = await this.dispatcher.dispatch(taskId, "assignment");
      this.repository.updateTaskStatus(
        taskId,
        "awaiting_human",
        "system",
        "task.delivered",
        {},
        channel,
      );
    } catch (error) {
      this.repository.updateTaskStatus(
        taskId,
        "delivery_failed",
        "system",
        "task.delivery_failed",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async storeAttachments(
    inputs: EncodedAttachment[],
  ): Promise<TaskAttachmentRecord[]> {
    if (inputs.length > this.config.maxAttachmentFiles) {
      throw new Error(`At most ${this.config.maxAttachmentFiles} attachments are allowed`);
    }
    const decoded = inputs.map((input) => {
      const normalized = input.contentBase64.replaceAll(/\s/g, "");
      if (
        normalized.length === 0 ||
        normalized.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
      ) {
        throw new Error(`Attachment ${input.filename} is not valid base64`);
      }
      return { input, data: Buffer.from(normalized, "base64") };
    });
    const total = decoded.reduce((sum, item) => sum + item.data.length, 0);
    if (total > this.config.maxAttachmentTotalBytes) {
      throw new Error(
        `Attachments exceed ${this.config.maxAttachmentTotalBytes} total bytes`,
      );
    }
    const results: TaskAttachmentRecord[] = [];
    for (const item of decoded) {
      const stored = await this.storage.put(item.data);
      results.push({
        id: randomUUID(),
        filename: item.input.filename.replaceAll(/[^\w.\- ()]/g, "_"),
        mediaType: item.input.mediaType,
        sizeBytes: stored.sizeBytes,
        storageKey: stored.storageKey,
      });
    }
    return results;
  }

  private agentAttachmentUrl(attachmentId: string, apiKeyId: string): string {
    const token = signPayload(
      {
        purpose: "attachment",
        attachmentId,
        apiKeyId,
        exp: Math.floor(Date.now() / 1000) + this.config.signedLinkTtlSeconds,
      },
      this.config.tokenSecret,
    );
    return `${this.config.publicBaseUrl}/api/attachments/${attachmentId}?token=${encodeURIComponent(token)}`;
  }

  private requireHuman(id: string): HumanRow {
    const human = this.repository.getHuman(id);
    if (!human) throw new Error("Human not found");
    return human;
  }

  private requireDetailedTask(id: string) {
    const task = this.repository.getDetailedTask(id);
    if (!task) throw new Error("Task not found");
    return task;
  }

  private requireOwnedTask(apiKey: ApiKeyRow, id: string): TaskRow {
    const task = this.repository.getTaskRow(id);
    if (!task || task.apiKeyId !== apiKey.id) throw new Error("Task not found");
    return task;
  }

  private requireAssignedTask(humanId: string, id: string): TaskRow {
    const task = this.repository.getTaskRow(id);
    if (!task || task.humanId !== humanId) throw new Error("Task not found");
    return task;
  }
}
