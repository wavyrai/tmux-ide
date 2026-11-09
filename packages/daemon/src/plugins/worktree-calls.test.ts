import { describe, expect, it, vi } from "vitest";
import { worktreeCall, type WorktreeCallDependencies } from "./worktree-calls.ts";

function deps(overrides: Partial<WorktreeCallDependencies> = {}) {
  const tmux = vi.fn(async (args: readonly string[]) => {
    if (args.includes("=demo:")) return "/tmp/tmux-501/default,4242\n";
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
  it("runs tmux-ide worktree on the session's tmux server with checked arguments", async () => {
    const d = deps();
    expect(
      await worktreeCall("create", { session: "demo", branch: "fix/login-2", from: "main" }, d),
    ).toEqual({ branch: "fix-login", session: "repo@fix-login" });
    expect(d.tmux).toHaveBeenCalledWith([
      "display-message",
      "-p",
      "-t",
      "=demo:",
      "#{socket_path},#{pid}",
    ]);
    const [args, env] = d.runCli.mock.calls[0]!;
    expect(args).toEqual([
      "worktree",
      "create",
      "fix/login-2",
      "--from",
      "main",
      "--session",
      "demo",
      "--json",
    ]);
    expect(env.TMUX).toBe("/tmp/tmux-501/default,4242,0");
    expect(env.TMUX_PANE).toBeUndefined();
    await worktreeCall("list", { session: "demo" }, d);
    expect(d.runCli.mock.calls[1]![0]).toEqual(["worktree", "list", "--session", "demo", "--json"]);
    await worktreeCall("remove", { session: "demo", branch: "old" }, d);
    // Never --force: a worktree with changes is refused by tmux-ide itself.
    expect(d.runCli.mock.calls[2]![0]).toEqual([
      "worktree",
      "remove",
      "old",
      "--session",
      "demo",
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
    for (const session of ["-t", "a:b", "a.b", "a\u001bb", "a\u202eb", ""])
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
    const odd = deps({ tmux: vi.fn(async () => "garbage\n") });
    await expect(worktreeCall("list", { session: "demo" }, odd)).rejects.toThrow(/E_NOT_FOUND/u);
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
