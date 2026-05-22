import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setCliActionBridgeDepsForTests } from "./lib/cli-action-bridge.ts";
import { taskCommand } from "./task.ts";
import { config } from "./config.ts";
import { skillCommand } from "./skill.ts";
import { makeGoal, makeMission, makeTask } from "./__tests__/support.ts";

let tmpDir = "";
let restoreBridge: (() => void) | null = null;
let restoreLog: (() => void) | null = null;
let logs: string[] = [];
let actionCalls: Array<{ name: string; body: unknown }> = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-cli-action-wrapper-"));
  logs = [];
  actionCalls = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  restoreLog = () => {
    console.log = originalLog;
  };
});

afterEach(() => {
  restoreBridge?.();
  restoreBridge = null;
  restoreLog?.();
  restoreLog = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

function actionNameFromUrl(url: string): string {
  return decodeURIComponent(url.split("/").pop() ?? "");
}

function installBridge(resultFor: (name: string) => unknown): void {
  restoreBridge = __setCliActionBridgeDepsForTests({
    cwd: () => tmpDir,
    readCanonicalDaemonInfo: () => ({
      pid: process.pid,
      port: 6060,
      version: "0.0.0-test",
      startedAt: "2026-01-01T00:00:00.000Z",
      bindHostname: "127.0.0.1",
      authToken: null,
    }),
    clearCanonicalDaemonInfo: () => {},
    isCanonicalDaemonAlive: async () => true,
    startEmbeddedDaemon: async () => {
      throw new Error("should not start fallback daemon");
    },
    fetch: async (url, init) => {
      const href = String(url);
      const name = actionNameFromUrl(href);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      actionCalls.push({ name, body });
      return Response.json({ ok: true, result: resultFor(name) });
    },
  });
}

describe("CLI action wrappers", () => {
  it("task mutations consult the action bridge before local fallback", async () => {
    installBridge(() => ({ taskId: "001", task: makeTask({ id: "001", title: "Via action" }) }));

    await taskCommand(tmpDir, {
      action: "task",
      sub: "create",
      args: ["Via action"],
      values: {},
      json: false,
    });

    expect(actionCalls).toEqual([{ name: "task.create", body: { title: "Via action" } }]);
    expect(existsSync(join(tmpDir, ".tasks", "tasks"))).toBe(false);
    expect(logs[0]).toContain("Created task 001");
  });

  it("mission mutations consult the action bridge before local fallback", async () => {
    installBridge(() => ({ mission: makeMission({ title: "Action mission" }) }));

    await taskCommand(tmpDir, {
      action: "mission",
      sub: "set",
      args: ["Action mission"],
      values: {},
      json: false,
    });

    expect(actionCalls).toEqual([{ name: "mission.set", body: { title: "Action mission" } }]);
    expect(existsSync(join(tmpDir, ".tasks", "mission.json"))).toBe(false);
  });

  it("goal mutations consult the action bridge before local fallback", async () => {
    installBridge(() => ({ goalId: "01", goal: makeGoal({ id: "01", title: "Action goal" }) }));

    await taskCommand(tmpDir, {
      action: "goal",
      sub: "create",
      args: ["Action goal"],
      values: {},
      json: false,
    });

    expect(actionCalls).toEqual([{ name: "goal.create", body: { title: "Action goal" } }]);
    expect(existsSync(join(tmpDir, ".tasks", "goals"))).toBe(false);
  });

  it("milestone mutations consult the action bridge before local fallback", async () => {
    installBridge(() => ({
      milestoneId: "M1",
      milestone: {
        id: "M1",
        title: "Action milestone",
        description: "",
        status: "active",
        order: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
      },
    }));

    await taskCommand(tmpDir, {
      action: "milestone",
      sub: "create",
      args: ["Action milestone"],
      values: {},
      json: false,
    });

    expect(actionCalls).toEqual([
      { name: "milestone.create", body: { title: "Action milestone" } },
    ]);
    expect(existsSync(join(tmpDir, ".tasks", "mission.json"))).toBe(false);
  });

  it("validation assert consults the action bridge before local fallback", async () => {
    installBridge(() => ({
      assertion: {
        id: "ASSERT01",
        status: "passing",
        verifiedBy: null,
        verifiedAt: "2026-01-01T00:00:00Z",
        evidence: null,
        blockedBy: null,
      },
    }));

    await taskCommand(tmpDir, {
      action: "validate",
      sub: "assert",
      args: ["ASSERT01"],
      values: { status: "passing" },
      json: false,
    });

    expect(actionCalls).toEqual([
      { name: "validation.assert", body: { assertId: "ASSERT01", status: "passing" } },
    ]);
    expect(existsSync(join(tmpDir, ".tasks", "validation-state.json"))).toBe(false);
  });

  it("config mutations consult the action bridge before local fallback", async () => {
    writeFileSync(join(tmpDir, "ide.yml"), "name: old\nrows:\n  - panes:\n      - title: Shell\n");
    installBridge(() => ({ config: { name: "new", rows: [{ panes: [{ title: "Shell" }] }] } }));

    await config(tmpDir, { action: "set", args: ["name", "new"], json: false });

    expect(actionCalls).toEqual([{ name: "config.set", body: { path: "name", value: "new" } }]);
    expect(readFileSync(join(tmpDir, "ide.yml"), "utf-8")).toContain("name: old");
  });

  it("skill mutations consult the action bridge before local fallback", async () => {
    installBridge(() => ({
      skill: {
        name: "worker",
        specialties: [],
        role: "teammate",
        description: "worker agent",
        body: "work",
      },
    }));

    await skillCommand(tmpDir, { sub: "create", args: ["worker"], json: false });

    expect(actionCalls[0]?.name).toBe("skill.create");
    expect(actionCalls[0]?.body).toMatchObject({ name: "worker" });
    expect(existsSync(join(tmpDir, ".tmux-ide", "skills", "worker.md"))).toBe(false);
  });
});
