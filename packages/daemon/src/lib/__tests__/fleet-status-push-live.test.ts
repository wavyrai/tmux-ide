import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DaemonEventServerFrameSchemaZ, type DaemonEventServerFrame } from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * End-to-end proof of the fleet status-push path (m40/fleet-status-push).
 *
 * A real `/ws/events` client connected like the fleet-catalog store does — with
 * NO per-session subscription (the app subscribes with an empty workspace set,
 * which sends no `subscribe` frame) — must still receive an `agent-status.changed`
 * frame when an `@agent_state` stamp transitions on a pane of an adopted-but-
 * NEVER-opened session. That frame is what the electron broker folds into a
 * renderer `fleet.changed`, which the fleet store re-fetches on. This test
 * exercises the real daemon AgentStatusWatcher polling a real tmux server (not
 * the hermetic manual-tick unit), so it closes the gap between the unit coverage
 * and a live daemon: the signal does not die at the daemon boundary.
 */
describe.skipIf(!hasTmux).sequential("fleet status push live integration", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-fleet-push-"));
  const projectDir = join(root, "project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "fleet-push-keeper";
  const adoptedSession = `fleet-push-${randomUUID().slice(0, 8)}`;
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

  it("pushes agent-status.changed to an unsubscribed client when an unopened session flips", async () => {
    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    // An adopted session the app never opened, with one self-reporting agent pane.
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
    run(["set-option", "-p", "-t", agentPaneId, "@agent_state", `working:${Math.floor(Date.now() / 1000)}`]);
    run(["set-option", "-t", adoptedSession, "@tmux_ide_adopted", "1"]);

    // Connect on loopback like the app does; authenticate with the owner token
    // explicitly (the test daemon does not grant the same-machine bypass a real
    // co-located Electron app relies on — orthogonal to the subscription shape).
    // Connect on loopback like the app does; authenticate with the owner token
    // explicitly (the test daemon does not grant the same-machine bypass a real
    // co-located Electron app relies on — orthogonal to the subscription shape).
    const wsUrl = `${handle.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`;
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${ownerToken}` } });
    // Collect every frame from the moment the socket exists, so the eagerly-sent
    // `hello` frame is never lost to a late listener attach.
    const received: DaemonEventServerFrame[] = [];
    const waiters = new Set<() => void>();
    socket.on("message", (data: unknown) => {
      const parsed = DaemonEventServerFrameSchemaZ.safeParse(
        JSON.parse(typeof data === "string" ? data : String(data)),
      );
      if (!parsed.success) return;
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
      // Connect like the fleet store: open the socket, send NO subscribe frame
      // (an empty workspace set subscribes to zero sessions). The `hello` frame
      // confirms the connection is live and the watcher has baselined "working".
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      const hello = await waitForFrame((frame) => frame.type === "hello", 10_000);
      expect(hello.type).toBe("hello");

      // Flip the ground-truth stamp on the unopened, unsubscribed session.
      run([
        "set-option",
        "-p",
        "-t",
        agentPaneId,
        "@agent_state",
        `blocked:${Math.floor(Date.now() / 1000)}`,
      ]);

      // The real watcher polls on its own cadence; the frame must arrive with no
      // manual refetch and no per-session subscription.
      const frame = await waitForFrame(
        (candidate) =>
          candidate.type === "agent-status.changed" && candidate.sessionName === adoptedSession,
        20_000,
      );
      expect(frame).toEqual({ type: "agent-status.changed", sessionName: adoptedSession });
    } finally {
      socket.close();
    }
  }, 45_000);
});
