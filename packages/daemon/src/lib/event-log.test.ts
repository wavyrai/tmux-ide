import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { appendEvent, pruneEventLogs, readEvents, type OrchestratorEvent } from "./event-log.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-evlog-test-"));
});

afterEach(() => {
  delete process.env.TMUX_IDE_EVENT_LOG_MAX_BYTES;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("appendEvent", () => {
  it("creates .tasks/ and _events.jsonl if they don't exist", () => {
    appendEvent(tmpDir, {
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      taskId: "001",
      agent: "Agent 1",
      message: "Dispatched task 001 to Agent 1",
    });

    expect(existsSync(join(tmpDir, ".tasks", "_events.jsonl"))).toBeTruthy();
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
    const logPath = join(tasksDir, "_events.jsonl");
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

    writeFileSync(join(tasksDir, "_events-2026-01-01.jsonl.gz"), gzipSync(oldEvent + "\n"));
    writeFileSync(join(tasksDir, "_events.jsonl"), newEvent + "\n");

    const events = readEvents(tmpDir);
    expect(events.length).toBe(2);
    expect(events[0]!.message).toBe("old event");
    expect(events[1]!.message).toBe("new event");
  });
});

describe("log rotation", () => {
  it("rotates _events.jsonl when it exceeds the size cap", () => {
    process.env.TMUX_IDE_EVENT_LOG_MAX_BYTES = "2048";
    const tasksDir = join(tmpDir, ".tasks");
    mkdirSync(tasksDir, { recursive: true });
    const logPath = join(tasksDir, "_events.jsonl");

    const event = JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      type: "dispatch",
      taskId: "001",
      message: "x".repeat(200),
    });
    const lineSize = Buffer.byteLength(event + "\n");
    const linesNeeded = Math.ceil(2049 / lineSize);
    writeFileSync(logPath, (event + "\n").repeat(linesNeeded));

    expect(statSync(logPath).size > 2048).toBeTruthy();

    // Next appendEvent should trigger rotation
    appendEvent(tmpDir, {
      timestamp: "2026-01-02T00:00:00Z",
      type: "completion",
      taskId: "002",
      message: "trigger rotation",
    });

    // _events.jsonl should now be small (just the new event)
    expect(statSync(logPath).size < 1024).toBeTruthy();

    const rotatedPath = join(tasksDir, `_events-${new Date().toISOString().slice(0, 10)}.jsonl.gz`);
    expect(existsSync(rotatedPath)).toBeTruthy();
    expect(gunzipSync(readFileSync(rotatedPath)).byteLength > 2048).toBeTruthy();

    // readEvents should return events from both files
    const events = readEvents(tmpDir);
    expect(events.length > linesNeeded).toBeTruthy();
    expect(events[events.length - 1]!.message).toBe("trigger rotation");
  });

  it("does not rotate when file is under the cap", () => {
    process.env.TMUX_IDE_EVENT_LOG_MAX_BYTES = "2048";
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

    const rotations = readdirSync(join(tmpDir, ".tasks")).filter((file) =>
      file.startsWith("_events-"),
    );
    expect(rotations).toEqual([]);

    const events = readEvents(tmpDir);
    expect(events.length).toBe(2);
  });

  it("prunes rotated logs older than 30 days", () => {
    const tasksDir = join(tmpDir, ".tasks");
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, "_events-2026-01-01.jsonl.gz"), gzipSync(""));
    writeFileSync(join(tasksDir, "_events-2026-02-01.jsonl.gz"), gzipSync(""));

    pruneEventLogs(tmpDir, Date.parse("2026-02-05T00:00:00.000Z"));

    expect(existsSync(join(tasksDir, "_events-2026-01-01.jsonl.gz"))).toBe(false);
    expect(existsSync(join(tasksDir, "_events-2026-02-01.jsonl.gz"))).toBe(true);
  });
});
