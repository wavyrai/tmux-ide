import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { darwinProfile, realPath, sandboxedArgv } from "./exec-sandbox.ts";
import {
  EXEC_OUTPUT_CAP_BYTES,
  runPluginExec,
  type ExecDependencies,
  type ExecPolicy,
} from "./plugin-exec.ts";

const sandboxAvailable = sandboxedArgv(["true"], { stateHome: "/", writable: "/" }).ok;
const live = sandboxAvailable ? it : it.skip;

let root: string;
let stateHome: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tmux-ide-exec-"));
  stateHome = join(root, "home");
  dataDir = join(stateHome, "plugin-data", "tasks");
  mkdirSync(join(stateHome, "consent"), { recursive: true });
  writeFileSync(join(stateHome, "consent", "plugins.json"), "original");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function deps(
  policy: Partial<ExecPolicy> = {},
  overrides: Partial<ExecDependencies> = {},
): ExecDependencies {
  return {
    policy: { programs: ["echo", "env", "sleep", "head", "pwd"], shell: false, ...policy },
    sandbox: { stateHome, writable: dataDir },
    baseEnv: { PATH: "/usr/bin:/bin", HOME: root, LANG: "C" },
    resolvePane: async (pane) =>
      pane === "%7" ? { tmux: "/tmp/sock,123,4", pane: "%7", cwd: root } : null,
    secrets: () => new Set(["owner-token-0123456789"]),
    ...overrides,
  };
}

describe("ide.exec policy", () => {
  it("refuses programs outside the manifest, paths and command lines", async () => {
    await expect(runPluginExec({ cmd: "ls" }, deps())).rejects.toThrow(
      /E_DENIED: this plugin may not run 'ls'/u,
    );
    await expect(runPluginExec({ cmd: "/bin/echo" }, deps())).rejects.toThrow(
      /must be a program name/u,
    );
    await expect(runPluginExec({ cmd: "echo hi" }, deps())).rejects.toThrow(
      /must be a program name/u,
    );
  });

  it("refuses a shell unless the manifest grants it", async () => {
    await expect(runPluginExec({ cmd: "echo hi", shell: true }, deps())).rejects.toThrow(
      /may not run shell commands/u,
    );
  });

  it("refuses to set TMUX_IDE_ variables and validates the request", async () => {
    await expect(
      runPluginExec({ cmd: "env", env: { TMUX_IDE_HOME: "/x" } }, deps()),
    ).rejects.toThrow(/E_DENIED/u);
    await expect(runPluginExec({ cmd: "echo", cwd: "relative" }, deps())).rejects.toThrow(
      /absolute path/u,
    );
    await expect(runPluginExec({ cmd: "echo", timeout_ms: 10_000_000 }, deps())).rejects.toThrow(
      /E_INVALID/u,
    );
    await expect(
      runPluginExec({ cmd: "echo", context: "pane.mirror.0a1b2c3d4e5f6a7b" }, deps()),
    ).rejects.toThrow(
      "E_INVALID: ide.exec context: must be a tmux pane id like %3; ctx.pane is set only when the caller knows one",
    );
    await expect(runPluginExec({ cmd: "echo", extra: 1 }, deps())).rejects.toThrow(/E_INVALID/u);
    await expect(runPluginExec({ cmd: "echo", context: "%9" }, deps())).rejects.toThrow(
      /no tmux pane %9/u,
    );
  });

  it("refuses to run anything without a sandbox", async () => {
    await expect(
      runPluginExec(
        { cmd: "echo" },
        deps({}, { plan: () => ({ ok: false, reason: "no sandbox here" }) }),
      ),
    ).rejects.toThrow("E_UNAVAILABLE: no sandbox here");
  });
});

describe("ide.exec running programs", () => {
  live("passes arguments without a shell, and returns status and output", async () => {
    const result = await runPluginExec(
      { cmd: "echo", args: ["a; rm -rf ~", "$HOME", "`id`"] },
      deps(),
    );
    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "a; rm -rf ~ $HOME `id`\n",
      stderr: "",
      timed_out: false,
      truncated: false,
    });
  });

  live("runs a shell command when the manifest grants it", async () => {
    const result = await runPluginExec(
      { cmd: 'printf "%s-%s" "$1" "$2"; exit 3', args: ["x", "y"], shell: true },
      deps({ shell: true }),
    );
    expect(result).toMatchObject({ code: 3, stdout: "x-y" });
  });

  live("starts from the minimal environment plus what the plugin sets", async () => {
    process.env.TMUX_IDE_EXEC_TEST_SECRET = "daemon-secret-value";
    try {
      const result = await runPluginExec({ cmd: "env", env: { GREETING: "hi" } }, deps());
      const keys = result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0]!)
        .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
        .sort();
      expect(keys).toEqual(["GREETING", "HOME", "LANG", "PATH"]);
      expect(result.stdout).not.toContain("daemon-secret-value");
    } finally {
      delete process.env.TMUX_IDE_EXEC_TEST_SECRET;
    }
  });

  live("runs in a pane's context: its cwd, TMUX and TMUX_PANE", async () => {
    const env = await runPluginExec({ cmd: "env", context: "%7" }, deps());
    expect(env.stdout).toContain("TMUX=/tmp/sock,123,4\n");
    expect(env.stdout).toContain("TMUX_PANE=%7\n");
    const pwd = await runPluginExec({ cmd: "pwd", context: "%7" }, deps());
    expect(pwd.stdout.trim()).toBe(realPath(root));
  });

  live("kills the whole process group at the timeout", async () => {
    const started = Date.now();
    const result = await runPluginExec(
      { cmd: "sleep 30 & sleep 30; wait", shell: true, timeout_ms: 300 },
      deps({ shell: true }),
    );
    expect(result.timed_out).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  live("caps captured output", async () => {
    const result = await runPluginExec(
      { cmd: "head", args: ["-c", String(EXEC_OUTPUT_CAP_BYTES * 3), "/dev/zero"] },
      deps(),
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(EXEC_OUTPUT_CAP_BYTES * 2);
    expect(result.code).toBe(0);
  });

  live("redacts daemon secrets in output", async () => {
    const result = await runPluginExec(
      { cmd: "echo", args: ["token owner-token-0123456789"] },
      deps(),
    );
    expect(result.stdout).toBe("token [redacted]\n");
  });

  live(
    "cannot write consent records or anything else under the state home, except its data dir",
    async () => {
      const result = await runPluginExec(
        {
          cmd: [
            `echo forged > "${join(stateHome, "consent", "plugins.json")}"`,
            `echo planted > "${join(stateHome, "init.lua")}"`,
            `mv "${join(stateHome, "consent")}" "${join(stateHome, "moved")}"`,
            `echo kept > "${join(dataDir, "cache.txt")}"`,
            "true",
          ].join("; "),
          shell: true,
        },
        deps({ shell: true }),
      );
      expect(result.code).toBe(0);
      expect(readFileSync(join(stateHome, "consent", "plugins.json"), "utf8")).toBe("original");
      expect(() => readFileSync(join(stateHome, "init.lua"))).toThrow();
      expect(readFileSync(join(dataDir, "cache.txt"), "utf8")).toBe("kept\n");
    },
  );
});

describe("sandbox plans", () => {
  const paths = { stateHome: "/home/u/.tmux-ide", writable: "/home/u/.tmux-ide/plugin-data/tasks" };

  it("denies writes under the state home except the data dir on macOS", () => {
    const same = (path: string) => path;
    expect(darwinProfile(paths, same)).toBe(
      '(version 1)(allow default)(deny file-write* (subpath "/home/u/.tmux-ide"))' +
        '(allow file-write* (subpath "/home/u/.tmux-ide/plugin-data/tasks"))',
    );
    expect(darwinProfile({ stateHome: '/a"b\\c', writable: "/w" })).toContain(
      '(subpath "/a\\"b\\\\c")',
    );
    expect(
      sandboxedArgv(["/bin/echo", "x"], paths, { platform: "darwin", exists: () => true }),
    ).toEqual({
      ok: true,
      argv: ["/usr/bin/sandbox-exec", "-p", darwinProfile(paths), "/bin/echo", "x"],
    });
  });

  it("binds the state home read-only and the data dir writable with bubblewrap on Linux", () => {
    expect(
      sandboxedArgv(["/bin/echo"], paths, {
        platform: "linux",
        find: () => "/usr/bin/bwrap",
        resolve: (path) => path,
      }),
    ).toEqual({
      ok: true,
      argv: [
        "/usr/bin/bwrap",
        "--dev-bind",
        "/",
        "/",
        "--ro-bind",
        paths.stateHome,
        paths.stateHome,
        "--bind",
        paths.writable,
        paths.writable,
        "--die-with-parent",
        "--",
        "/bin/echo",
      ],
    });
  });

  it("refuses without a sandbox tool", () => {
    expect(sandboxedArgv(["x"], paths, { platform: "linux", find: () => null })).toEqual({
      ok: false,
      reason: "running programs from plugins needs bubblewrap (bwrap) on Linux",
    });
    expect(sandboxedArgv(["x"], paths, { platform: "darwin", exists: () => false }).ok).toBe(false);
    expect(sandboxedArgv(["x"], paths, { platform: "win32" }).ok).toBe(false);
  });
});
