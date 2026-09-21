import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../../../lib/daemon-embed.ts";
import { createStatusTracker, type AgentStatus } from "../../detect/classify.ts";
import { findSessionStatus } from "../report.ts";
import { listTeamSessions } from "../sessions.ts";
import { waitForAgentStatusViaReceipts } from "../wait-receipts.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * Sole-waiter regression for the receipt-driven `wait agent-status`.
 *
 * The daemon only installs fleet observation while a `/ws/events` client
 * subscribes to it. A waiter that merely opened the socket on an otherwise
 * idle daemon was therefore never told about the transition it awaited and
 * ran out its whole timeout. This proves, against a real private daemon and
 * a real private tmux server with NO other daemon client, that a single
 * `waitForAgentStatusViaReceipts` call:
 *
 * 1. resolves `done` when the stamped pane flips working → done strictly
 *    AFTER the wait took its barrier read (the flip is timestamped against
 *    the instrumented aggregate read), and
 * 2. resolves immediately from the barrier read when the flip already
 *    happened before the wait started.
 */
describe.skipIf(!hasTmux).sequential("wait agent-status receipts: sole waiter live", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-wait-receipt-"));
  const projectDir = join(root, "project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "wait-receipt-keeper";
  const adoptedSession = `wait-receipt-${randomUUID().slice(0, 8)}`;
  const paneStamp = `pane.livetest.${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;
  let agentPaneId = "";

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  const stamp = (state: "working" | "done"): number => {
    const at = Date.now();
    run([
      "set-option",
      "-p",
      "-t",
      agentPaneId,
      "@agent_state",
      `${state}:${Math.floor(at / 1000)}`,
    ]);
    return at;
  };

  /** The real aggregate read the CLI uses, instrumented with read timestamps. */
  const instrumentedStatus = (): {
    reads: { at: number; status: AgentStatus | null }[];
    currentStatus: () => AgentStatus | null;
  } => {
    const tracker = createStatusTracker();
    const reads: { at: number; status: AgentStatus | null }[] = [];
    return {
      reads,
      currentStatus: () => {
        const status = findSessionStatus(listTeamSessions(tracker), adoptedSession);
        reads.push({ at: Date.now(), status });
        return status;
      },
    };
  };

  beforeAll(async () => {
    mkdirSync(projectDir);
    for (const name of [
      "TMUX",
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

    run(["-f", "/dev/null", "new-session", "-d", "-s", keeperSession, "exec sleep 300"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;

    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    agentPaneId = run([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      adoptedSession,
      "-c",
      projectDir,
      "-n",
      "agent",
      "exec sleep 300",
    ]);
    run(["set-option", "-p", "-t", agentPaneId, "@tmux_ide_pane_id", paneStamp]);
    run(["set-option", "-t", adoptedSession, "@tmux_ide_adopted", "1"]);
  });

  afterAll(async () => {
    await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
    handle = null;
    spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("a sole waiter resolves done when the pane flips after the wait started", async () => {
    stamp("working");
    const { reads, currentStatus } = instrumentedStatus();
    const timeoutMs = 20_000;
    const startedAt = Date.now();
    const wait = waitForAgentStatusViaReceipts(adoptedSession, "done", {
      timeoutMs,
      currentStatus,
    });

    // Flip only once the wait has taken its barrier read (observer installed
    // and baselined), so the transition can only reach it as a pushed receipt.
    await vi.waitFor(() => expect(reads.length).toBeGreaterThan(0), {
      timeout: 10_000,
      interval: 25,
    });
    expect(reads[0]?.status).toBe("working");
    const flippedAt = stamp("done");
    expect(flippedAt).toBeGreaterThanOrEqual(reads[0]!.at);

    const result = await wait;
    const elapsedMs = Date.now() - startedAt;
    expect(result).toEqual({ ok: true, session: adoptedSession, want: "done", status: "done" });
    // One watcher tick (2s cadence) is the worst case after the flip; the old
    // behaviour ran out the full timeout because nothing ever observed the flip.
    expect(Date.now() - flippedAt).toBeLessThan(6_000);
    expect(elapsedMs).toBeLessThan(timeoutMs / 2);
    expect(reads.at(-1)?.status).toBe("done");
  }, 45_000);

  it("a sole waiter answers an already-done session from the barrier read", async () => {
    stamp("done");
    const { reads, currentStatus } = instrumentedStatus();
    const startedAt = Date.now();
    const result = await waitForAgentStatusViaReceipts(adoptedSession, "done", {
      timeoutMs: 20_000,
      currentStatus,
    });
    expect(result).toEqual({ ok: true, session: adoptedSession, want: "done", status: "done" });
    expect(reads).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);
});
