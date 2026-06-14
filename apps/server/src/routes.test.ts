import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestContext } from "./test-helpers.js";
import { buildApp } from "./routes.js";

type Context = globalThis.ReturnType<typeof createTestContext>;

describe("HTTP and MCP routes", () => {
  let context: Context;
  let app: FastifyInstance;

  beforeEach(async () => {
    context = createTestContext();
    app = await buildApp(context);
  });

  afterEach(async () => {
    await app.close();
    context.cleanup();
  });

  it("provisions a human, API key, and one-time human login", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/api/admin/humans" });
    expect(unauthorized.statusCode).toBe(401);

    const humanResponse = await app.inject({
      method: "POST",
      url: "/api/admin/humans",
      headers: { authorization: `Bearer ${context.config.adminToken}` },
      payload: {
        displayName: "Lin Operator",
        skills: ["operations"],
        timezone: "UTC",
        channels: [{ type: "web", preferenceOrder: 1, config: {} }],
      },
    });
    expect(humanResponse.statusCode).toBe(201);
    const humanId = humanResponse.json().human.id as string;

    const keyResponse = await app.inject({
      method: "POST",
      url: "/api/admin/api-keys",
      headers: { authorization: `Bearer ${context.config.adminToken}` },
      payload: { name: "OpenCode" },
    });
    expect(keyResponse.statusCode).toBe(201);
    expect(keyResponse.json().token).toMatch(/^dth_/);

    const linkResponse = await app.inject({
      method: "POST",
      url: `/api/admin/humans/${humanId}/login-link`,
      headers: { authorization: `Bearer ${context.config.adminToken}` },
      payload: {},
    });
    const link = new URL(linkResponse.json().url as string);
    const magicToken = link.searchParams.get("token");
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/magic",
      payload: { token: magicToken },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toContain("dth_session=");

    const reused = await app.inject({
      method: "POST",
      url: "/api/auth/magic",
      payload: { token: magicToken },
    });
    expect(reused.statusCode).toBe(401);
  });

  it("exposes the human delegation tools through MCP", async () => {
    const { raw } = context.repository.createApiKeyRecord("MCP test");
    const human = context.repository.createHuman({
      displayName: "MCP Human",
      skills: ["fact-checking"],
      availability: "available",
      timezone: "UTC",
      channels: [{ type: "web", preferenceOrder: 1, encryptedConfig: "" }],
    });

    const initialize = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${raw}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "vitest", version: "1.0.0" },
        },
      },
    });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.serverInfo.name).toBe("delegate-to-human");

    const tools = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${raw}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([
        "list_humans",
        "delegate_to_human",
        "get_human_task",
        "list_human_tasks",
        "message_human",
        "review_human_result",
        "cancel_human_task",
      ]),
    );

    const delegated = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${raw}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "delegate_to_human",
          arguments: {
            human_id: human.id,
            title: "Verify the MCP path",
            instructions: "Confirm that this task was received.",
            acceptance_criteria: ["Return a confirmation"],
            channel: "web",
          },
        },
      },
    });
    expect(delegated.statusCode).toBe(200);
    expect(delegated.json().result.structuredContent).toMatchObject({
      humanId: human.id,
      title: "Verify the MCP path",
      status: "pending_delivery",
    });
  });
});
