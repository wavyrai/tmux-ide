import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/** Idle window length. Long enough that a one-second timer shows up as ~20 spawns. */
const WINDOW_MS = 20_000;

/**
 * Card #249: an unattended daemon must not burn tmux subprocesses while
 * nothing happens. Every tmux spawn the daemon makes is routed through a
 * counting shim (the daemon canonicalizes `TMUX_IDE_TMUX_BIN`, so the shim is a
 * regular file that execs the real binary) and attributed to its first tmux
 * command word. Two idle windows are measured: no clients at all, then one
 * idle `/ws/events` subscriber.
 *
 * Measured on 2026-09-21 (macOS, tmux 3.7c), 20 s windows starting 3 s after
 * the daemon (or the subscription) settled:
 *
 * - before: no clients 40 spawns (2.0/s), all `show-hooks` from the
 *   interaction observer's fixed one-second health check (two clients per
 *   tick); one idle legacy events client 60 spawns (3.0/s): the same 40 plus
 *   20 `list-panes` from the fleet-facts observer (2 s tick, agents + adopted
 *   readers). No `wait-for` churn: the blocked waiter is one long-lived child.
 * - after: no clients 2-3 `show-hooks` (0.10-0.15/s; the doubling schedule's
 *   checks at 3 s, 7 s, 15 s relative to start); one idle client 1
 *   `show-hooks` + the unchanged 20 `list-panes` (1.05/s). Daemon-process CPU
 *   over the window went from 321/94 ms to 149/47 ms across two runs (the
 *   first window includes JIT warm-up either way; CPU is indicative only).
 *
 * The assertions below bound the interaction observer's own sources
 * (`show-hooks`, `wait-for`); the legacy fleet poll is reported, not owned here.
 */
describe.skipIf(!hasTmux).sequential("daemon idle tmux spawn overhead", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-idle-overhead-"));
  const projectDir = join(root, "project");
  const shimDir = join(root, "bin");
  const shimPath = join(shimDir, "tmux");
  const spawnLog = join(root, "spawns.log");
  const socketPath = join(root, "tmux.sock");
  const session = `zz-idle-${randomUUID().slice(0, 8)}`;
  const ownerToken = `owner-${randomUUID()}`;
  const realTmux = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;

  const run = (argv: readonly string[]): string =>
    execFileSync(realTmux, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  const readSpawns = (): Record<string, number> => {
    let raw: string;
    try {
      raw = readFileSync(spawnLog, "utf8");
    } catch {
      return {};
    }
    const counts: Record<string, number> = {};
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const words = line.split("");
      // Skip the socket/option prefix (-S path, -L name, -u, -f file …).
      let index = 0;
      while (index < words.length && words[index]!.startsWith("-")) {
        index += words[index] === "-u" || words[index] === "-C" ? 1 : 2;
      }
      const command = words[index] ?? "(none)";
      counts[command] = (counts[command] ?? 0) + 1;
    }
    return counts;
  };

  const measureWindow = async (label: string) => {
    writeFileSync(spawnLog, "");
    const cpuBefore = process.cpuUsage();
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
    const elapsedMs = Date.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    const bySource = readSpawns();
    const total = Object.values(bySource).reduce((sum, count) => sum + count, 0);
    const report = {
      label,
      elapsedMs,
      spawns: total,
      spawnsPerSecond: Number((total / (elapsedMs / 1000)).toFixed(3)),
      bySource,
      daemonProcessCpuMs: Number(((cpu.user + cpu.system) / 1000).toFixed(1)),
    };
    process.stderr.write(`[idle-overhead] ${JSON.stringify(report)}\n`);
    return report;
  };

  beforeAll(async () => {
    mkdirSync(projectDir);
    mkdirSync(shimDir);
    writeFileSync(
      shimPath,
      [
        "#!/bin/sh",
        `LOG=${JSON.stringify(spawnLog)}`,
        // One record per spawn; a raw 0x01 byte separates arguments so paths with spaces survive.
        'line=""; for a in "$@"; do line="$line$a\x01"; done',
        'printf "%s\\n" "$line" >> "$LOG"',
        `exec ${JSON.stringify(realTmux)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(shimPath, 0o755);
    for (const name of [
      "PATH",
      "TMUX",
      "TMUX_IDE_TMUX_BIN",
      "TMUX_IDE_DAEMON_INFO_DIR",
      "TMUX_IDE_REGISTRY_DIR",
      "TMUX_IDE_SETTINGS_DIR",
      "TMUX_IDE_HOME",
      "TMUX_IDE_SESSION",
    ]) {
      previousEnvironment[name] = process.env[name];
    }
    process.env.TMUX_IDE_DAEMON_INFO_DIR = join(root, "daemon");
    process.env.TMUX_IDE_REGISTRY_DIR = join(root, "registry");
    process.env.TMUX_IDE_SETTINGS_DIR = join(root, "settings");
    process.env.TMUX_IDE_HOME = join(root, "home");
    delete process.env.TMUX_IDE_SESSION;
    process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
    process.env.TMUX_IDE_TMUX_BIN = shimPath;

    run([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      session,
      "-c",
      projectDir,
      "exec sleep 600",
    ]);
    run(["set-option", "-t", session, "@tmux_ide_adopted", "1"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;

    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });
    // Let startup work (hook install, registry load, catalog priming) settle.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  });

  afterAll(async () => {
    await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
    handle = null;
    spawnSync(realTmux, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Doubling from 1 s, at most four health checks land in any 20 s window. */
  const MAX_HEALTHCHECKS_PER_WINDOW = 4;

  it("spawns at most one tmux child per three seconds with no clients", async () => {
    const report = await measureWindow("no-clients");
    expect(report.spawnsPerSecond).toBeLessThanOrEqual(1 / 3);
    expect(report.bySource["show-hooks"] ?? 0).toBeLessThanOrEqual(MAX_HEALTHCHECKS_PER_WINDOW);
    expect(report.bySource["wait-for"] ?? 0).toBe(0);
  });

  it("keeps the interaction observer at a few health checks with one idle events client", async () => {
    const wsUrl = `${handle!.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`;
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ownerToken}` } });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "subscribe", sessions: [session] }));
    // Let subscription-time work (baseline reads, legacy observation start) settle.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      const report = await measureWindow("one-idle-events-client");
      expect(report.bySource["show-hooks"] ?? 0).toBeLessThanOrEqual(MAX_HEALTHCHECKS_PER_WINDOW);
      expect(report.bySource["wait-for"] ?? 0).toBe(0);
    } finally {
      socket.close();
    }
  });
});
