import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  darwinProfile,
  findOnPath,
  immovable,
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
const tmuxPath = (() => {
  try {
    return execFileSync("/usr/bin/which", ["tmux"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();
const hasTmux = tmuxPath !== null;
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

  it("starts nothing if the plugin was stopped while it looked up the pane", async () => {
    let allowed = true;
    let spawned = 0;
    const result = runPluginExec(
      { cmd: "pwd", context: "%7" },
      deps(
        { panes: true },
        {
          resolvePane: async (pane) => {
            // A disable lands during the tmux lookup.
            allowed = false;
            return { tmux: "/tmp/sock,1,2", pane, cwd: root };
          },
          stillAllowed: () => allowed,
          plan: (command) => ({ ok: true, argv: command }),
          spawn: (() => {
            spawned += 1;
            throw new Error("must not spawn");
          }) as never,
        },
      ),
    );
    await expect(result).rejects.toThrow(
      "E_UNAVAILABLE: the plugin was stopped before its program started",
    );
    expect(spawned).toBe(0);
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

  live("gets TMUX_TMPDIR only with panes.send", async () => {
    const base = { PATH: "/usr/bin:/bin", HOME: root, TMUX_TMPDIR: "/tmp/elsewhere" };
    const without = await runPluginExec({ cmd: "env" }, deps({}, { baseEnv: base }));
    expect(without.stdout).not.toContain("TMUX_TMPDIR");
    const granted = await runPluginExec({ cmd: "env" }, deps({ panes: true }, { baseEnv: base }));
    expect(granted.stdout).toContain("TMUX_TMPDIR=/tmp/elsewhere\n");
  });

  (hasTmux ? live : it.skip)(
    "cannot type into a pane with a granted tmux-ide without panes.send",
    async () => {
      // A private server whose session matches the cwd's name, as `tmux-ide
      // send` wants; TMUX names its socket, so nothing else is reachable.
      const sockets = join(root, "tmux-sockets");
      const project = join(root, "proj");
      mkdirSync(sockets);
      mkdirSync(project);
      const socket = join(sockets, "default");
      const tmux = (...args: string[]) =>
        execFileSync(tmuxPath!, ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
      tmux("new-session", "-d", "-s", "proj", "-c", project);
      try {
        const pid = tmux("display-message", "-p", "-t", "proj", "#{pid}").trim();
        const repo = join(here, "..", "..", "..", "..");
        const send = (panes: boolean, marker: string) =>
          runPluginExec(
            {
              cmd: "node",
              args: [
                "--import",
                join(repo, "node_modules", "tsx", "dist", "loader.mjs"),
                join(repo, "bin", "cli.ts"),
                "send",
                "%0",
                `echo ${marker}`,
              ],
              cwd: project,
              timeout_ms: 30_000,
            },
            deps(
              { programs: ["node"], panes },
              {
                baseEnv: {
                  PATH: `/usr/bin:/bin:${dirname(process.execPath)}:${dirname(tmuxPath!)}`,
                  HOME: root,
                  TMUX_IDE_HOME: stateHome,
                  TMUX: `${socket},${pid},0`,
                },
                sandbox: { stateHome, writable: dataDir, tmuxSockets: panes ? [] : [sockets] },
              },
            ),
          );
        const refused = await send(false, "REFUSED-MARK");
        expect(refused.code).not.toBe(0);
        const allowed = await send(true, "ALLOWED-MARK");
        expect(allowed.code, allowed.stderr).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const screen = tmux("capture-pane", "-p", "-t", "proj");
        expect(screen).toContain("ALLOWED-MARK");
        expect(screen).not.toContain("REFUSED-MARK");
      } finally {
        tmux("kill-server");
      }
    },
    60_000,
  );

  (hasTmux ? live : it.skip)(
    "cannot move the socket directories or the control socket out from under the rules",
    async () => {
      const parent = join(root, "tt");
      const sockets = join(parent, "tmux-501");
      mkdirSync(sockets, { recursive: true });
      const socket = join(sockets, "default");
      execFileSync(tmuxPath!, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "x"]);
      const controlDir = join(root, "ctl");
      mkdirSync(controlDir);
      const control = join(controlDir, "control.sock");
      writeFileSync(control, "");
      try {
        const script = [
          `mv "${sockets}" "${join(parent, "moved")}" && tmux -S "${join(parent, "moved", "default")}" ls && echo REACHED-MOVED`,
          `mv "${parent}" "${join(root, "tt2")}" && tmux -S "${join(root, "tt2", "tmux-501", "default")}" ls && echo REACHED-PARENT`,
          `mv "${control}" "${join(controlDir, "elsewhere")}" && echo MOVED-CONTROL`,
          `mv "${controlDir}" "${join(root, "ctl2")}" && echo MOVED-CONTROL-DIR`,
          "true",
        ].join("; ");
        const result = await runPluginExec(
          { cmd: script, shell: true },
          deps(
            { shell: true },
            {
              baseEnv: { PATH: `/usr/bin:/bin:${dirname(tmuxPath!)}`, HOME: root },
              sandbox: {
                stateHome,
                writable: dataDir,
                tmuxSockets: [sockets],
                privateSockets: [control],
              },
            },
          ),
        );
        expect(result.stdout).not.toMatch(/REACHED|MOVED/u);
        expect(existsSync(socket)).toBe(true);
        expect(existsSync(control)).toBe(true);
      } finally {
        execFileSync(tmuxPath!, ["-S", socket, "kill-server"]);
      }
    },
  );

  live("cannot move a custom state home, or a directory above it, to write into it", async () => {
    // TMUX_IDE_HOME under a temp directory the user owns: the rename trick.
    const consent = join(stateHome, "consent", "plugins.json");
    const moved = `${root}.x`;
    const script = [
      `mv "${root}" "${moved}" && echo PWN > "${join(moved, "home", "consent", "plugins.json")}" && echo WROTE-VIA-ROOT; mv "${moved}" "${root}"`,
      `mv "${stateHome}" "${stateHome}.x" && echo PWN > "${stateHome}.x/consent/plugins.json" && echo WROTE-VIA-HOME; mv "${stateHome}.x" "${stateHome}"`,
      `mv "${join(stateHome, "consent")}" "${join(root, "c")}" && echo MOVED-CONSENT`,
      "true",
    ].join("; ");
    const result = await runPluginExec({ cmd: script, shell: true }, deps({ shell: true }));
    expect(result.stdout).not.toMatch(/WROTE|MOVED/u);
    expect(readFileSync(consent, "utf8")).toBe("original");
    expect(existsSync(moved)).toBe(false);
  });

  live("cannot connect to the daemon's port or control socket", async () => {
    const http = createHttpServer((_request, response) => response.end("daemon-answer"));
    await new Promise<void>((resolve) => http.listen(0, "0.0.0.0", () => resolve()));
    const port = (http.address() as { port: number }).port;
    const controlPath = join(root, "control.sock");
    const control = createNetServer((socket) => socket.end("control-answer"));
    await new Promise<void>((resolve) => control.listen(controlPath, () => resolve()));
    try {
      const sandbox = {
        stateHome,
        writable: dataDir,
        privateSockets: [controlPath],
        daemonPorts: [port],
      };
      const curl = (args: string[], paths: object) =>
        runPluginExec(
          { cmd: "curl", args: ["-s", "-m", "3", ...args] },
          deps({ programs: ["curl"] }, { sandbox: paths as never }),
        );
      for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
        const refused = await curl([url], sandbox);
        expect(refused.stdout, url).not.toContain("daemon-answer");
      }
      const unix = await curl(["--unix-socket", controlPath, "http://x/"], sandbox);
      expect(unix.stdout).not.toContain("control-answer");
      // The same calls without those rules get through.
      const open = await curl([`http://127.0.0.1:${port}/`], { stateHome, writable: dataDir });
      expect(open.stdout).toBe("daemon-answer");
    } finally {
      http.close();
      control.close();
    }
  });

  (hasTmux ? live : it.skip)("cannot reach a tmux server's socket without panes.send", async () => {
    const sockets = join(root, "tmux-sockets");
    mkdirSync(sockets);
    const socket = join(sockets, "default");
    execFileSync(tmuxPath!, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "x"]);
    try {
      const sandbox = { stateHome, writable: dataDir, tmuxSockets: [sockets] };
      const run = (policy: Partial<ExecPolicy>, tmuxSockets: string[]) =>
        runPluginExec(
          { cmd: "tmux", args: ["-S", socket, "list-sessions", "-F", "#{session_name}"] },
          deps(
            { programs: ["tmux"], ...policy },
            {
              baseEnv: { PATH: `/usr/bin:/bin:${dirname(tmuxPath!)}`, HOME: root },
              sandbox: { ...sandbox, tmuxSockets },
            },
          ),
        );
      const refused = await run({}, [sockets]);
      expect(refused.code).not.toBe(0);
      expect(refused.stdout).not.toContain("x");
      // Through a symlink elsewhere: still the socket's real path, still refused.
      symlinkSync(socket, join(dataDir, "s"));
      const linked = await runPluginExec(
        { cmd: "tmux", args: ["-S", join(dataDir, "s"), "list-sessions"] },
        deps(
          { programs: ["tmux"] },
          { baseEnv: { PATH: `/usr/bin:/bin:${dirname(tmuxPath!)}`, HOME: root }, sandbox },
        ),
      );
      expect(linked.code).not.toBe(0);
      // With panes.send no socket directory is kept from it.
      const allowed = await run({ panes: true }, []);
      expect(allowed.stdout).toBe("x\n");
    } finally {
      execFileSync(tmuxPath!, ["-S", socket, "kill-server"]);
    }
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

  live("kills only the programs a request started when asked to", async () => {
    const programs = new PluginPrograms();
    const start = (origin?: string) =>
      runPluginExec(
        { cmd: "sleep 30 & sleep 30; wait", shell: true },
        deps({ shell: true }, { track: (child) => programs.track("tasks", child, origin) }),
      );
    const fromInvoke = start("request-1");
    const fromTimer = start();
    while (programs.running("tasks") < 2) await new Promise((r) => setTimeout(r, 10));
    expect(programs.kill("tasks", "request-2")).toBe(0);
    expect(programs.kill("tasks", "request-1")).toBe(1);
    expect((await fromInvoke).signal).toBe("SIGKILL");
    expect(programs.running("tasks")).toBe(1);
    expect(programs.kill("tasks")).toBe(1);
    expect((await fromTimer).signal).toBe("SIGKILL");
  });

  live("cannot read the daemon's private files, their temporary siblings included", async () => {
    const info = join(root, "info-dir");
    mkdirSync(info);
    const files = [
      "daemon.json",
      "daemon.json.claim-1.0b5e.tmp",
      "daemon.json.claim-1.0b5e.retired",
    ];
    for (const name of files) writeFileSync(join(info, name), `owner-secret-record ${name}`);
    writeFileSync(join(info, "other.json"), "readable");
    const sandbox = { stateHome, writable: dataDir, unreadable: [join(info, "daemon.json")] };
    for (const name of files) {
      const result = await runPluginExec(
        { cmd: "cat", args: [join(info, name)] },
        deps({}, { sandbox }),
      );
      expect(result.code, name).not.toBe(0);
      expect(result.stdout).not.toContain("owner-secret-record");
    }
    const other = await runPluginExec(
      { cmd: "cat", args: [join(info, "other.json")] },
      deps({}, { sandbox }),
    );
    expect(other.stdout).toBe("readable");
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
    const pins = (...paths: string[]) =>
      paths.map((path) => `(deny file-write* (literal "${path}"))`).join("");
    expect(darwinProfile(paths, same)).toBe(
      '(version 1)(allow default)(deny file-write* (subpath "/home/u/.tmux-ide"))' +
        '(allow file-write* (subpath "/home/u/.tmux-ide/plugin-data/tasks"))' +
        pins("/home/u/.tmux-ide", "/home/u", "/home"),
    );
    expect(
      darwinProfile(
        { ...paths, unreadable: ["/home/u/.tmux-ide/daemon.json", "/s/app.json"] },
        same,
      ),
    ).toBe(
      '(version 1)(allow default)(deny file-write* (subpath "/home/u/.tmux-ide"))' +
        '(allow file-write* (subpath "/home/u/.tmux-ide/plugin-data/tasks"))' +
        '(deny file-read* file-write* (regex #"^/home/u/\\.tmux-ide/daemon\\.json"))' +
        '(deny file-read* file-write* (regex #"^/s/app\\.json"))' +
        pins(
          "/home/u/.tmux-ide",
          "/home/u",
          "/home",
          "/home/u/.tmux-ide/daemon.json",
          "/s/app.json",
          "/s",
        ),
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

  it("pins the state home, private files and every directory above them", () => {
    const profile = darwinProfile(
      { stateHome: "/r/state", writable: "/r/state/plugin-data/t", unreadable: ["/i/daemon.json"] },
      (path) => path,
    );
    for (const path of ["/r/state", "/r", "/i/daemon.json", "/i"])
      expect(profile).toContain(`(deny file-write* (literal "${path}"))`);
    expect(profile).not.toContain('(literal "/r/state/plugin-data/t")');
  });

  it("pins the socket paths and every directory above them", () => {
    expect(immovable(["/private/tmp/tmux-501", "/h/.tmux-ide/control.sock"])).toEqual([
      "/private/tmp/tmux-501",
      "/private/tmp",
      "/private",
      "/h/.tmux-ide/control.sock",
      "/h/.tmux-ide",
      "/h",
    ]);
    const profile = darwinProfile(
      { ...paths, tmuxSockets: ["/private/tmp/tmux-501"] },
      (path) => path,
    );
    for (const path of ["/private/tmp/tmux-501", "/private/tmp", "/private"])
      expect(profile).toContain(`(deny file-write* (literal "${path}"))`);
    expect(profile).not.toContain('(literal "/")');
  });

  it("keeps programs from the daemon's port and control socket", () => {
    const same = (path: string) => path;
    const profile = darwinProfile(
      { ...paths, privateSockets: ["/h/.tmux-ide/control.sock"], daemonPorts: [47123, 0, 70000] },
      same,
    );
    expect(profile).toContain(
      '(deny network-outbound (remote unix-socket (path-regex #"^/h/\\.tmux-ide/control\\.sock")))',
    );
    expect(profile).toContain('(deny network-outbound (remote ip "*:47123"))');
    expect(profile).not.toContain(":0)");
    expect(profile).not.toContain("70000");
  });

  it("keeps programs from tmux socket directories", () => {
    const same = (path: string) => path;
    expect(darwinProfile({ ...paths, tmuxSockets: ["/private/tmp/tmux-501"] }, same)).toContain(
      '(deny network-outbound (remote unix-socket (path-regex #"^/private/tmp/tmux-501/")))' +
        '(deny file-read* file-write* (regex #"^/private/tmp/tmux-501/"))',
    );
    const plan = sandboxedArgv(
      ["/bin/echo"],
      { stateHome, writable: dataDir, tmuxSockets: [root, join(root, "gone")] },
      { platform: "linux", linuxOptIn: true, find: () => "/usr/bin/bwrap", resolve: (p) => p },
    );
    expect(plan.ok && plan.argv.join(" ")).toContain(`--tmpfs ${root} --unshare-pid`);
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

  it("hides what matches a private prefix now with bubblewrap", () => {
    const info = join(root, "info");
    mkdirSync(info);
    for (const name of ["daemon.json", "daemon.json.c.u.tmp", "daemonXjson", "other"])
      writeFileSync(join(info, name), "");
    const plan = sandboxedArgv(
      ["/bin/echo"],
      { stateHome, writable: dataDir, unreadable: [join(info, "daemon.json")] },
      { platform: "linux", linuxOptIn: true, find: () => "/usr/bin/bwrap", resolve: (p) => p },
    );
    expect(plan.ok && plan.argv.join(" ")).toContain(
      `--ro-bind /dev/null ${join(info, "daemon.json")} --ro-bind /dev/null ${join(info, "daemon.json.c.u.tmp")} --unshare-pid`,
    );
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
