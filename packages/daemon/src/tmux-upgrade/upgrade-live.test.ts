/**
 * `tmux-ide servers upgrade` against real servers on private sockets (#766).
 * Every server lives at `-S <mkdtemp>/s`; HOME, XDG_CONFIG_HOME, TMUX_IDE_HOME
 * and TMUX_TMPDIR point into the same temp folder, so no user config, state
 * or default socket is read or written. Skipped without a bundled tmux and a
 * stock tmux to start the old server with.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveBundledTmux } from "../lib/bundled-tmux.ts";
import { serverAnswers } from "../lib/tmux-client-execution.ts";
import { nativeCommands } from "../lib/tmux-server-features.ts";
import { createUpgradeIo } from "./io.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const cliPath = join(root, "bin/cli.js");

function findBundle(): string | null {
  try {
    return resolveBundledTmux([cliPath]);
  } catch {
    return null;
  }
}
const bundled = findBundle();
const stock = [process.env.TMUX_IDE_TEST_STOCK_TMUX, "/opt/homebrew/bin/tmux", "/usr/bin/tmux"]
  .filter((path): path is string => Boolean(path) && existsSync(path!))
  .find((path) => realpathSync(path) !== (bundled && realpathSync(bundled)));
const ready = Boolean(bundled && stock && existsSync(cliPath));
/** Each live test owns real servers; a hung one fails here instead of stalling the lane. */
const LIVE_TIMEOUT_MS = 120_000;

let dir = "";
let socket = "";
let env: NodeJS.ProcessEnv = {};

const run = (binary: string, args: readonly string[]) =>
  execFileSync(binary, ["-S", socket, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
const serverPid = () => run(bundled!, ["display-message", "-p", "-t", "api", "#{pid}"]).trim();
const shape = () =>
  run(bundled!, [
    "list-panes",
    "-a",
    "-F",
    "#{session_name} #{window_index} #{window_name} #{window_layout} #{pane_index} #{pane_current_path} #{pane_title}",
  ])
    .trim()
    .split("\n")
    // Pane ids and the checksum differ on a new server; the geometry must not.
    .map((line) =>
      line.replace(
        / [0-9a-f]{4},(\S+)/u,
        (_, layout: string) => ` ${layout.replace(/(\d+x\d+,\d+,\d+),\d+/gu, "$1")}`,
      ),
    )
    .sort();

function upgrade(...args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cliPath, "servers", "upgrade", "--socket-path", socket, "--json", ...args],
    { cwd: dir, env, encoding: "utf8", timeout: 60_000 },
  );
  let parsed: { status?: string; message?: string } = {};
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
  } catch {
    // An IdeError prints its own JSON error shape; keep the raw text for the assertion.
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, ...parsed };
}

beforeEach(() => {
  if (!ready) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "tmux-upgrade-live-")));
  socket = join(dir, "s");
  for (const sub of ["home", "xdg", "state", "a", "b", "c", "empty-bin"]) mkdirSync(join(dir, sub));
  env = {
    HOME: join(dir, "home"),
    XDG_CONFIG_HOME: join(dir, "xdg"),
    TMUX_IDE_HOME: join(dir, "state"),
    TMUX_TMPDIR: dir,
    // No tmux-ide and no agents on PATH: nothing in a restored pane can reach a real server.
    PATH: `${join(dir, "empty-bin")}:/usr/bin:/bin`,
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  };
  // The old server: stock tmux, no config, two sessions, a split, folders and titles.
  const old = (...args: string[]) =>
    execFileSync(stock!, ["-S", socket, "-f", "/dev/null", ...args], { env, timeout: 5000 });
  old("new-session", "-d", "-s", "api", "-c", join(dir, "a"), "-n", "code");
  old("split-window", "-h", "-t", "api:code", "-c", join(dir, "b"));
  old("select-pane", "-t", "api:code.0", "-T", "editor");
  old("select-pane", "-t", "api:code.1", "-T", "agent");
  old("set-option", "-p", "-t", "api:code.1", "@agent_hint", "claude");
  old(
    "set-option",
    "-p",
    "-t",
    "api:code.1",
    "@agent_session_id",
    "0f3c9a2e-1111-4222-8333-944455556666",
  );
  old("new-session", "-d", "-s", "notes", "-c", join(dir, "c"), "-n", "main");
});

afterEach(() => {
  if (!ready) return;
  for (const binary of [bundled!, stock!])
    try {
      execFileSync(binary, ["-S", socket, "kill-server"], { env, stdio: "ignore", timeout: 5000 });
    } catch {
      // Already gone.
    }
  rmSync(dir, { recursive: true, force: true });
});

it.skipIf(!ready)(
  "moves a stock server onto the bundled tmux and restores every session",
  () => {
    // An agent that reports idle does not need --end-running-agents.
    const now = Math.floor(Date.now() / 1000);
    run(stock!, ["set-option", "-p", "-t", "api:code.1", "@agent_state", `idle:${now}`]);
    const before = shape();
    const oldPid = serverPid();
    expect(nativeCommands((args) => run(bundled!, args))).toBe("stock");

    const result = upgrade("--yes");
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.status).toBe("upgraded");

    expect(shape()).toEqual(before);
    const newPid = serverPid();
    expect(newPid).not.toBe(oldPid);
    expect(nativeCommands((args) => run(bundled!, args))).toBe("full");
    // The hidden session that started the new server is gone.
    expect(
      run(bundled!, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n").sort(),
    ).toEqual(["api", "notes"]);
    // The pinned snapshot stays for a retry.
    const upgrades = readdirSync(join(dir, "state", "upgrades"));
    expect(upgrades).toHaveLength(1);
    expect(existsSync(join(dir, "state", "upgrades", upgrades[0]!, "snapshot.json"))).toBe(true);
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "stops nothing when the snapshot can't be written",
  () => {
    const before = shape();
    const oldPid = serverPid();
    chmodSync(join(dir, "state"), 0o500);
    try {
      const result = upgrade("--yes");
      expect(result.code).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toMatch(/snapshot could not be written/i);
      expect(`${result.stdout}${result.stderr}`).toMatch(/Nothing was stopped/);
    } finally {
      chmodSync(join(dir, "state"), 0o700);
    }
    expect(serverPid()).toBe(oldPid);
    expect(shape()).toEqual(before);
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "refuses --yes alone while an agent is mid-turn, and previews without stopping",
  () => {
    const now = Math.floor(Date.now() / 1000);
    run(stock!, ["set-option", "-p", "-t", "api:code.1", "@agent_state", `working:${now}`]);
    const oldPid = serverPid();

    const refused = upgrade("--yes");
    expect(refused.code).toBe(1);
    expect(refused.status).toBe("refused");
    expect(refused.message).toMatch(/--end-running-agents/);
    expect(serverPid()).toBe(oldPid);

    const preview = upgrade();
    expect(preview.code).toBe(0);
    expect(preview.status).toBe("preview");
    expect(preview.message).toMatch(/^This ends 2 sessions and 1 agent on .+ \(.+\/s\)\./);
    expect(preview.message).toMatch(/api:0\.1 {2}claude {2}working/);
    expect(serverPid()).toBe(oldPid);

    const forced = upgrade("--yes", "--end-running-agents");
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.status).toBe("upgraded");
    expect(serverPid()).not.toBe(oldPid);
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "hands the restart to a detached worker when run inside the target server",
  async () => {
    const now = Math.floor(Date.now() / 1000);
    run(stock!, ["set-option", "-p", "-t", "api:code.1", "@agent_state", `idle:${now}`]);
    const before = shape();
    const oldPid = serverPid();
    const inside = { ...env, TMUX: `${socket},${oldPid},0` };
    const result = spawnSync(
      process.execPath,
      [cliPath, "servers", "upgrade", "--socket-path", socket, "--json", "--yes"],
      { cwd: dir, env: inside, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const handed = JSON.parse(result.stdout.trim()) as { status: string; message: string };
    expect(handed.status).toBe("handed-off");
    const log = /Log: (\S+)$/u.exec(handed.message)?.[1];
    expect(log).toBeDefined();
    await vi.waitFor(() => expect(readFileSync(log!, "utf8")).toMatch(/ upgraded: /u), {
      timeout: 30_000,
      interval: 200,
    });
    expect(serverPid()).not.toBe(oldPid);
    expect(shape()).toEqual(before);
    expect(nativeCommands((args) => run(bundled!, args))).toBe("full");
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "finishes the restore when run inside a pane of the target with TMUX unset (the review's reproduction)",
  async () => {
    const now = Math.floor(Date.now() / 1000);
    run(stock!, ["set-option", "-p", "-t", "api:code.1", "@agent_state", `idle:${now}`]);
    const oldPid = serverPid();
    const out = join(dir, "inside.json");
    // The pane dies with the old server; before the fix, so did the restore. It
    // stays open after the command, as a shell would (`sleep` stands in for it).
    run(stock!, [
      "new-window",
      "-d",
      "-t",
      "notes",
      "-n",
      "upg",
      `env -u TMUX '${process.execPath}' '${cliPath}' servers upgrade --socket-path '${socket}' --yes --json > '${out}' 2>&1; sleep 600`,
    ]);
    await vi.waitFor(
      () => {
        expect(serverPid(), existsSync(out) ? readFileSync(out, "utf8") : "no output yet").not.toBe(
          oldPid,
        );
        expect(nativeCommands((args) => run(bundled!, args))).toBe("full");
        const sessions = run(bundled!, ["list-sessions", "-F", "#{session_name}"])
          .trim()
          .split("\n");
        expect(sessions.sort()).toEqual(["api", "notes"]);
      },
      { timeout: 60_000, interval: 250 },
    );
    const [folder] = readdirSync(join(dir, "state", "upgrades"));
    await vi.waitFor(
      () =>
        expect(readFileSync(join(dir, "state", "upgrades", folder!, "log"), "utf8")).toMatch(
          / upgraded: /u,
        ),
      { timeout: 30_000, interval: 200 },
    );
    // The command saw it ran inside the target by its process tree.
    expect(readFileSync(out, "utf8")).toMatch(/handed-off/);
  },
  LIVE_TIMEOUT_MS,
);

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
  it.skipIf(!ready)(
    `finishes the restore when the foreground gets ${signal} after the worker started`,
    async () => {
      const now = Math.floor(Date.now() / 1000);
      run(stock!, ["set-option", "-p", "-t", "api:code.1", "@agent_state", `idle:${now}`]);
      const before = shape();
      const oldPid = serverPid();
      const child = spawn(
        process.execPath,
        [cliPath, "servers", "upgrade", "--socket-path", socket, "--yes", "--json"],
        { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      // Before anything ends, the snapshot and the restore line are printed.
      await vi.waitFor(
        () => expect(stderr).toMatch(/The restart runs in the background\. Log: /u),
        {
          timeout: 30_000,
          interval: 20,
        },
      );
      expect(stderr).toMatch(
        /If the sessions do not come back, run: tmux-ide restore --from \S+snapshot\.json/u,
      );
      child.kill(signal);
      await exited;
      await vi.waitFor(
        () => {
          expect(serverPid()).not.toBe(oldPid);
          expect(shape()).toEqual(before);
        },
        { timeout: 60_000, interval: 250 },
      );
      expect(nativeCommands((args) => run(bundled!, args))).toBe("full");
    },
    LIVE_TIMEOUT_MS,
  );

it.skipIf(!ready)(
  "ends the server only when both its pid and start time match",
  () => {
    const io = createUpgradeIo({ target: { socketPath: socket }, cliEntry: cliPath, json: true });
    const facts = io.identify(bundled!)!;
    const server = { ...facts, host: "h", features: "stock" as const };
    expect(() => io.kill(bundled!, { ...server, startTime: facts.startTime + 1 })).toThrow(
      /another server/,
    );
    expect(() => io.kill(bundled!, { ...server, pid: facts.pid + 1 })).toThrow(/another server/);
    expect(serverPid()).toBe(String(facts.pid));
    io.kill(bundled!, server);
    expect(io.serverGone(bundled!, socket)).toBe(true);
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "reads the binary of a server started by its PATH name",
  () => {
    const other = join(dir, "by-name");
    execFileSync("tmux", ["-S", other, "-f", "/dev/null", "new-session", "-d", "-s", "x"], {
      env: { ...env, PATH: `${dirname(stock!)}:/usr/bin:/bin` },
      timeout: 5000,
    });
    try {
      const io = createUpgradeIo({ target: { socketPath: other }, cliEntry: cliPath, json: true });
      const facts = io.identify(bundled!)!;
      expect(realpathSync(facts.executable)).toBe(realpathSync(stock!));
    } finally {
      execFileSync(stock!, ["-S", other, "kill-server"], { env, stdio: "ignore" });
    }
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "does not read a stale socket as a running server",
  async () => {
    const stale = join(dir, "stale");
    execFileSync(stock!, ["-S", stale, "-f", "/dev/null", "new-session", "-d", "-s", "x"], {
      env,
      timeout: 5000,
    });
    const pid = Number(
      execFileSync(stock!, ["-S", stale, "display-message", "-p", "-t", "x", "#{pid}"], {
        env,
        encoding: "utf8",
      }).trim(),
    );
    // Asked only after the kill: a running server is remembered per socket path.
    process.kill(pid, "SIGKILL");
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5000 });
    expect(existsSync(stale)).toBe(true);
    expect(serverAnswers(stale, bundled!)).toBe(false);
    expect(serverAnswers(socket, bundled!)).toBe(true);
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "answers No for the user when there is no terminal to ask in",
  () => {
    const oldPid = serverPid();
    const result = spawnSync(
      process.execPath,
      [cliPath, "servers", "upgrade", "--socket-path", socket],
      {
        cwd: dir,
        env,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["pipe", "pipe", "pipe"],
        input: "y\n",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /No terminal to ask in\. Pass --yes to go ahead\. Nothing was stopped\./,
    );
    expect(result.stdout.trim().split("\n").at(-1)).toBe("Nothing was stopped.");
    expect(serverPid()).toBe(oldPid);
  },
  LIVE_TIMEOUT_MS,
);

it.skipIf(!ready)(
  "refuses --yes alone when a not-restored session of the user's runs a program",
  () => {
    const now = Math.floor(Date.now() / 1000);
    run(stock!, ["set-option", "-p", "-t", "api:code.1", "@agent_state", `idle:${now}`]);
    run(stock!, ["new-session", "-d", "-s", "_work", "sleep 600"]);
    const oldPid = serverPid();
    const refused = upgrade("--yes");
    expect(refused.code).toBe(1);
    expect(refused.status).toBe("refused");
    expect(refused.message).toMatch(/1 pane in sessions that are not restored run something/);
    expect(serverPid()).toBe(oldPid);
  },
  LIVE_TIMEOUT_MS,
);
