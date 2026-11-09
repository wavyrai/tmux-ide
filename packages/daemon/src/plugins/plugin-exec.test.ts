import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  darwinProfile,
  findOnPath,
  realPath,
  sandboxedArgv,
  writablePath,
} from "./exec-sandbox.ts";
import {
  EXEC_OUTPUT_CAP_BYTES,
  PluginPrograms,
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
    policy: {
      programs: ["echo", "env", "sleep", "head", "pwd", "cat", "tool"],
      shell: false,
      panes: false,
      ...policy,
    },
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

  it("lets a plugin set only harmless variables", async () => {
    for (const key of [
      "TMUX_IDE_HOME",
      "PATH",
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "NODE_OPTIONS",
      "PYTHONPATH",
      "PERL5OPT",
      "RUBYOPT",
      "GIT_SSH_COMMAND",
      "GIT_EXEC_PATH",
      "BASH_ENV",
      "ENV",
      "HOME",
      "SHELL",
      "GREETING",
    ])
      await expect(
        runPluginExec({ cmd: "env", env: { [key]: "/x" } }, deps()),
        key,
      ).rejects.toThrow(`E_DENIED: ide.exec may not set ${key};`);
    await expect(
      runPluginExec(
        {
          cmd: "nope-not-a-program",
          env: { LANG: "C", LC_ALL: "C", TERM: "xterm", NO_COLOR: "1", PLUGIN_MODE: "x" },
        },
        deps({ programs: "any" }),
      ),
    ).rejects.toThrow(/E_NOT_FOUND/u);
  });

  it("looks programs up on the daemon's PATH only, skipping relative entries", async () => {
    const evil = join(root, "evil");
    mkdirSync(evil);
    writeFileSync(join(evil, "echo"), "#!/bin/sh\necho hijacked\n", { mode: 0o755 });
    writeFileSync(join(evil, "tool"), "#!/bin/sh\necho hijacked\n", { mode: 0o755 });
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(join(plain, "tool"), "not executable");
    chmodSync(join(plain, "tool"), 0o644);
    // A relative entry that would find the planted program from this cwd.
    const rel = relative(process.cwd(), evil);
    expect(findOnPath("tool", `${evil}:/bin`)).toBe(join(evil, "tool"));
    expect(findOnPath("tool", `${rel}::.:${plain}`)).toBeNull();
    expect(findOnPath("echo", `${rel}:/bin`)).toBe("/bin/echo");
    // The request cannot bring its own PATH, so cannot pick evil/tool.
    await expect(runPluginExec({ cmd: "tool", env: { PATH: evil } }, deps())).rejects.toThrow(
      /may not set PATH/u,
    );
    await expect(runPluginExec({ cmd: "tool" }, deps())).rejects.toThrow(
      "E_NOT_FOUND: 'tool' is not on PATH",
    );
  });

  it("needs panes.send to run a program in a pane", async () => {
    await expect(runPluginExec({ cmd: "pwd", context: "%7" }, deps())).rejects.toThrow(
      "E_DENIED: running a program in a pane (context) needs the manifest capability 'panes.send'",
    );
  });

  it("refuses a data directory that was replaced by a symlink", async () => {
    mkdirSync(join(stateHome, "plugin-data"), { recursive: true });
    symlinkSync(stateHome, dataDir);
    await expect(runPluginExec({ cmd: "echo" }, deps())).rejects.toThrow(
      /E_UNAVAILABLE: the plugin's data directory is unusable: .* is not a real directory/u,
    );
  });

  it("validates the request", async () => {
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
    await expect(
      runPluginExec({ cmd: "echo", context: "%9" }, deps({ panes: true })),
    ).rejects.toThrow(/no tmux pane %9/u);
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
      const result = await runPluginExec({ cmd: "env", env: { PLUGIN_GREETING: "hi" } }, deps());
      const keys = result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0]!)
        .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
        .sort();
      expect(keys).toEqual(["HOME", "LANG", "PATH", "PLUGIN_GREETING"]);
      expect(result.stdout).not.toContain("daemon-secret-value");
    } finally {
      delete process.env.TMUX_IDE_EXEC_TEST_SECRET;
    }
  });

  live("runs in a pane's context: its cwd, TMUX and TMUX_PANE", async () => {
    const env = await runPluginExec({ cmd: "env", context: "%7" }, deps({ panes: true }));
    expect(env.stdout).toContain("TMUX=/tmp/sock,123,4\n");
    expect(env.stdout).toContain("TMUX_PANE=%7\n");
    const pwd = await runPluginExec({ cmd: "pwd", context: "%7" }, deps({ panes: true }));
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

  live("caps the timeout at the callback wall clock", async () => {
    const started = Date.now();
    const result = await runPluginExec(
      { cmd: "sleep", args: ["30"], timeout_ms: 60_000 },
      deps({}, { maxTimeoutMs: 300 }),
    );
    expect(result.timed_out).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  live("lets the daemon kill a plugin's running programs", async () => {
    const programs = new PluginPrograms();
    const started = Date.now();
    const running = runPluginExec(
      { cmd: "sleep 30 & sleep 30; wait", shell: true },
      deps({ shell: true }, { track: (child) => programs.track("tasks", child) }),
    );
    while (programs.running("tasks") === 0) await new Promise((r) => setTimeout(r, 10));
    expect(programs.kill("other")).toBe(0);
    expect(programs.kill("tasks")).toBe(1);
    const result = await running;
    expect(result.signal).toBe("SIGKILL");
    expect(programs.running("tasks")).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  live("cannot read the daemon's private files", async () => {
    writeFileSync(join(stateHome, "daemon.json"), "owner-secret-record");
    const result = await runPluginExec(
      { cmd: "cat", args: [join(stateHome, "daemon.json")] },
      deps(
        {},
        {
          sandbox: {
            stateHome,
            writable: dataDir,
            unreadable: [join(stateHome, "daemon.json")],
          },
        },
      ),
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("owner-secret-record");
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
    expect(
      darwinProfile(
        { ...paths, unreadable: ["/home/u/.tmux-ide/daemon.json", "/s/app.json"] },
        same,
      ),
    ).toBe(
      '(version 1)(allow default)(deny file-write* (subpath "/home/u/.tmux-ide"))' +
        '(allow file-write* (subpath "/home/u/.tmux-ide/plugin-data/tasks"))' +
        '(deny file-read* file-write* (subpath "/home/u/.tmux-ide/daemon.json"))' +
        '(deny file-read* file-write* (subpath "/s/app.json"))',
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

  it("never names a symlinked data dir's target as writable", () => {
    mkdirSync(join(stateHome, "plugin-data"), { recursive: true });
    symlinkSync(stateHome, dataDir);
    const sandbox = { stateHome, writable: dataDir };
    expect(writablePath(sandbox)).toBe(join(realPath(join(stateHome, "plugin-data")), "tasks"));
    expect(darwinProfile(sandbox)).not.toContain(
      `(allow file-write* (subpath "${realPath(stateHome)}"))`,
    );
  });

  it("is off on Linux unless the owner turns it on", () => {
    expect(
      sandboxedArgv(["/bin/echo"], paths, { platform: "linux", find: () => "/usr/bin/bwrap" }),
    ).toEqual({
      ok: false,
      reason:
        "running programs from plugins on Linux is untested and off; set TMUX_IDE_PLUGIN_EXEC_LINUX=1 for the daemon to turn it on",
    });
  });

  it("binds the state home read-only and the data dir writable with bubblewrap on Linux", () => {
    expect(
      sandboxedArgv(
        ["/bin/echo"],
        {
          ...paths,
          unreadable: ["/home/u/.tmux-ide/daemon.json", "/home/u/.tmux-ide/consent", "/gone"],
        },
        {
          platform: "linux",
          linuxOptIn: true,
          find: () => "/usr/bin/bwrap",
          resolve: (path) => path,
          exists: (path) => path !== "/gone",
        },
      ),
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
        "--ro-bind",
        "/dev/null",
        "/home/u/.tmux-ide/daemon.json",
        // Not a directory on this machine, so bound over like a file.
        "--ro-bind",
        "/dev/null",
        "/home/u/.tmux-ide/consent",
        "--unshare-pid",
        "--proc",
        "/proc",
        "--unshare-ipc",
        "--new-session",
        "--die-with-parent",
        "--",
        "/bin/echo",
      ],
    });
  });

  it("refuses without a sandbox tool", () => {
    expect(
      sandboxedArgv(["x"], paths, { platform: "linux", linuxOptIn: true, find: () => null }),
    ).toEqual({
      ok: false,
      reason: "running programs from plugins needs bubblewrap (bwrap) on Linux",
    });
    expect(sandboxedArgv(["x"], paths, { platform: "darwin", exists: () => false }).ok).toBe(false);
    expect(sandboxedArgv(["x"], paths, { platform: "win32" }).ok).toBe(false);
  });
});
