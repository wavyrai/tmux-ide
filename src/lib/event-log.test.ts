import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
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

    expect(existsSync(join(tmpDir, ".tasks", "events.log"))).toBeTruthy();
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
    expect(events.length).toBe(2);
    expect(events[0]!.type).toBe("dispatch");
    expect(events[1]!.type).toBe("completion");
  });

  it("works without optional fields", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "error",
      message: "something broke",
    });

    const events = readEvents(tmpDir);
    expect(events.length).toBe(1);
    expect(events[0]!.taskId).toBe(undefined);
    expect(events[0]!.agent).toBe(undefined);
  });
});

describe("readEvents", () => {
  it("returns empty array when log doesn't exist", () => {
    expect(readEvents(tmpDir)).toEqual([]);
  });

  it("returns all event types", () => {
    const types: Array<OrchestratorEvent["type"]> = [
      "dispatch",
      "stall",
      "completion",
      "retry",
      "reconcile",
      "error",
    ];
    for (const type of types) {
      appendEvent(tmpDir, { timestamp: "2026-01-01T00:00:00Z", type, message: type });
    }

    const events = readEvents(tmpDir);
    expect(events.length).toBe(6);
    expect(events.map((e) => e.type)).toEqual(types);
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
    expect(events.length).toBe(2);
    expect(events[0]!.message).toBe("valid event");
    expect(events[1]!.message).toBe("valid event");
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
    expect(events.length).toBe(2);
    expect(events[0]!.message).toBe("old event");
    expect(events[1]!.message).toBe("new event");
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

    expect(statSync(logPath).size > 1048576).toBeTruthy();

    // Next appendEvent should trigger rotation
    appendEvent(tmpDir, {
      timestamp: "2026-01-02T00:00:00Z",
      type: "completion",
      taskId: "002",
      message: "trigger rotation",
    });

    // events.log should now be small (just the new event)
    expect(statSync(logPath).size < 1024).toBeTruthy();

    // Rotated file should exist with the old content
    const rotatedPath = join(tasksDir, "events.log.1");
    expect(existsSync(rotatedPath)).toBeTruthy();
    expect(statSync(rotatedPath).size > 1048576).toBeTruthy();

    // readEvents should return events from both files
    const events = readEvents(tmpDir);
    expect(events.length > linesNeeded).toBeTruthy();
    expect(events[events.length - 1]!.message).toBe("trigger rotation");
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
    expect(!existsSync(rotatedPath)).toBeTruthy();

    const events = readEvents(tmpDir);
    expect(events.length).toBe(2);
  });
});
