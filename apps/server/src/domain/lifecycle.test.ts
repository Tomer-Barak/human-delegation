import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canAgentMessage,
  canHumanMessage,
  isTerminalStatus,
} from "./lifecycle.js";

describe("task lifecycle", () => {
  it("permits the review and revision loop", () => {
    expect(() => assertTransition("awaiting_human", "awaiting_agent_review")).not.toThrow();
    expect(() => assertTransition("awaiting_agent_review", "awaiting_human")).not.toThrow();
    expect(() => assertTransition("awaiting_agent_review", "completed")).not.toThrow();
  });

  it("rejects invalid transitions", () => {
    expect(() => assertTransition("completed", "awaiting_human")).toThrow(
      "Invalid task transition",
    );
    expect(() => assertTransition("awaiting_human", "completed")).toThrow(
      "Invalid task transition",
    );
  });

  it("enforces turn ownership", () => {
    expect(canHumanMessage("awaiting_human")).toBe(true);
    expect(canHumanMessage("awaiting_agent")).toBe(false);
    expect(canAgentMessage("awaiting_agent")).toBe(true);
    expect(isTerminalStatus("delivery_failed")).toBe(true);
  });
});
