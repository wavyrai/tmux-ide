import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceAlreadyExistsError,
  WorkspaceNotFoundError,
  WorkspaceRegistry,
  _setDefaultWorkspaceRegistryForTests,
} from "./workspace-registry.ts";

let dir: string;
const FIXED = new Date("2026-05-08T12:00:00.000Z");
const now = () => FIXED;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-wsreg-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  _setDefaultWorkspaceRegistryForTests(null);
});

describe("WorkspaceRegistry — add/list/get/remove round-trip", () => {
  it("starts empty when no file exists", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => [] });
    await reg.load();
    expect(reg.list()).toEqual([]);
    expect(reg.has("anything")).toBe(false);
    expect(reg.get("anything")).toBeNull();
  });

  it("add() persists to ~/.tmux-ide/workspaces.json and is round-trippable", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg.load();

    const ws = reg.add({
      name: "alpha",
      projectDir: "/tmp/alpha",
      ideConfigPath: "/tmp/alpha/ide.yml",
      now,
    });
    expect(ws.name).toBe("alpha");
    expect(ws.sessionName).toBe("alpha");
    expect(ws.addedAt).toBe(FIXED.toISOString());

    const file = JSON.parse(readFileSync(join(dir, "workspaces.json"), "utf-8")) as {
      version: number;
      workspaces: unknown[];
    };
    expect(file.version).toBe(1);
    expect(file.workspaces).toHaveLength(1);

    // Reload from disk: data survives.
    const reg2 = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg2.load();
    expect(reg2.list()).toHaveLength(1);
    expect(reg2.get("alpha")?.projectDir).toBe("/tmp/alpha");
  });

  it("add() rejects duplicates", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg.load();
    reg.add({ name: "alpha", projectDir: "/tmp/alpha", now });
    expect(() => reg.add({ name: "alpha", projectDir: "/tmp/alpha", now })).toThrow(
      WorkspaceAlreadyExistsError,
    );
  });

  it("remove() drops the entry and persists", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha", "beta"] });
    await reg.load();
    reg.add({ name: "alpha", projectDir: "/tmp/alpha", now });
    reg.add({ name: "beta", projectDir: "/tmp/beta", now });

    reg.remove("alpha");
    expect(reg.list().map((w) => w.name)).toEqual(["beta"]);

    const reg2 = new WorkspaceRegistry({ dir, listSessions: () => ["alpha", "beta"] });
    await reg2.load();
    expect(reg2.list().map((w) => w.name)).toEqual(["beta"]);
  });

  it("remove() throws when the workspace doesn't exist", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => [] });
    await reg.load();
    expect(() => reg.remove("ghost")).toThrow(WorkspaceNotFoundError);
  });
});

describe("WorkspaceRegistry — reconcile against tmux list-sessions", () => {
  it("drops workspaces whose tmux session disappeared", async () => {
    // Seed the disk with two workspaces; tmux only reports one alive.
    const seed = new WorkspaceRegistry({ dir, listSessions: () => ["alpha", "beta"] });
    await seed.load();
    seed.add({ name: "alpha", projectDir: "/tmp/alpha", now });
    seed.add({ name: "beta", projectDir: "/tmp/beta", now });
    expect(seed.list()).toHaveLength(2);

    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg.load();
    expect(reg.list().map((w) => w.name)).toEqual(["alpha"]);

    // The cleanup is persisted so a fresh registry stays clean even if
    // tmux later reports beta again.
    const file = JSON.parse(readFileSync(join(dir, "workspaces.json"), "utf-8")) as {
      workspaces: { name: string }[];
    };
    expect(file.workspaces.map((w) => w.name)).toEqual(["alpha"]);
  });

  it("keeps all workspaces when tmux throws (defers cleanup until tmux is reachable)", async () => {
    const seed = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await seed.load();
    seed.add({ name: "alpha", projectDir: "/tmp/alpha", now });

    const reg = new WorkspaceRegistry({
      dir,
      listSessions: () => {
        throw new Error("tmux unreachable");
      },
    });
    await reg.load();
    expect(reg.list().map((w) => w.name)).toEqual(["alpha"]);
  });

  it("file write is atomic — no .tmp file lingering after add()", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg.load();
    reg.add({ name: "alpha", projectDir: "/tmp/alpha", now });

    expect(existsSync(join(dir, "workspaces.json"))).toBe(true);
    expect(existsSync(join(dir, "workspaces.json.tmp"))).toBe(false);
  });
});

describe("WorkspaceRegistry — events", () => {
  it("emits workspace.added on add()", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg.load();
    let received: { name: string } | null = null;
    reg.on("workspace.added", (ws) => {
      received = ws as { name: string };
    });
    reg.add({ name: "alpha", projectDir: "/tmp/alpha", now });
    expect(received).not.toBeNull();
    expect(received!.name).toBe("alpha");
  });

  it("emits workspace.removed on remove()", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => ["alpha"] });
    await reg.load();
    reg.add({ name: "alpha", projectDir: "/tmp/alpha", now });

    let removedName: string | null = null;
    reg.on("workspace.removed", (name) => {
      removedName = name as string;
    });
    reg.remove("alpha");
    expect(removedName).toBe("alpha");
  });
});

describe("WorkspaceRegistry — load idempotence + isLoaded", () => {
  it("_isLoaded() reports false before load() and true after", async () => {
    const reg = new WorkspaceRegistry({ dir, listSessions: () => [] });
    expect(reg._isLoaded()).toBe(false);
    await reg.load();
    expect(reg._isLoaded()).toBe(true);
  });

  it("calling load() twice re-reconciles", async () => {
    const seed = new WorkspaceRegistry({ dir, listSessions: () => ["alpha", "beta"] });
    await seed.load();
    seed.add({ name: "alpha", projectDir: "/tmp/alpha", now });
    seed.add({ name: "beta", projectDir: "/tmp/beta", now });

    let live = ["alpha", "beta"];
    const reg = new WorkspaceRegistry({ dir, listSessions: () => live });
    await reg.load();
    expect(reg.list()).toHaveLength(2);

    live = ["alpha"];
    await reg.load();
    expect(reg.list().map((w) => w.name)).toEqual(["alpha"]);
  });
});
