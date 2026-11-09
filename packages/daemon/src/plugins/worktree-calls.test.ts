import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { cliRunner, worktreeCall, type WorktreeCallDependencies } from "./worktree-calls.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

function deps(overrides: Partial<WorktreeCallDependencies> = {}) {
  const tmux = vi.fn(async (args: readonly string[]) => {
    if (args[0] === "has-session" && args[2] === "=demo") return "";
    if (args[0] === "display-message" && args[3] === "=demo:")
      return "demo|/tmp/tmux-501/default,4242\n";
    throw new Error("can't find session");
  });
  const runCli = vi.fn(async (_args: readonly string[], _env: NodeJS.ProcessEnv) => ({
    code: 0,
    stdout: '{"branch":"fix-login","session":"repo@fix-login"}',
    stderr: "",
  }));
  return { tmux, runCli, ...overrides };
}

describe("ide.worktree on the daemon", () => {
  it("runs nothing for a plugin stopped during the session lookup", async () => {
    let alive = true;
    const d = deps();
    const tmux = d.tmux;
    const stopping = {
      ...d,
      tmux: vi.fn(async (args: readonly string[]) => {
        alive = false;
        return tmux(args);
      }),
      stillActive: () => alive,
    };
    await expect(worktreeCall("list", { session: "demo" }, stopping)).rejects.toThrow(
      "E_UNAVAILABLE: the plugin was stopped before this finished",
    );
    expect(d.runCli).not.toHaveBeenCalled();
  });

  it("runs tmux-ide worktree on the session's tmux server with checked arguments", async () => {
    const d = deps();
    expect(
      await worktreeCall("create", { session: "demo", branch: "fix/login-2", from: "main" }, d),
    ).toEqual({ branch: "fix-login", session: "repo@fix-login" });
    expect(d.tmux).toHaveBeenCalledWith(["has-session", "-t", "=demo"]);
    const [args, env] = d.runCli.mock.calls[0]!;
    expect(args).toEqual([
      "worktree",
      "create",
      "fix/login-2",
      "--from",
      "main",
      "--plain",
      "--session",
      "=demo:",
      "--require-session",
      "--json",
    ]);
    expect(env.TMUX).toBe("/tmp/tmux-501/default,4242,0");
    expect(env.TMUX_PANE).toBeUndefined();
    await worktreeCall("list", { session: "demo" }, d);
    expect(d.runCli.mock.calls[1]![0]).toEqual([
      "worktree",
      "list",
      "--session",
      "=demo:",
      "--require-session",
      "--json",
    ]);
    await worktreeCall("open", { session: "demo", branch: "x" }, d);
    expect(d.runCli.mock.calls[2]![0]).toContain("--plain");
    await worktreeCall("remove", { session: "demo", branch: "old" }, d);
    // Never --force: a worktree with changes is refused by tmux-ide itself.
    expect(d.runCli.mock.calls[3]![0]).toEqual([
      "worktree",
      "remove",
      "old",
      "--session",
      "=demo:",
      "--require-session",
      "--json",
    ]);
  });

  it("refuses branches, refs and sessions that are not plain names", async () => {
    const bad: [string, unknown, RegExp][] = [
      ["exec", { session: "demo" }, /supports list, create, open and remove/u],
      ["create", { session: "demo" }, /needs a branch/u],
      ["open", { session: "demo", branch: "a", from: "main" }, /only ide.worktree.create/u],
      ["create", { session: "demo", branch: "x", extra: 1 }, /E_INVALID/u],
      ["create", { branch: "x" }, /session/u],
    ];
    for (const branch of [
      "-x",
      "--force",
      "a..b",
      ".hidden",
      "a/.b",
      "a.lock",
      "a/",
      "a.",
      "a//b",
      "a b",
      "a;rm -rf ~",
      "$(id)",
      "a\u001bb",
      "x".repeat(201),
      "",
    ])
      bad.push(["create", { session: "demo", branch }, /E_INVALID: ide.worktree.create branch/u]);
    bad.push(["create", { session: "demo", branch: "ok", from: "--upload-pack=x" }, /from/u]);
    for (const session of [
      "-t",
      "a:b",
      "a.b",
      "a\u001bb",
      "a\u202eb",
      "",
      "pro*",
      "p?oj",
      "[p]roj",
      "#{session_name}",
      "=proj",
      "~proj",
      "$1",
      "%1",
    ])
      bad.push(["list", { session }, /E_INVALID: ide.worktree.list session/u]);
    for (const [op, request, error] of bad) {
      const d = deps();
      await expect(worktreeCall(op, request, d), JSON.stringify([op, request])).rejects.toThrow(
        error,
      );
      expect(d.tmux).not.toHaveBeenCalled();
      expect(d.runCli).not.toHaveBeenCalled();
    }
  });

  it("refuses a session that does not exist on the daemon's tmux server", async () => {
    const d = deps();
    await expect(worktreeCall("list", { session: "elsewhere" }, d)).rejects.toThrow(
      "E_NOT_FOUND: no tmux session 'elsewhere'",
    );
    expect(d.runCli).not.toHaveBeenCalled();
    // tmux 3.7c answers display-message even for an unknown session.
    const lenient = deps({
      tmux: vi.fn(async (args: readonly string[]) =>
        args[0] === "has-session" ? "" : "|/tmp/tmux-501/default,1\n",
      ),
    });
    await expect(worktreeCall("list", { session: "demo" }, lenient)).rejects.toThrow(
      /E_NOT_FOUND/u,
    );
    expect(lenient.runCli).not.toHaveBeenCalled();
  });

  it("passes tmux-ide's own refusal on, and refuses an unexpected answer", async () => {
    const refused = deps({
      runCli: vi.fn(async () => ({
        code: 1,
        stdout: "",
        stderr: "fatal: worktree contains modified files, use --force to delete it\n",
      })),
    });
    await expect(worktreeCall("remove", { session: "demo", branch: "x" }, refused)).rejects.toThrow(
      "E_FAILED: fatal: worktree contains modified files, use --force to delete it",
    );
    const odd = deps({ runCli: vi.fn(async () => ({ code: 0, stdout: "not json", stderr: "" })) });
    await expect(worktreeCall("list", { session: "demo" }, odd)).rejects.toThrow(
      "E_FAILED: tmux-ide worktree sent an unexpected answer",
    );
  });
});

const tmuxPath = (() => {
  try {
    return execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

describe("ide.worktree against real tmux", () => {
  (tmuxPath ? it : it.skip)(
    "finds only the exact session, on a private socket",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tmux-ide-wt-real-"));
      const socket = join(root, "s");
      const tmux = async (args: readonly string[]) =>
        execFileSync(tmuxPath!, ["-S", socket, "-f", "/dev/null", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      await tmux(["new-session", "-d", "-s", "proj", "-c", root]);
      try {
        const runCli = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
        for (const session of ["nope", "pro", "proj2", "Proj"])
          await expect(
            worktreeCall("list", { session }, { tmux, runCli }),
            session,
          ).rejects.toThrow(`E_NOT_FOUND: no tmux session '${session}'`);
        expect(runCli).not.toHaveBeenCalled();
        await worktreeCall("list", { session: "proj" }, { tmux, runCli });
        // The CLI itself, given a session that is not there, fails instead of
        // falling back to its own directory.
        const repo = join(here, "..", "..", "..", "..");
        const cli = cliRunner([
          process.execPath,
          "--import",
          join(repo, "node_modules", "tsx", "dist", "loader.mjs"),
          join(repo, "bin", "cli.ts"),
        ]);
        const pid = (await tmux(["display-message", "-p", "-t", "=proj:", "#{pid}"])).trim();
        const missing = await cli(
          ["worktree", "list", "--session", "=nope:", "--require-session", "--json"],
          { ...process.env, TMUX: `${socket},${pid},0` },
        );
        expect(missing.code).not.toBe(0);
        expect(missing.stderr + missing.stdout).toMatch(/No tmux session/u);
        expect(missing.stdout).not.toContain('"worktrees"');
        const [args, env] = runCli.mock.calls[0] as unknown as [string[], NodeJS.ProcessEnv];
        expect(args).toContain("=proj:");
        expect(env.TMUX).toMatch(
          new RegExp(`^${socket.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")},\\d+,0$`, "u"),
        );
      } finally {
        await tmux(["kill-server"]).catch(() => "");
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
