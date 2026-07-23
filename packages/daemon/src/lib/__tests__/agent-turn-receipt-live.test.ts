import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { agentIdForPaneStamp } from "../../command-center/resources/application-shell.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * End-to-end proof of the m42 turn-completed receipt (the pattern-setter for
 * receipt-waiting): a real `/ws/events` client WAITS on the typed
 * `agent.turn-completed` frame when a stamped pane's ground truth flips
 * working → done, instead of polling any resource with a timeout loop. The
 * receipt must carry the durable minted agent id (never the raw stamp or a
 * tmux runtime id), and the coarse `agent-status.changed` invalidation must
 * still arrive alongside it — receipts are additive.
 *
 * Determinism note (before/after): the pre-receipt way to observe "the agent
 * finished" from outside was to poll — re-list panes / re-read a resource on a
 * cadence until the status read back as done, where a pass depends on the
 * poll landing after the flip and every intermediate read costing a tmux
 * spawn. Here the daemon's single watcher observes the flip once and pushes
 * one bounded frame; the test's only timing dependence is its outer timeout.
 */
describe.skipIf(!hasTmux).sequential("agent turn-completed receipt live integration", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-turn-receipt-"));
  const projectDir = join(root, "project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "turn-receipt-keeper";
  const adoptedSession = `turn-receipt-${randomUUID().slice(0, 8)}`;
  const paneStamp = `pane.livetest.${randomUUID().replace(/-/gu, "").slice(0, 20)}`;
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;

  const run = (argv: readonly string[]): string =>
    execFileSync(executablePath, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  beforeAll(() => {
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

  it("pushes a typed agent.turn-completed receipt when a stamped pane flips working -> done", async () => {
    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    // An adopted session with one self-reporting agent pane carrying the
    // durable identity stamp (the receipt's correlation key).
    const agentPaneId = run([
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
    run([
      "set-option",
      "-p",
      "-t",
      agentPaneId,
      "@agent_state",
      `working:${Math.floor(Date.now() / 1000)}`,
    ]);
    run(["set-option", "-t", adoptedSession, "@tmux_ide_adopted", "1"]);

    const wsUrl = `${handle.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`;
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ownerToken}` } });
    const rawFrames: string[] = [];
    const received: DaemonEventServerFrame[] = [];
    const waiters = new Set<() => void>();
    socket.on("message", (data: unknown) => {
      const raw = typeof data === "string" ? data : String(data);
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      rawFrames.push(raw);
      received.push(parsed.data);
      for (const notify of [...waiters]) notify();
    });
    const waitForFrame = (
      predicate: (frame: DaemonEventServerFrame) => boolean,
      timeoutMs: number,
    ): Promise<DaemonEventServerFrame> =>
      new Promise((resolve, reject) => {
        const check = (): void => {
          const found = received.find(predicate);
          if (!found) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for frame after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });

    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      // The hello confirms the connection is live and the watcher baselined
      // the pane as working before we flip it.
      await waitForFrame((frame) => frame.type === "hello", 10_000);

      const flippedAt = Date.now();
      run([
        "set-option",
        "-p",
        "-t",
        agentPaneId,
        "@agent_state",
        `done:${Math.floor(Date.now() / 1000)}`,
      ]);

      // Receipt-waiting, not polling: block on the typed completion frame.
      const frame = await waitForFrame(
        (candidate) =>
          candidate.type === "agent.turn-completed" && candidate.sessionName === adoptedSession,
        20_000,
      );
      const latencyMs = Date.now() - flippedAt;
      expect(frame).toMatchObject({
        type: "agent.turn-completed",
        sessionName: adoptedSession,
        agentId: agentIdForPaneStamp(paneStamp),
        fromStatus: "working",
        toStatus: "done",
      });
      // One watcher tick (2s cadence) is the worst case; anything beyond two
      // ticks means the push path regressed to something poll-shaped.
      expect(latencyMs).toBeLessThan(5_000);

      // The coarse invalidation still travels with the receipt.
      await waitForFrame(
        (candidate) =>
          candidate.type === "agent-status.changed" && candidate.sessionName === adoptedSession,
        5_000,
      );

      // Wire audit on the raw receipt frame: no tmux runtime id, no raw
      // durable stamp, no filesystem path.
      const rawReceipt = rawFrames.find((raw) => raw.includes("agent.turn-completed"))!;
      expect(rawReceipt).not.toMatch(/[$%@][0-9]+/u);
      expect(rawReceipt).not.toContain(paneStamp);
      expect(rawReceipt).not.toContain(projectDir);
    } finally {
      socket.close();
    }
  }, 45_000);
});
