import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDispatchFile, LONG_MESSAGE_THRESHOLD } from "./send.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-send-test-"));
  mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeDispatchFile", () => {
  it("writes long message to dispatch file and returns trigger command", () => {
    const longMessage = "x".repeat(200);
    const result = writeDispatchFile(tmpDir, "%1", longMessage);

    expect(result).not.toBeNull();
    expect(result!.triggerCmd).toContain(".tasks/dispatch/");
    expect(result!.triggerCmd).toContain("send-1-");
    expect(existsSync(result!.filePath)).toBe(true);
    expect(readFileSync(result!.filePath, "utf-8")).toBe(longMessage);
  });

  it("returns null for short messages", () => {
    const result = writeDispatchFile(tmpDir, "%1", "hello");
    expect(result).toBeNull();
  });

  it("returns null for messages exactly at threshold", () => {
    const result = writeDispatchFile(tmpDir, "%1", "x".repeat(LONG_MESSAGE_THRESHOLD));
    expect(result).toBeNull();
  });

  it("creates dispatch directory if it does not exist", () => {
    const longMessage = "y".repeat(200);
    const result = writeDispatchFile(tmpDir, "%2", longMessage);
    expect(result).not.toBeNull();
    expect(existsSync(join(tmpDir, ".tasks", "dispatch"))).toBe(true);
  });

  it("creates unique filenames for different panes", () => {
    const msg = "z".repeat(200);
    const r1 = writeDispatchFile(tmpDir, "%1", msg);
    const r2 = writeDispatchFile(tmpDir, "%2", msg);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1!.filePath).not.toBe(r2!.filePath);
  });

  it("adds a random suffix so same-pane writes stay unique in the same millisecond", () => {
    const originalNow = Date.now;
    Date.now = () => 1234567890;
    try {
      const msg = "z".repeat(200);
      const r1 = writeDispatchFile(tmpDir, "%1", msg);
      const r2 = writeDispatchFile(tmpDir, "%1", msg);
      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1!.filePath).not.toBe(r2!.filePath);
    } finally {
      Date.now = originalNow;
    }
  });
});
