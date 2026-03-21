import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
    assert.deepStrictEqual(data.agents, {});
    assert.ok(data.sessionStart);
    assert.ok(data.updated);
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
    assert.strictEqual(loaded.agents["Agent 1"]!.totalTimeMs, 60000);
    assert.strictEqual(loaded.agents["Agent 1"]!.taskCount, 2);
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
    assert.ok(existsSync(join(tmpDir, ".tasks", "accounting.json")));
  });
});

describe("recordTaskTime", () => {
  it("creates agent entry on first recording", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    recordTaskTime(tmpDir, "Agent 1", "001", 30000);
    const data = loadAccounting(tmpDir);
    assert.strictEqual(data.agents["Agent 1"]!.totalTimeMs, 30000);
    assert.strictEqual(data.agents["Agent 1"]!.taskCount, 1);
    assert.strictEqual(data.agents["Agent 1"]!.lastTaskId, "001");
  });

  it("accumulates time across multiple tasks", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    recordTaskTime(tmpDir, "Agent 1", "001", 30000);
    recordTaskTime(tmpDir, "Agent 1", "002", 45000);
    const data = loadAccounting(tmpDir);
    assert.strictEqual(data.agents["Agent 1"]!.totalTimeMs, 75000);
    assert.strictEqual(data.agents["Agent 1"]!.taskCount, 2);
    assert.strictEqual(data.agents["Agent 1"]!.lastTaskId, "002");
  });

  it("tracks multiple agents independently", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    recordTaskTime(tmpDir, "Agent 1", "001", 30000);
    recordTaskTime(tmpDir, "Agent 2", "002", 60000);
    const data = loadAccounting(tmpDir);
    assert.strictEqual(data.agents["Agent 1"]!.totalTimeMs, 30000);
    assert.strictEqual(data.agents["Agent 2"]!.totalTimeMs, 60000);
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    assert.strictEqual(formatDuration(5000), "5s");
    assert.strictEqual(formatDuration(45000), "45s");
  });

  it("formats minutes and seconds", () => {
    assert.strictEqual(formatDuration(90000), "1m 30s");
    assert.strictEqual(formatDuration(300000), "5m 0s");
  });

  it("formats hours and minutes", () => {
    assert.strictEqual(formatDuration(3600000), "1h 0m");
    assert.strictEqual(formatDuration(5400000), "1h 30m");
  });
});
