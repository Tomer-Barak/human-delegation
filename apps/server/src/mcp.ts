import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiKeyRow } from "./db/schema.js";
import type { Repository } from "./db/repository.js";
import type { TaskService } from "./domain/task-service.js";

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  media_type: z.string().min(1).max(255),
  content_base64: z.string().min(1),
});

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent:
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : { value },
  };
}

export function createMcpServer(
  apiKey: ApiKeyRow,
  repository: Repository,
  taskService: TaskService,
): McpServer {
  const server = new McpServer({
    name: "delegate-to-human",
    version: "0.1.0",
  });

  server.registerTool(
    "list_humans",
    {
      description:
        "List humans available for delegation, including their skills, availability, timezone, and configured delivery channels. Call this before delegating when you do not already know the human ID.",
      inputSchema: {},
    },
    async () => result({ humans: taskService.listHumans() }),
  );

  server.registerTool(
    "delegate_to_human",
    {
      description:
        "Delegate a well-scoped task to a specific human. This is asynchronous: it returns a task handle immediately. Use get_human_task to inspect progress, message_human to answer questions, and review_human_result when a result is submitted.",
      inputSchema: {
        human_id: z.string().uuid(),
        title: z.string().min(1).max(200),
        instructions: z.string().min(1).max(50_000),
        acceptance_criteria: z.array(z.string().min(1).max(2_000)).max(20).default([]),
        deadline: z.string().datetime().optional(),
        channel: z.enum(["email", "telegram", "web"]).optional(),
        attachments: z.array(attachmentSchema).max(5).default([]),
      },
    },
    async (input) =>
      result(
        await taskService.delegate(apiKey, {
          humanId: input.human_id,
          title: input.title,
          instructions: input.instructions,
          acceptanceCriteria: input.acceptance_criteria,
          ...(input.deadline ? { deadline: input.deadline } : {}),
          ...(input.channel ? { channel: input.channel } : {}),
          attachments: input.attachments.map((attachment) => ({
            filename: attachment.filename,
            mediaType: attachment.media_type,
            contentBase64: attachment.content_base64,
          })),
        }),
      ),
  );

  server.registerTool(
    "get_human_task",
    {
      description:
        "Get the current state and full message thread for a delegated human task.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) => result(taskService.getForAgent(apiKey, task_id)),
  );

  server.registerTool(
    "list_human_tasks",
    {
      description:
        "List human delegation tasks created by this MCP API key, optionally filtered by status, human, or creation time.",
      inputSchema: {
        status: z
          .enum([
            "pending_delivery",
            "awaiting_human",
            "awaiting_agent",
            "awaiting_agent_review",
            "completed",
            "declined",
            "expired",
            "canceled",
            "delivery_failed",
          ])
          .optional(),
        human_id: z.string().uuid().optional(),
        created_after: z.string().datetime().optional(),
      },
    },
    async (input) =>
      result({
        tasks: taskService.listForAgent(apiKey, {
          ...(input.status ? { status: input.status } : {}),
          ...(input.human_id ? { humanId: input.human_id } : {}),
          ...(input.created_after ? { createdAfter: input.created_after } : {}),
        }),
      }),
  );

  server.registerTool(
    "message_human",
    {
      description:
        "Send a message to the assigned human, typically to answer a clarification question or add context.",
      inputSchema: {
        task_id: z.string().uuid(),
        message: z.string().min(1).max(50_000),
        attachments: z.array(attachmentSchema).max(5).default([]),
      },
    },
    async (input) =>
      result(
        await taskService.agentMessage(
          apiKey,
          input.task_id,
          input.message,
          input.attachments.map((attachment) => ({
            filename: attachment.filename,
            mediaType: attachment.media_type,
            contentBase64: attachment.content_base64,
          })),
        ),
      ),
  );

  server.registerTool(
    "review_human_result",
    {
      description:
        "Review a submitted human result. Accepting completes the task. Requesting revision returns it to the human and should include actionable feedback.",
      inputSchema: {
        task_id: z.string().uuid(),
        decision: z.enum(["accept", "request_revision"]),
        feedback: z.string().min(1).max(50_000).optional(),
      },
    },
    async ({ task_id, decision, feedback }) => {
      if (decision === "request_revision" && !feedback) {
        throw new Error("feedback is required when requesting revision");
      }
      return result(taskService.review(apiKey, task_id, decision, feedback));
    },
  );

  server.registerTool(
    "cancel_human_task",
    {
      description: "Cancel an unfinished human delegation task.",
      inputSchema: {
        task_id: z.string().uuid(),
        reason: z.string().min(1).max(5_000).optional(),
      },
    },
    async ({ task_id, reason }) =>
      result(taskService.cancel(apiKey, task_id, reason)),
  );

  return server;
}
