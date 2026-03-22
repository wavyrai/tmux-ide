import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
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

  it("skips corrupted lines and returns valid events", () => {
    const tasksDir = join(tmpDir, ".tasks");
    mkdirSync(tasksDir, { recursive: true });
    const logPath = join(tasksDir, "events.log");
    const validEvent = JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      message: "valid event",
    });
    // Write: valid line, corrupted line, another valid line
    writeFileSync(logPath, `${validEvent}\nnot json at all\n${validEvent}\n`);

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.message, "valid event");
    assert.strictEqual(events[1]!.message, "valid event");
  });

  it("reads events from both current and rotated log files", () => {
    const tasksDir = join(tmpDir, ".tasks");
    mkdirSync(tasksDir, { recursive: true });

    const oldEvent = JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      message: "old event",
    });
    const newEvent = JSON.stringify({
      timestamp: "2026-01-02T00:00:00Z",
      type: "completion",
      message: "new event",
    });

    writeFileSync(join(tasksDir, "events.log.1"), oldEvent + "\n");
    writeFileSync(join(tasksDir, "events.log"), newEvent + "\n");

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.message, "old event");
    assert.strictEqual(events[1]!.message, "new event");
  });
});

describe("log rotation", () => {
  it("rotates events.log when it exceeds 1MB", () => {
    const tasksDir = join(tmpDir, ".tasks");
    mkdirSync(tasksDir, { recursive: true });
    const logPath = join(tasksDir, "events.log");

    // Write a file just over 1MB directly
    const event = JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      taskId: "001",
      message: "x".repeat(200),
    });
    const lineSize = Buffer.byteLength(event + "\n");
    const linesNeeded = Math.ceil(1048577 / lineSize);
    writeFileSync(logPath, (event + "\n").repeat(linesNeeded));

    assert.ok(statSync(logPath).size > 1048576, "log should exceed 1MB before rotation");

    // Next appendEvent should trigger rotation
    appendEvent(tmpDir, {
      timestamp: "2026-01-02T00:00:00Z",
      type: "completion",
      taskId: "002",
      message: "trigger rotation",
    });

    // events.log should now be small (just the new event)
    assert.ok(statSync(logPath).size < 1024, "events.log should be small after rotation");

    // Rotated file should exist with the old content
    const rotatedPath = join(tasksDir, "events.log.1");
    assert.ok(existsSync(rotatedPath), "events.log.1 should exist");
    assert.ok(statSync(rotatedPath).size > 1048576, "rotated file should have old content");

    // readEvents should return events from both files
    const events = readEvents(tmpDir);
    assert.ok(events.length > linesNeeded, "should have events from both files");
    assert.strictEqual(events[events.length - 1]!.message, "trigger rotation");
  });

  it("does not rotate when file is under 1MB", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      message: "small event",
    });
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:01:00Z",
      type: "completion",
      message: "another small event",
    });

    const rotatedPath = join(tmpDir, ".tasks", "events.log.1");
    assert.ok(!existsSync(rotatedPath), "events.log.1 should not exist");

    const events = readEvents(tmpDir);
    assert.strictEqual(events.length, 2);
  });
});
