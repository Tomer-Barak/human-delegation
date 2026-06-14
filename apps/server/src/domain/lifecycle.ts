import type { TaskStatus } from "@delegate-to-human/shared";

const terminal = new Set<TaskStatus>([
  "completed",
  "declined",
  "expired",
  "canceled",
  "delivery_failed",
]);

const transitions: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending_delivery: new Set(["awaiting_human", "delivery_failed", "canceled", "expired"]),
  awaiting_human: new Set([
    "awaiting_agent",
    "awaiting_agent_review",
    "declined",
    "canceled",
    "expired",
  ]),
  awaiting_agent: new Set(["awaiting_human", "canceled", "expired"]),
  awaiting_agent_review: new Set(["awaiting_human", "completed", "canceled", "expired"]),
  completed: new Set(),
  declined: new Set(),
  expired: new Set(),
  canceled: new Set(),
  delivery_failed: new Set(["pending_delivery", "canceled", "expired"]),
};

export function isTerminalStatus(status: TaskStatus): boolean {
  return terminal.has(status);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!transitions[from]?.has(to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function canAgentMessage(status: TaskStatus): boolean {
  return status === "awaiting_agent" || status === "awaiting_human";
}

export function canHumanMessage(status: TaskStatus): boolean {
  return status === "awaiting_human";
}
