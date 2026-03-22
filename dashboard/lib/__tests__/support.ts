import type { Mark, Task } from "../types";

export function makeMark(overrides: Partial<Mark> & { range: Mark["range"] }): Mark {
  return {
    id: "m1",
    kind: "authored",
    by: "ai:Claude",
    at: "2026-03-21T10:00:00Z",
    quote: "text",
    ...overrides,
  };
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "001",
    title: "Test task",
    description: "",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 1,
    created: "2026-03-21T10:00:00Z",
    updated: "2026-03-21T10:00:00Z",
    branch: null,
    tags: [],
    proof: null,
    depends_on: [],
    retryCount: 0,
    maxRetries: 3,
    lastError: null,
    nextRetryAt: null,
    ...overrides,
  };
}
