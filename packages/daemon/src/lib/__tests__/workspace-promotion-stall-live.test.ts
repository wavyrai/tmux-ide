import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { WorkspacePromoteMutationResultSchemaZ } from "@tmux-ide/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "../daemon-embed.ts";
import { _setDefaultWorkspaceRegistryForTests, WorkspaceRegistry } from "../workspace-registry.ts";
import { fleetSessionIdForName } from "../../command-center/resources/fleet-catalog.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * Event-loop stall measurement for workspace promotion.
 *
 * The daemon runs embedded in this process, so `monitorEventLoopDelay` reads
 * the daemon's own event loop. A SEPARATE process holds a `/ws/events` client
 * and keeps one ping → pong round-trip in flight the whole time (an in-process
 * probe would freeze together with a stalled daemon and under-report), while
 * this process promotes a session with many panes. Every tmux round-trip
 * promotion performs synchronously on the loop shows up as loop delay and as a
 * ping round-trip of that length for the external client.
 *
 * Bound rationale: promoting a 16-pane session performs ~120 tmux client
 * invocations. With a synchronous runner they serialized on the loop as one
 * stall spanning the whole promotion (measured before remediation: 462 ms max
 * loop delay, 2 pongs served in 470 ms). With the async runner every
 * invocation yields, so loop delay is bounded by a single callback's work
 * (measured after: a few ms). The 100 ms bounds are deliberately loose so the
 * test rejects the synchronous regression class, not scheduler jitter on a
 * loaded developer machine.
 */
describe.skipIf(!hasTmux).sequential("workspace promotion event-loop stall", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

  const root = mkdtempSync(join("/tmp", "tmux-ide-promote-stall-"));
  const projectDir = join(root, "project");
  const socketPath = join(root, "tmux.sock");
  const keeperSession = "workspace-promote-stall-keeper";
  const targetSession = `fleet-stall-${randomUUID().slice(0, 8)}`;
  const ownerToken = `owner-${randomUUID()}`;
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const previousEnvironment: Record<string, string | undefined> = {};
  let handle: EmbeddedDaemonHandle | null = null;
  let probeProcess: ChildProcess | null = null;
  const WINDOWS = 8;
  const PANES_PER_WINDOW = 2;

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
      "TMUX_IDE_TMUX_BIN",
    ]) {
      previousEnvironment[name] = process.env[name];
    }
    // Pin the daemon to the same tmux the test drives: the measurement must
    // not depend on a bundled build artifact being present or version-matched.
    process.env.TMUX_IDE_TMUX_BIN = executablePath;
    process.env.TMUX_IDE_DAEMON_INFO_DIR = join(root, "daemon");
    process.env.TMUX_IDE_REGISTRY_DIR = join(root, "registry");
    process.env.TMUX_IDE_SETTINGS_DIR = join(root, "settings");
    process.env.TMUX_IDE_HOME = join(root, "home");
    delete process.env.TMUX_IDE_SESSION;

    run(["-f", "/dev/null", "new-session", "-d", "-s", keeperSession, "exec sleep 300"]);
    process.env.TMUX = `${socketPath},${process.pid},0`;

    const registry = new WorkspaceRegistry({
      dir: join(root, "registry"),
      listSessions: () => run(["list-sessions", "-F", "#{session_name}"]).split("\n"),
    });
    _setDefaultWorkspaceRegistryForTests(registry);
  });

  afterAll(async () => {
    probeProcess?.kill("SIGKILL");
    probeProcess = null;
    await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
    handle = null;
    _setDefaultWorkspaceRegistryForTests(null);
    spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * The external probe: a child Node process that connects to `/ws/events`,
   * then loops ping → pong with exactly one probe in flight, printing one
   * round-trip per line. `ws` resolves from this package's node_modules.
   */
  const PROBE_SOURCE = `
    import { WebSocket } from "ws";
    const [url, token] = process.argv.slice(-2);
    const socket = new WebSocket(url, { headers: { Authorization: "Bearer " + token } });
    let waiter = null;
    socket.on("message", (data) => {
      if (JSON.parse(String(data)).type === "pong") waiter?.();
    });
    socket.on("open", async () => {
      process.stdout.write("open\\n");
      for (;;) {
        const sentAt = performance.now();
        const pong = new Promise((resolve) => { waiter = resolve; });
        socket.send(JSON.stringify({ type: "ping" }));
        await pong;
        process.stdout.write((performance.now() - sentAt).toFixed(2) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    });
    socket.on("error", (error) => { process.stderr.write(String(error) + "\\n"); process.exit(2); });
  `;

  it("keeps an external events client's ping round-trip bounded while a many-pane session is promoted", async () => {
    handle = await startEmbeddedDaemon({
      authToken: "remote-token-is-not-owner",
      localBypassToken: ownerToken,
      silent: true,
    });

    run(["new-session", "-d", "-s", targetSession, "-c", projectDir, "-n", "w0", "exec sleep 300"]);
    for (let window = 1; window < WINDOWS; window += 1) {
      run([
        "new-window",
        "-d",
        "-t",
        `${targetSession}:`,
        "-c",
        projectDir,
        "-n",
        `w${window}`,
        "exec sleep 300",
      ]);
    }
    const windowIds = run(["list-windows", "-t", targetSession, "-F", "#{window_id}"]).split("\n");
    for (const windowId of windowIds) {
      for (let pane = 1; pane < PANES_PER_WINDOW; pane += 1) {
        run(["split-window", "-d", "-t", windowId, "-c", projectDir, "exec sleep 300"]);
      }
    }
    expect(
      run(["list-panes", "-s", "-t", targetSession, "-F", "#{pane_id}"]).split("\n"),
    ).toHaveLength(WINDOWS * PANES_PER_WINDOW);

    const packageRoot = fileURLToPath(new URL("../../..", import.meta.url));
    probeProcess = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        PROBE_SOURCE,
        `${handle.apiBaseUrl.replace(/^http/u, "ws")}/ws/events`,
        ownerToken,
      ],
      { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const roundTrips: number[] = [];
    let opened: () => void = () => undefined;
    const openedPromise = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let buffered = "";
    probeProcess.stdout!.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "open") opened();
        else if (line.length > 0) roundTrips.push(Number(line));
      }
    });
    let probeStderr = "";
    probeProcess.stderr!.on("data", (chunk: Buffer) => {
      probeStderr += chunk.toString("utf8");
    });
    await Promise.race([
      openedPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`probe never connected: ${probeStderr}`)), 10_000),
      ),
    ]);

    const loopDelay = monitorEventLoopDelay({ resolution: 1 });
    loopDelay.enable();
    // Settle: an idle baseline so the report can separate promotion from noise.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const idleMaxRoundTripMs = Math.max(...roundTrips);
    const idleMaxLoopDelayMs = loopDelay.max / 1e6;
    roundTrips.length = 0;
    loopDelay.reset();

    const promotionStartedAt = performance.now();
    const response = await fetch(`${handle.apiBaseUrl}/api/v2/action/workspace.promote`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        "X-Tmux-Ide-Operation-Id": randomUUID(),
        Connection: "close",
      },
      body: JSON.stringify({ sessionId: fleetSessionIdForName(targetSession) }),
    });
    const promotionMs = performance.now() - promotionStartedAt;
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as { ok?: boolean; result?: unknown };
    expect(envelope.ok).toBe(true);
    expect(WorkspacePromoteMutationResultSchemaZ.parse(envelope.result).outcome).toBe("promoted");

    // Drain: the pong for a ping sent during the promotion may still be in
    // flight; give the probe one more scheduling slice before reading.
    await new Promise((resolve) => setTimeout(resolve, 50));
    loopDelay.disable();
    probeProcess.kill("SIGKILL");
    probeProcess = null;

    const promotionMaxRoundTripMs = Math.max(...roundTrips);
    const promotionMaxLoopDelayMs = loopDelay.max / 1e6;
    const report = {
      panes: WINDOWS * PANES_PER_WINDOW,
      promotionMs: Number(promotionMs.toFixed(1)),
      idleMaxRoundTripMs: Number(idleMaxRoundTripMs.toFixed(1)),
      idleMaxLoopDelayMs: Number(idleMaxLoopDelayMs.toFixed(1)),
      promotionProbes: roundTrips.length,
      promotionMaxRoundTripMs: Number(promotionMaxRoundTripMs.toFixed(1)),
      promotionMaxLoopDelayMs: Number(promotionMaxLoopDelayMs.toFixed(1)),
    };
    console.info(`[promotion-stall] ${JSON.stringify(report)}`);
    // Passing-test console output is not surfaced by every reporter; a
    // measurement run can ask for the report as a JSON line in a file.
    const reportPath = process.env.TMUX_IDE_PROMOTION_STALL_REPORT;
    if (reportPath) appendFileSync(reportPath, `${JSON.stringify(report)}\n`);

    // A synchronous promotion answers no pongs until it finishes; an async one
    // keeps answering throughout, so the probe count scales with promotionMs.
    expect(roundTrips.length).toBeGreaterThan(5);
    expect(promotionMaxRoundTripMs).toBeLessThan(100);
    expect(promotionMaxLoopDelayMs).toBeLessThan(100);
  });
});
