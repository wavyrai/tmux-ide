import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TMUX_GUARD_REFUSAL_EXIT_CODE,
  assertTmuxGuarded,
  allowDefaultTmuxServerInPrivateNamespace,
  installTmuxGuard,
  redirectedTmuxCalls,
  registerCurrentTest,
  tmuxGuardFailureMessage,
  undeclaredTmuxCalls,
  namedTmuxCalls,
  refusedTmuxCalls,
  removeTmuxGuard,
  saveTmuxGuardReport,
  tmuxGuardScript,
  tmuxGuardViolation,
} from "../../../test-support/tmux-isolation.ts";
import { resolveTmuxExecutable, tmuxClientEnvironment } from "../tmux-client-execution.ts";
import { resolveWorkspacePaneTmuxAuthority } from "../workspace-pane-creation.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A guard in front of a fake tmux that only reports what it was given and where it would look. */
function guard() {
  const directory = mkdtempSync("/tmp/tmux-ide-test-guardspec-");
  directories.push(directory);
  const real = join(directory, "real-tmux");
  writeFileSync(
    real,
    '#!/bin/sh\necho "RAN $* | TMUX_TMPDIR=${TMUX_TMPDIR:-unset} TMUX=${TMUX:-unset}"\n',
  );
  chmodSync(real, 0o755);
  const wrapper = join(directory, "tmux");
  writeFileSync(wrapper, tmuxGuardScript(real, directory));
  chmodSync(wrapper, 0o755);
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(wrapper, args, { env, encoding: "utf8" });
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  };
  return { directory, run };
}

describe("the tmux guard in front of every test", () => {
  it("is installed for this very test process, and is the tmux the daemon resolves", () => {
    expect(tmuxGuardViolation(process.env)).toBeNull();
    const directory = process.env.TMUX_IDE_TEST_TMUX_GUARD!;
    expect(process.env.PATH!.split(delimiter)[0]).toBe(directory);
    // Bundled binary, PATH or configuration: whatever the daemon would pick, it gets the guard.
    expect(resolveTmuxExecutable()).toBe(realpathSync(join(directory, "tmux")));
    expect(resolveWorkspacePaneTmuxAuthority().executablePath).toBe(
      realpathSync(join(directory, "tmux")),
    );
  });

  // The environment a daemon gives its tmux clients: no TMUX, no TMUX_TMPDIR,
  // whatever the test process exported.
  const daemonClient = tmuxClientEnvironment({
    TMUX_TMPDIR: "/tmp/tmux-ide-test-x",
    TERM: "xterm",
  });

  it("moves what a daemon with no explicit socket runs into a private namespace", () => {
    expect(daemonClient.TMUX_TMPDIR).toBeUndefined();
    const g = guard();
    for (const args of [
      ["-L", "default", "-u", "show-hooks", "-g"],
      ["-Ldefault", "set-hook", "-ag", "after-send-keys", "x"],
      ["-L", "zz-c1-unique-name", "ls"],
      ["list-sessions"],
    ]) {
      expect(g.run(args, daemonClient), args.join(" ")).toEqual({
        status: 0,
        // The default or named socket now resolves under the guard, where no server lives.
        stdout: `RAN ${args.join(" ")} | TMUX_TMPDIR=${g.directory} TMUX=unset`,
        stderr: "",
      });
    }
    // Kept away from the default server either way; but nobody declared it, so it fails the run.
    // The call that names its own server is recorded, and does not fail the run.
    expect(undeclaredTmuxCalls(g)).toHaveLength(3);
    expect(namedTmuxCalls(g)).toEqual([
      "REDIRECTED name TMUX_TMPDIR=unset test=unknown args=-L zz-c1-unique-name ls",
    ]);
    expect(undeclaredTmuxCalls(g)[0]).toBe(
      "REDIRECTED name TMUX_TMPDIR=unset test=unknown args=-L default -u show-hooks -g",
    );
    expect(redirectedTmuxCalls(g)).toEqual([]);
    expect(refusedTmuxCalls(g)).toEqual([]);
  });

  it("names the test behind a redirected call, and accepts it once that test declares a daemon without a server", () => {
    const g = guard();
    const here: NodeJS.ProcessEnv = { TMUX_IDE_TEST_TMUX_GUARD: g.directory };
    // The wrapper's parent is this test process; a daemon's child would be found one level up.
    registerCurrentTest("src/lib/__tests__/daemon-embed-takeover.test.ts", here);
    g.run(["-L", "default", "show-hooks", "-g"], daemonClient);
    expect(undeclaredTmuxCalls(g)).toEqual([
      "REDIRECTED name TMUX_TMPDIR=unset test=src/lib/__tests__/daemon-embed-takeover.test.ts args=-L default show-hooks -g",
    ]);
    const withdraw = allowDefaultTmuxServerInPrivateNamespace(here);
    g.run(["-L", "default", "show-hooks", "-g"], daemonClient);
    // Through a shell in between, as when the daemon is a child of the test process.
    spawnSync("/bin/sh", ["-c", `'${g.directory}/tmux' -L default ls`], { env: daemonClient });
    expect(redirectedTmuxCalls(g)).toEqual([
      "REDIRECTED name TMUX_TMPDIR=unset test=src/lib/__tests__/daemon-embed-takeover.test.ts args=-L default show-hooks -g",
      "REDIRECTED name TMUX_TMPDIR=unset test=src/lib/__tests__/daemon-embed-takeover.test.ts args=-L default ls",
    ]);
    expect(undeclaredTmuxCalls(g)).toHaveLength(1);
    withdraw();
    g.run(["list-sessions"], daemonClient);
    expect(undeclaredTmuxCalls(g)).toHaveLength(2);
    expect(tmuxGuardFailureMessage(refusedTmuxCalls(g), undeclaredTmuxCalls(g))).toContain(
      "allowDefaultTmuxServerInPrivateNamespace()",
    );
  });

  it("drops an inherited live TMUX and never uses the shared /tmp as TMUX_TMPDIR", () => {
    const g = guard();
    expect(g.run(["list-sessions"], { TMUX: "/private/tmp/tmux-501/default,14910,0" }).stdout).toBe(
      `RAN list-sessions | TMUX_TMPDIR=${g.directory} TMUX=unset`,
    );
    expect(g.run(["list-sessions"], { TMUX_TMPDIR: "/tmp" }).stdout).toBe(
      `RAN list-sessions | TMUX_TMPDIR=${g.directory} TMUX=unset`,
    );
    expect(g.run(["-L", "default", "ls"], { TMUX_TMPDIR: "/private/tmp" }).stdout).toBe(
      `RAN -L default ls | TMUX_TMPDIR=${g.directory} TMUX=unset`,
    );
    expect(undeclaredTmuxCalls(g)).toHaveLength(3);
  });

  it("refuses and records an explicit socket path that is not private", () => {
    const g = guard();
    for (const args of [
      ["-S", "/private/tmp/tmux-501/default", "display-message", "-p", "x"],
      ["-S", "/tmp/tmux-501/default", "kill-server"],
      ["-S/tmp/tmux-501/some-name", "ls"],
      ["-S", "/tmp/shared.sock", "list-sessions"],
      ["-S", "/Users/someone/live.sock", "list-sessions"],
      // A private name cannot launder a live path.
      ["-L", "private", "-S", "/private/tmp/tmux-501/default", "ls"],
    ]) {
      expect(g.run(args, { TMUX_TMPDIR: g.directory }), args.join(" ")).toMatchObject({
        status: TMUX_GUARD_REFUSAL_EXIT_CODE,
        stdout: "",
      });
    }
    expect(refusedTmuxCalls(g)).toHaveLength(6);
    expect(refusedTmuxCalls(g)[1]).toBe(
      "REFUSED socket=/tmp/tmux-501/default args=-S /tmp/tmux-501/default kill-server",
    );
  });

  it("passes calls that are already private through untouched", () => {
    const g = guard();
    for (const [args, env, seen] of [
      [
        ["-V"],
        { TMUX_TMPDIR: "/tmp/tmux-ide-test-abc" },
        "TMUX_TMPDIR=/tmp/tmux-ide-test-abc TMUX=unset",
      ],
      [
        ["-S", "/tmp/tmi-e2e-case-Ab12/t.sock", "-u", "list-sessions"],
        {},
        "TMUX_TMPDIR=unset TMUX=unset",
      ],
      [["-S/private/tmp/tmux-ide-test-abc/t.sock", "ls"], {}, "TMUX_TMPDIR=unset TMUX=unset"],
      [
        ["-S", "/var/folders/l_/abc/T/tmux-ide-takeover-x/t.sock", "ls"],
        {},
        "TMUX_TMPDIR=unset TMUX=unset",
      ],
      [
        ["-L", "default", "ls"],
        { TMUX_TMPDIR: "/tmp/tmux-ide-test-abc" },
        "TMUX_TMPDIR=/tmp/tmux-ide-test-abc TMUX=unset",
      ],
      [
        ["list-sessions"],
        { TMUX: "/tmp/tmi-e2e-case-Ab12/t.sock,4242,0" },
        "TMUX_TMPDIR=unset TMUX=/tmp/tmi-e2e-case-Ab12/t.sock,4242,0",
      ],
    ] as const) {
      expect(g.run([...args], env), args.join(" ")).toEqual({
        status: 0,
        stdout: `RAN ${args.join(" ")} | ${seen}`,
        stderr: "",
      });
    }
    expect(refusedTmuxCalls(g)).toEqual([]);
    expect(redirectedTmuxCalls(g)).toEqual([]);
    expect(undeclaredTmuxCalls(g)).toEqual([]);
  });

  // CI, PR #378: `wait-for -S <channel>` and `capture-pane -S -` to a private
  // server were refused, because every -S was read as the socket option.
  it("reads -S and -L only among tmux's own options, never among a command's", () => {
    const { directory, run } = guard();
    const socket = join(directory, "t.sock");
    for (const args of [
      ["-S", socket, "wait-for", "-S", "test-drain-resume"],
      ["-S", socket, "-u", "capture-pane", "-p", "-S", "-", "-E", "-"],
      ["-L", "tmux-ide-upgrade-1", "-f", "/dev/null", "capture-pane", "-p", "-S", "-"],
      ["-u", "-S", socket, "list-sessions", "-F", "#{session_name}"],
      [`-uS${socket}`, "wait-for", "-L", "lock"],
    ]) {
      const result = run(args, { TMUX_TMPDIR: directory });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`RAN ${args.join(" ")} |`);
    }
    expect(refusedTmuxCalls({ directory })).toEqual([]);
    expect(undeclaredTmuxCalls({ directory })).toEqual([]);
    // The socket option is still found behind other options and in a cluster.
    for (const args of [
      ["-u", "-f", "/dev/null", "-S", "/tmp/tmux-501/default", "list-sessions"],
      ["-uS/tmp/tmux-501/default", "list-sessions"],
      ["-2", "-S/private/tmp/tmux-501/default", "wait-for", "-S", "x"],
    ]) {
      expect(run(args, { TMUX_TMPDIR: directory }).status).toBe(TMUX_GUARD_REFUSAL_EXIT_CODE);
    }
    expect(refusedTmuxCalls({ directory })).toHaveLength(3);
    // A command's own -L does not make the call look like it names a server.
    const unnamed = run(["wait-for", "-L", "lock"], { TMUX_TMPDIR: "/tmp" });
    expect(unnamed.stdout).toContain(`TMUX_TMPDIR=${directory}`);
  });

  // Every distinct shape of tmux call the live and package lanes made in CI on
  // PR #378 (guard artifact tmux-guard-node-22 and the job logs), as a daemon's
  // pinned client makes them: no TMUX, no TMUX_TMPDIR. Each must get the
  // verdict written next to it; none may be refused.
  it("gives every call shape seen in CI its verdict", () => {
    const uuid = "0b4e7c0e-6a53-4f0e-9d53-0f6f2d3c1a11";
    const buffer = `tmux-ide-interaction-v3-${uuid}`;
    const field = "#{session_name}|tmux-ide-field-v2|#{session_id}";
    const corpus: [verdict: "named" | "undeclared" | "private", argv: string[]][] = [
      ["named", ["-L", "tmi-replacement-" + uuid, "display-message", "-p", "#{pid}"]],
      ["named", ["-L", "tmux-ide-m50-9-ab12cd34", "has-session", "-t", "=_tmux-ide-view-v1-0"]],
      [
        "named",
        [
          "-L",
          "tmux-ide-m50-9-ab12cd34",
          "if-shell",
          "-F",
          "-t",
          "$0:@0.%0",
          "#{==:#{window_id},@0}",
          "display-message -p ok",
        ],
      ],
      ["named", ["-L", "tmi-replacement-" + uuid, "kill-server"]],
      ["named", ["-L", "tmux-ide-m41-9-ab12cd34", "list-panes", "-s", "-t", "$0", "-F", field]],
      ["named", ["-L", "tmux-ide-a1-9-ab12cd34", "list-sessions", "-F", field]],
      [
        "named",
        ["-L", "tmux-ide-m41-9-ab12cd34", "list-windows", "-t", "=view", "-F", "#{window_id}"],
      ],
      [
        "named",
        [
          "-L",
          "tmux-ide-m41-9-ab12cd34",
          "show-environment",
          "-t",
          "$0",
          "TMUX_IDE_ATTACHMENT_VIEW",
        ],
      ],
      ["named", ["-L", "tmi-replacement-" + uuid, "show-options", "-qv", "-t", "owned", "@stale"]],
      ["named", ["-L", "tmi-replacement-" + uuid, "-N", "display-message", "-p", "#{socket_path}"]],
      [
        "named",
        [
          "-L",
          "tmux-ide-upgrade-9-ab12cd34",
          "-f",
          "/dev/null",
          "capture-pane",
          "-p",
          "-S",
          "-",
          "-t",
          "keep",
        ],
      ],
      [
        "named",
        [
          "-L",
          "tmi-replacement-" + uuid,
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "owned",
          "exec sleep 300",
        ],
      ],
      [
        "named",
        [
          "-L",
          "tmi-replacement-" + uuid,
          "-u",
          "-N",
          "display-message",
          "-p",
          "#{socket_path}|#{pid}",
        ],
      ],
      ["named", ["-L", "tmi-replacement-" + uuid, "-u", "-N", "list-sessions"]],
      [
        "named",
        [
          "-L",
          "tmux-ide-color-cold-9-ab12cd34",
          "-u",
          "-f",
          "/dev/null",
          "new-session",
          "-d",
          "-s",
          "cold",
          "env -u NO_COLOR sh -c true",
        ],
      ],
      [
        "named",
        [
          "-L",
          "zz-c1-" + uuid,
          "if-shell",
          "-F",
          `#{==:#{@${buffer}},}`,
          `wait-for '${buffer}-ready'`,
        ],
      ],
      [
        "named",
        ["-L", "zz-c1-" + uuid, "-u", "set-buffer", "-b", buffer, "retention-owner pid=4242"],
      ],
      ["named", ["-L", "zz-c1-" + uuid, "-u", "set-option", "-gu", `@${buffer}`]],
      ["named", ["-L", "zz-c1-" + uuid, "-u", "show-hooks", "-g", "after-send-keys"]],
      ["named", ["-L", "zz-c1-" + uuid, "-u", "delete-buffer", "-b", buffer]],
      [
        "named",
        ["-L", "zz-c1-" + uuid + "-other", "-u", "-N", "display-message", "-p", "#{start_time}"],
      ],
      ["undeclared", ["-L", "default", "list-sessions", "-F", "#{session_name}"]],
      ["undeclared", ["-L", "default", "-N", "display-message", "-p", "#{socket_path}"]],
      ["undeclared", ["-L", "default", "-u", "list-buffers", "-F", "#{buffer_name}"]],
      [
        "undeclared",
        ["-L", "default", "-u", "set-buffer", "-b", buffer, "retention-owner pid=4242"],
      ],
      ["undeclared", ["-L", "default", "-u", "show-hooks", "-g", "after-capture-pane"]],
      [
        "undeclared",
        ["-L", "default", "-u", "-N", "display-message", "-p", "#{socket_path}|#{pid}"],
      ],
      ["undeclared", ["list-sessions", "-F", "#{session_name}"]],
      [
        "private",
        [
          "-S",
          "/tmp/tmux-ide-unread-wait-ksEQsv/tmux.sock",
          "wait-for",
          "-S",
          "tmux-ide-unread-regression-ready",
        ],
      ],
      [
        "private",
        [
          "-S",
          "/tmp/tmux-ide-prefix-drain-fi0ZYI/tmux.sock",
          "wait-for",
          "-S",
          "test-drain-resume",
        ],
      ],
      [
        "private",
        [
          "-S",
          "/tmp/tmux-ide-test-5OHppF/tmux-1001/zz-m56-cutover-9-ab12cd34",
          "-u",
          "set-option",
          "-p",
          "-t",
          "%0",
          "@tmux_ide_read_operation",
          "x:y",
          ";",
          "capture-pane",
          "-p",
          "-e",
          "-J",
          "-t",
          "%0",
          "-S",
          "-2000",
        ],
      ],
      ["private", ["-V"]],
    ];
    for (const [verdict, argv] of corpus) {
      const g = guard();
      const result = g.run(argv, daemonClient);
      expect(result.status, argv.join(" ")).toBe(0);
      expect(result.stdout, argv.join(" ")).toContain(`RAN ${argv.join(" ")} |`);
      expect(
        {
          refused: refusedTmuxCalls(g).length,
          undeclared: undeclaredTmuxCalls(g).length,
          named: namedTmuxCalls(g).length,
        },
        argv.join(" "),
      ).toEqual({
        refused: 0,
        undeclared: verdict === "undeclared" ? 1 : 0,
        named: verdict === "named" ? 1 : 0,
      });
      // Never the shared default directory, whatever the verdict.
      if (verdict !== "private") expect(result.stdout).toContain(`TMUX_TMPDIR=${g.directory}`);
    }
  }, 60_000);

  it("installs once: first on PATH, a private TMUX_TMPDIR, and no inherited live TMUX", () => {
    const environment: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      TMUX: "/private/tmp/tmux-501/default,14910,0",
      TMUX_PANE: "%3",
    };
    const installed = installTmuxGuard(environment);
    directories.push(installed.directory);
    expect(installed.created).toBe(true);
    expect(environment.PATH).toBe(`${installed.directory}:/usr/bin:/bin`);
    expect(environment.TMUX_IDE_TMUX_BIN).toBe(installed.executable);
    expect(environment.TMUX_TMPDIR).toBe(installed.directory);
    expect(environment.TMUX).toBeUndefined();
    expect(environment.TMUX_PANE).toBeUndefined();
    expect(readFileSync(installed.executable, "utf8")).toContain("REFUSED");
    expect(tmuxGuardViolation(environment)).toBeNull();
    // A worker that inherits the environment reuses the same guard.
    expect(installTmuxGuard(environment)).toMatchObject({
      directory: installed.directory,
      created: false,
    });
    expect(environment.PATH).toBe(`${installed.directory}:/usr/bin:/bin`);
    removeTmuxGuard(installed);
    expect(existsSync(installed.directory)).toBe(false);
  });

  it("fails a test whose environment lost the guard", () => {
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    const installed = installTmuxGuard(environment);
    directories.push(installed.directory);
    expect(() => assertTmuxGuarded(environment)).not.toThrow();
    expect(() => assertTmuxGuarded({ ...environment, PATH: "/opt/homebrew/bin:/usr/bin" })).toThrow(
      /no longer first on PATH/u,
    );
    // A test's own shim directory in a temp dir may stand in front of the guard;
    // a system directory may not, and neither may a temp dir after one.
    const guardFirst = environment.PATH!;
    expect(() =>
      assertTmuxGuarded({ ...environment, PATH: `/tmp/tmux-ide-idle-abc/shim:${guardFirst}` }),
    ).not.toThrow();
    expect(() =>
      assertTmuxGuarded({ ...environment, PATH: `/usr/local/bin:${guardFirst}` }),
    ).toThrow(/no longer first on PATH/u);
    expect(() =>
      assertTmuxGuarded({
        ...environment,
        PATH: `/tmp/tmux-ide-idle-abc/shim:/usr/bin:${guardFirst}`,
      }),
    ).toThrow(/no longer first on PATH/u);
    expect(() =>
      assertTmuxGuarded({ ...environment, TMUX_IDE_TMUX_BIN: "/opt/homebrew/bin/tmux" }),
    ).toThrow(/bypasses the guard/u);
    expect(() =>
      assertTmuxGuarded({ ...environment, TMUX_IDE_TMUX_BIN: "/tmp/case-abc/fake-tmux" }),
    ).not.toThrow();
    const withoutBinary = { ...environment };
    delete withoutBinary.TMUX_IDE_TMUX_BIN;
    expect(() => assertTmuxGuarded(withoutBinary)).toThrow(/bundled tmux would be used/u);
    expect(() =>
      assertTmuxGuarded({ ...environment, TMUX_IDE_RUNTIME_MODE: "development" }),
    ).toThrow(/ignore TMUX_IDE_TMUX_BIN/u);
    expect(() => assertTmuxGuarded({ PATH: "/usr/bin" })).toThrow(/not installed/u);

    const report = mkdtempSync("/tmp/tmux-ide-test-report-");
    directories.push(report);
    writeFileSync(
      join(installed.directory, "redirected.log"),
      "REDIRECTED name args=-L default ls\n",
    );
    saveTmuxGuardReport(installed, report);
    const saved = readdirSync(report).sort();
    expect(saved.map((name) => name.replace(/^\d+-\d+-/u, ""))).toEqual([
      "named.log",
      "redirected.log",
      "refused.log",
      "undeclared.log",
    ]);
    expect(readFileSync(join(report, saved[1]!), "utf8")).toContain("REDIRECTED name");
    saveTmuxGuardReport(installed, undefined); // no destination: nothing to do
  });
});
