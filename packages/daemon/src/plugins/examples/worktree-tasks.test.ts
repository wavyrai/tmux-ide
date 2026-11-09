/**
 * The worktree-tasks example: its Lua against a stubbed `tmux-ide`, and once
 * end to end through the real host, sandbox and `tmux-ide worktree` on a
 * private tmux server (TMUX_TMPDIR in a temp dir) and a temp git repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { grantConsent, hashPluginDirectory } from "../consent.ts";
import { sandboxedArgv } from "../exec-sandbox.ts";
import { createHostCallHandler } from "../host-calls.ts";
import { PluginLuaState } from "../host/lua-state.ts";
import { PluginManifestSchemaZ } from "../manifest.ts";
import type { PluginLogEntry } from "../plugin-log.ts";
import { PluginSupervisor } from "../supervisor.ts";
import { WORKTREE_TASKS_INIT_LUA, WORKTREE_TASKS_MANIFEST } from "./worktree-tasks.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..", "..");
const limits = {
  callbackBudgetMs: 150,
  memoryBytes: 8 * 1024 * 1024,
  wallClockMs: 30_000,
  logLinesPerSecond: 100,
};
const callback = { budgetMs: 150, wallClockMs: 30_000 };

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const LIST = {
  repo: "/r",
  worktrees: [
    { path: "/r", branch: "main", primary: true, session: "r", running: true, status: "idle" },
    {
      path: "/r-worktrees/fix-login",
      branch: "fix-login",
      primary: false,
      session: "r@fix-login",
      running: true,
      status: "busy",
    },
    { path: "/r-worktrees/old", branch: "old", primary: false, running: false },
  ],
};

async function stubbed(answers: Record<string, unknown> = {}) {
  const calls: unknown[] = [];
  const state = await PluginLuaState.create({
    spec: { name: "worktree-tasks", includeRoots: [], moduleRoots: [], settings: {} },
    apiVersion: "1.0",
    productVersion: "9.9.9",
    limits,
    hostFunctions: {
      _exec: async ([request]) => {
        calls.push(request);
        const sub = (request as { args: string[] }).args[1]!;
        const answer = answers[sub] ?? LIST;
        return answer instanceof Error
          ? {
              code: 1,
              stdout: "",
              stderr: `${answer.message}\n`,
              timed_out: false,
              truncated: false,
            }
          : {
              code: 0,
              stdout: JSON.stringify(answer),
              stderr: "",
              timed_out: false,
              truncated: false,
            };
      },
    },
    hooks: { busy() {}, idle() {}, log() {}, trip() {}, actions() {} },
  });
  cleanups.push(() => state.close());
  await state.runSource(WORKTREE_TASKS_INIT_LUA, "=init.lua", callback);
  const invoke = async (id: string, args: Record<string, unknown>, ctx: object) =>
    (
      JSON.parse(
        await state.invokeAction(id, args, { source: "palette", ...ctx }, callback),
      ) as unknown[]
    )[0];
  const options = async (id: string, param: string, ctx: object) =>
    JSON.parse(
      await state.paramOptions(id, param, { source: "palette", ...ctx }, callback),
    ) as unknown;
  return { state, calls, invoke, options };
}

describe("worktree-tasks example", () => {
  it("has a valid manifest that asks only to run tmux-ide", () => {
    const manifest = PluginManifestSchemaZ.parse(WORKTREE_TASKS_MANIFEST);
    expect(manifest.capabilities).toEqual({ exec: ["tmux-ide"] });
  });

  it("runs tmux-ide worktree for the palette's session", async () => {
    const { calls, invoke } = await stubbed({
      create: { branch: "fix-login", path: "/r-worktrees/fix-login", session: "r@fix-login" },
      open: { branch: "fix-login", path: "/p", session: "r@fix-login", created: true },
      remove: { branch: "old", path: "/p", sessionKilled: false, removed: true },
    });
    // As from the TUI: a pane is known too, but the example does not use it.
    const ctx = { session: "r", pane: "%3" };
    expect(await invoke("new", { branch: "fix-login", from: "main" }, ctx)).toBe(
      "Started fix-login in session r@fix-login",
    );
    expect(await invoke("open", { task: "fix-login" }, ctx)).toBe("Opened r@fix-login");
    expect(await invoke("remove", { task: "old" }, ctx)).toBe("Removed old");
    expect(await invoke("list", {}, ctx)).toBe("fix-login · busy · r@fix-login\nold · no session");
    expect(calls).toEqual([
      {
        cmd: "tmux-ide",
        args: ["worktree", "create", "fix-login", "--from", "main", "--session", "r", "--json"],
      },
      { cmd: "tmux-ide", args: ["worktree", "open", "fix-login", "--session", "r", "--json"] },
      { cmd: "tmux-ide", args: ["worktree", "remove", "old", "--session", "r", "--json"] },
      { cmd: "tmux-ide", args: ["worktree", "list", "--session", "r", "--json"] },
    ]);
    // It never asks to run in a pane, so it needs no panes.send.
    expect(JSON.stringify(calls)).not.toContain("context");
  });

  it("offers the task worktrees, not the main checkout, as choices", async () => {
    const { options } = await stubbed();
    expect(await options("open", "task", { session: "r" })).toEqual({
      choices: [
        { value: "fix-login", label: "fix-login · busy · r@fix-login" },
        { value: "old", label: "old · no session" },
      ],
    });
  });

  it("says it needs a session, and passes tmux-ide's own errors on", async () => {
    const { calls, invoke } = await stubbed({
      remove: new Error("tmux-ide: worktree has changes; use --force"),
    });
    await expect(invoke("list", {}, { pane: "%3" })).rejects.toThrow(
      /Run this from a tmux-ide session/u,
    );
    expect(calls).toEqual([]);
    await expect(invoke("remove", { task: "old" }, { session: "r" })).rejects.toThrow(
      "tmux-ide: worktree has changes; use --force",
    );
    await expect(invoke("new", { branch: "-x" }, { session: "r" })).rejects.toThrow(
      /does not match/u,
    );
  });
});

const sandbox = sandboxedArgv(["true"], { stateHome: "/", writable: "/" }).ok;
const tmuxPath = (() => {
  try {
    return execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();
const hasTmux = tmuxPath !== null;

describe("worktree-tasks end to end", () => {
  (sandbox && hasTmux ? it : it.skip)(
    "starts, lists, opens and removes a task from the palette context alone",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tmux-ide-wt-tasks-"));
      const home = join(root, "home");
      const state = join(home, ".tmux-ide");
      const sockets = join(root, "tmux");
      const repo = join(root, "repo");
      const bin = join(root, "bin");
      for (const dir of [state, sockets, repo, bin]) mkdirSync(dir, { recursive: true });
      const env = {
        PATH: `${bin}:/usr/bin:/bin:${dirname(process.execPath)}:${dirname(tmuxPath ?? "/")}`,
        HOME: home,
        TMUX_IDE_HOME: state,
        TMUX_TMPDIR: sockets,
        LANG: "C",
      };
      const tmux = (...args: string[]) =>
        execFileSync("tmux", ["-f", "/dev/null", ...args], { env, encoding: "utf8" });
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      cleanups.push(() => {
        try {
          tmux("kill-server");
        } catch {
          // already gone
        }
      });
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env });
      git("init", "-q", "-b", "main");
      git(
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
      tmux("new-session", "-d", "-s", "demo", "-c", repo);
      // `tmux-ide` on the daemon's PATH: this checkout's CLI.
      const loader = join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs");
      writeFileSync(
        join(bin, "tmux-ide"),
        `#!/bin/sh\nexec "${process.execPath}" --import "${loader}" "${join(repoRoot, "bin", "cli.ts")}" "$@"\n`,
        { mode: 0o755 },
      );
      const dir = join(state, "plugins", "worktree-tasks");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(WORKTREE_TASKS_MANIFEST));
      writeFileSync(join(dir, "init.lua"), WORKTREE_TASKS_INIT_LUA);
      grantConsent(state, "worktree-tasks", hashPluginDirectory(dir));

      const logs: PluginLogEntry[] = [];
      const supervisor = new PluginSupervisor({
        stateHome: state,
        productVersion: "9.9.9",
        hostCommand: [process.execPath, "--import", "tsx", join(here, "..", "host", "entry.ts")],
        hostEnv: { ...process.env, ...env },
        onLog: (entry) => logs.push(entry),
        calls: createHostCallHandler({
          stateHome: state,
          endpoint: () => null,
          tmux: async () => "",
          baseEnv: () => env,
          secrets: () => new Set(),
          notify: async () => {},
        }),
      });
      cleanups.push(() => void supervisor.stop());
      await supervisor.start();
      // The Mac app's context: a session, no pane.
      const ctx = { source: "palette" as const, session: "demo" };
      expect(
        await supervisor.invokeAction("plugin.worktree-tasks.new", { branch: "fix-login" }, ctx),
        JSON.stringify(logs),
      ).toEqual({ ok: true, value: "Started fix-login in session repo@fix-login" });
      expect(existsSync(join(root, "repo-worktrees", "fix-login"))).toBe(true);
      expect(tmux("list-sessions", "-F", "#{session_name}")).toContain("repo@fix-login");
      expect(
        await supervisor.actionParamOptions("plugin.worktree-tasks.open", "task", ctx),
      ).toMatchObject({ ok: true, choices: [{ value: "fix-login" }] });
      expect(
        await supervisor.invokeAction("plugin.worktree-tasks.open", { task: "fix-login" }, ctx),
      ).toEqual({ ok: true, value: "Already open: repo@fix-login" });
      // Dangerous: refused unconfirmed, then removed.
      expect(
        (await supervisor.invokeAction("plugin.worktree-tasks.remove", { task: "fix-login" }, ctx))
          .ok,
      ).toBe(false);
      expect(
        await supervisor.invokeAction("plugin.worktree-tasks.remove", { task: "fix-login" }, ctx, {
          confirmed: true,
        }),
      ).toEqual({ ok: true, value: "Removed fix-login and closed its session" });
      expect(existsSync(join(root, "repo-worktrees", "fix-login"))).toBe(false);
      await supervisor.stop();
    },
    120_000,
  );
});
