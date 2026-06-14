import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestContext, waitFor } from "../test-helpers.js";

type Context = globalThis.ReturnType<typeof createTestContext>;

describe("TaskService", () => {
  let context: Context;

  beforeEach(() => {
    context = createTestContext();
  });

  afterEach(() => {
    context.cleanup();
  });

  it("runs an asynchronous human delegation through clarification and review", async () => {
    const human = context.repository.createHuman({
      displayName: "Ada Reviewer",
      skills: ["research", "review"],
      availability: "available",
      timezone: "Asia/Jerusalem",
      channels: [
        { type: "web", preferenceOrder: 1, encryptedConfig: "", enabled: true },
      ],
    });
    const { key, raw } = context.repository.createApiKeyRecord("test harness");
    expect(context.repository.findApiKey(raw)?.id).toBe(key.id);

    const delegated = await context.taskService.delegate(key, {
      humanId: human.id,
      title: "Check the evidence",
      instructions: "Review the attached evidence and report discrepancies.",
      acceptanceCriteria: ["List each discrepancy", "Cite the source"],
      attachments: [
        {
          filename: "evidence.txt",
          mediaType: "text/plain",
          contentBase64: Buffer.from("source material").toString("base64"),
        },
      ],
    });
    expect(delegated.status).toBe("pending_delivery");
    await waitFor(
      () => context.repository.getTaskRow(delegated.id)?.status === "awaiting_human",
    );

    const question = await context.taskService.humanMessage(
      human.id,
      delegated.id,
      "Which edition should I use?",
      "question",
    );
    expect(question.status).toBe("awaiting_agent");

    const answered = await context.taskService.agentMessage(
      key,
      delegated.id,
      "Use the 2026 edition.",
    );
    expect(answered.status).toBe("awaiting_human");

    const submitted = await context.taskService.submitResult(
      human.id,
      delegated.id,
      "I found one discrepancy.",
    );
    expect(submitted.status).toBe("awaiting_agent_review");

    const revision = context.taskService.review(
      key,
      delegated.id,
      "request_revision",
      "Include the source URL.",
    );
    expect(revision.status).toBe("awaiting_human");

    await context.taskService.submitResult(
      human.id,
      delegated.id,
      "One discrepancy, documented at https://example.test/source.",
    );
    const completed = context.taskService.review(key, delegated.id, "accept");
    expect(completed.status).toBe("completed");
    expect(completed.messages.map((message) => message.kind)).toEqual([
      "question",
      "message",
      "result",
      "review",
      "result",
    ]);
    expect(completed.attachments[0]?.filename).toBe("evidence.txt");
  });

  it("expires overdue unfinished tasks", () => {
    const human = context.repository.createHuman({
      displayName: "Deadline Owner",
      skills: [],
      availability: "available",
      timezone: "UTC",
      channels: [{ type: "web", preferenceOrder: 1, encryptedConfig: "" }],
    });
    const { key } = context.repository.createApiKeyRecord("test harness");
    const id = randomUUID();
    context.repository.createTask({
      id,
      apiKeyId: key.id,
      humanId: human.id,
      title: "Expired work",
      instructions: "This is already overdue.",
      acceptanceCriteria: [],
      deadline: new Date(Date.now() - 10_000).toISOString(),
      attachments: [],
    });
    expect(context.taskService.expireOverdue()).toBe(1);
    expect(context.repository.getTaskRow(id)?.status).toBe("expired");
  });

  it("rejects malformed and oversized attachment input", async () => {
    const human = context.repository.createHuman({
      displayName: "File Reviewer",
      skills: [],
      availability: "available",
      timezone: "UTC",
      channels: [{ type: "web", preferenceOrder: 1, encryptedConfig: "" }],
    });
    const { key } = context.repository.createApiKeyRecord("test harness");
    await expect(
      context.taskService.delegate(key, {
        humanId: human.id,
        title: "Bad file",
        instructions: "Review it.",
        acceptanceCriteria: [],
        attachments: [
          { filename: "bad.bin", mediaType: "application/octet-stream", contentBase64: "***" },
        ],
      }),
    ).rejects.toThrow("not valid base64");
  });
});
