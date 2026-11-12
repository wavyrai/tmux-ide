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
  installTmuxGuard,
  redirectedTmuxCalls,
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
    expect(redirectedTmuxCalls(g)).toHaveLength(4);
    expect(redirectedTmuxCalls(g)[0]).toBe(
      "REDIRECTED name TMUX_TMPDIR=unset args=-L default -u show-hooks -g",
    );
    expect(refusedTmuxCalls(g)).toEqual([]);
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
    expect(redirectedTmuxCalls(g)).toHaveLength(4);
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
  });

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
      "redirected.log",
      "refused.log",
    ]);
    expect(readFileSync(join(report, saved[0]!), "utf8")).toContain("REDIRECTED name");
    saveTmuxGuardReport(installed, undefined); // no destination: nothing to do
  });
});
