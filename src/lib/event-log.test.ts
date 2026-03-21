import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, type OrchestratorEvent } from "./event-log.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-evlog-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("creates .tasks/ and events.log if they don't exist", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      taskId: "001",
      agent: "Agent 1",
      message: "Dispatched task 001 to Agent 1",
    });

    assert.ok(existsSync(join(tmpDir, ".tasks", "events.log")));
  });

  it("appends events as JSON lines", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      taskId: "001",
      message: "first",
    });
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:01:00Z",
      type: "completion",
      taskId: "001",
      message: "second",
    });

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.type, "dispatch");
    assert.strictEqual(events[1]!.type, "completion");
  });

  it("works without optional fields", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "error",
      message: "something broke",
    });

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.taskId, undefined);
    assert.strictEqual(events[0]!.agent, undefined);
  });
});

describe("readEvents", () => {
  it("returns empty array when log doesn't exist", () => {
    assert.deepStrictEqual(readEvents(tmpDir), []);
  });

  it("returns all event types", () => {
    const types: Array<OrchestratorEvent["type"]> = [
      "dispatch", "stall", "completion", "retry", "reconcile", "error",
    ];
    for (const type of types) {
      appendEvent(tmpDir, { timestamp: "2026-01-01T00:00:00Z", type, message: type });
    }

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 6);
    assert.deepStrictEqual(events.map((e) => e.type), types);
  });
});
