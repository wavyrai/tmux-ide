import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAccounting,
  saveAccounting,
  recordTaskTime,
  formatDuration,
  type AccountingData,
} from "./token-tracker.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-tracker-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadAccounting", () => {
  it("returns empty data when no file exists", () => {
    const data = loadAccounting(tmpDir);
    expect(data.agents).toEqual({});
    expect(data.sessionStart).toBeTruthy();
    expect(data.updated).toBeTruthy();
  });

  it("loads existing accounting data", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    const saved: AccountingData = {
      agents: { "Agent 1": { totalTimeMs: 60000, taskCount: 2, lastTaskId: "002" } },
      sessionStart: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:01:00Z",
    };
    saveAccounting(tmpDir, saved);
    const loaded = loadAccounting(tmpDir);
    expect(loaded.agents["Agent 1"]!.totalTimeMs).toBe(60000);
    expect(loaded.agents["Agent 1"]!.taskCount).toBe(2);
  });
});

describe("saveAccounting", () => {
  it("creates .tasks/ directory if needed", () => {
    const data: AccountingData = {
      agents: {},
      sessionStart: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    saveAccounting(tmpDir, data);
    expect(existsSync(join(tmpDir, ".tasks", "accounting.json"))).toBeTruthy();
  });
});

describe("recordTaskTime", () => {
  it("creates agent entry on first recording", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    recordTaskTime(tmpDir, "Agent 1", "001", 30000);
    const data = loadAccounting(tmpDir);
    expect(data.agents["Agent 1"]!.totalTimeMs).toBe(30000);
    expect(data.agents["Agent 1"]!.taskCount).toBe(1);
    expect(data.agents["Agent 1"]!.lastTaskId).toBe("001");
  });

  it("accumulates time across multiple tasks", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    recordTaskTime(tmpDir, "Agent 1", "001", 30000);
    recordTaskTime(tmpDir, "Agent 1", "002", 45000);
    const data = loadAccounting(tmpDir);
    expect(data.agents["Agent 1"]!.totalTimeMs).toBe(75000);
    expect(data.agents["Agent 1"]!.taskCount).toBe(2);
    expect(data.agents["Agent 1"]!.lastTaskId).toBe("002");
  });

  it("tracks multiple agents independently", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    recordTaskTime(tmpDir, "Agent 1", "001", 30000);
    recordTaskTime(tmpDir, "Agent 2", "002", 60000);
    const data = loadAccounting(tmpDir);
    expect(data.agents["Agent 1"]!.totalTimeMs).toBe(30000);
    expect(data.agents["Agent 2"]!.totalTimeMs).toBe(60000);
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(300000)).toBe("5m 0s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
    expect(formatDuration(5400000)).toBe("1h 30m");
  });
});
