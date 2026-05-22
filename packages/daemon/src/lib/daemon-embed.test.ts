import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "./daemon-embed.ts";
import { DaemonStartupError } from "./errors.ts";
import { defaultPtyBridgeRegistry, type PtyBridgeLike } from "../server/ws-route.ts";
import { activateProject, listActiveProjects, setActivationBackend } from "./active-projects.ts";
import { _resetCacheForTests, registerProject } from "./project-registry.ts";
import { isCanonicalDaemonAlive, readCanonicalDaemonInfo } from "./canonical-daemon.ts";
import { writeAppSettings } from "./app-settings.ts";
import { appSetRemoteAccessHandler } from "../command-center/actions/handlers/app-set-remote-access.ts";

function tmux(...args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf-8" }).trim();
}

function createTmuxSession(): string {
  const sessionName = `tmux-ide-embed-test-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  tmux("new-session", "-d", "-s", sessionName, "sleep", "300");
  return sessionName;
}

function killTmuxSession(sessionName: string | null): void {
  if (!sessionName) return;
  try {
    tmux("kill-session", "-t", sessionName);
  } catch {
    // already gone
  }
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

async function waitForDaemonInfo(
  predicate: (info: NonNullable<ReturnType<typeof readCanonicalDaemonInfo>>) => boolean,
): Promise<NonNullable<ReturnType<typeof readCanonicalDaemonInfo>>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const info = readCanonicalDaemonInfo();
    if (info && predicate(info) && (await isCanonicalDaemonAlive(info))) return info;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for daemon info");
}

class FakeBridge extends EventEmitter implements PtyBridgeLike {
  killed: NodeJS.Signals[] = [];
  running = true;

  spawn(): void {}
  write(): void {}
  resize(): void {}
  pause(): void {}
  resume(): void {}
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.killed.push(signal);
    this.running = false;
    this.emit("exit", { exitCode: 0, signal: 15 });
  }
}

describe("startEmbeddedDaemon", () => {
  let sessionName: string | null = null;
  let handle: EmbeddedDaemonHandle | null = null;
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-embed-"));
    writeFileSync(
      join(tmpDir, "ide.yml"),
      "name: embed-test\nrows:\n  - panes:\n      - title: Shell\n",
    );
    process.chdir(tmpDir);
    process.env.TMUX_IDE_REGISTRY_DIR = join(tmpDir, "registry");
    process.env.TMUX_IDE_SETTINGS_DIR = join(tmpDir, "settings");
    _resetCacheForTests();
    sessionName = createTmuxSession();
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = null;
    killTmuxSession(sessionName);
    sessionName = null;
    delete process.env.TMUX_IDE_REGISTRY_DIR;
    delete process.env.TMUX_IDE_SETTINGS_DIR;
    _resetCacheForTests();
    setActivationBackend(null);
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts on a free port and returns resolvable URLs", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });

    expect(handle.port).toBeGreaterThan(0);
    expect(handle.apiBaseUrl).toBe(`http://127.0.0.1:${handle.port}`);
    expect(handle.wsUrl).toBe(`ws://127.0.0.1:${handle.port}/ws/events`);
    expect(readCanonicalDaemonInfo()).toMatchObject({
      pid: process.pid,
      port: handle.port,
      bindHostname: "127.0.0.1",
      authToken: null,
    });
  });

  it("clears the canonical daemon file on stop", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });
    expect(readCanonicalDaemonInfo()?.port).toBe(handle.port);

    await handle.stop();

    expect(readCanonicalDaemonInfo()).toBeNull();
  });

  it("uses persisted remote access settings when no bind options are supplied", async () => {
    killTmuxSession(sessionName);
    sessionName = null;
    writeAppSettings({ remoteAccess: { enabled: true, token: "persisted-token" } });

    handle = await startEmbeddedDaemon({});

    expect(readCanonicalDaemonInfo()).toMatchObject({
      bindHostname: "0.0.0.0",
      authToken: "persisted-token",
    });
  });

  it("exposes a local bypass token without persisting it in daemon.json", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });

    expect(typeof handle.localBypassToken).toBe("string");
    expect(handle.localBypassToken?.length).toBeGreaterThan(20);
    expect(readCanonicalDaemonInfo()).not.toHaveProperty("localBypassToken");
  });

  it("refuses to start when a canonical daemon is already live", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });

    await expect(startEmbeddedDaemon({})).rejects.toMatchObject({
      name: "DaemonStartupError",
      reason: "canonical_already_running",
    } satisfies Partial<DaemonStartupError>);
  });

  it("/health returns 200 after start resolves", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });

    const res = await fetch(`${handle.apiBaseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("stop closes WS clients with code 1001", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });
    const ws = new WebSocket(handle.wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    await new Promise<void>((resolve) => {
      ws.once("message", () => resolve());
    });

    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await handle.stop({ gracefulMs: 50 });
    const result = await close;

    // Bun's ws shim normalizes server-side 1001 to 1000, but preserves
    // the "going away" reason; Node's ws reports 1001.
    expect([1001, 1000]).toContain(result.code);
    expect(result.reason).toBe("going away");
  });

  it("accepts WebSocket upgrades with the local bypass token when remote auth is enabled", async () => {
    killTmuxSession(sessionName);
    sessionName = null;
    handle = await startEmbeddedDaemon({ bindHostname: "0.0.0.0", authToken: "remote-token" });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/events`, {
      headers: { Authorization: `Bearer ${handle.localBypassToken}` },
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    ws.close();
  });

  it("accepts WebSocket upgrades on a loopback bind without any token (T085)", async () => {
    killTmuxSession(sessionName);
    sessionName = null;
    handle = await startEmbeddedDaemon({ bindHostname: "127.0.0.1", authToken: "remote-token" });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/events`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.close();
  });

  it("closes WebSocket upgrades with 1008 for the wrong token", async () => {
    killTmuxSession(sessionName);
    sessionName = null;
    handle = await startEmbeddedDaemon({ bindHostname: "0.0.0.0", authToken: "remote-token" });
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/ws/events`, {
      headers: { Authorization: "Bearer wrong-token" },
    });

    const close = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      ws.once("error", reject);
    });

    expect(close.code).toBe(1008);
  });

  it("remote access toggles keep the port pinned and refresh daemon.json", async () => {
    killTmuxSession(sessionName);
    sessionName = null;
    handle = await startEmbeddedDaemon({});
    const port = handle.port;

    await appSetRemoteAccessHandler(
      { enabled: true },
      { generateToken: () => "remote-token-a", host: "host.local", port },
    );
    const enabled = await waitForDaemonInfo(
      (info) =>
        info.port === port &&
        info.bindHostname === "0.0.0.0" &&
        info.authToken === "remote-token-a",
    );
    expect(enabled.port).toBe(port);

    const noToken = await fetch(`http://127.0.0.1:${port}/api/auth/token`, { method: "POST" });
    expect(noToken.status).toBe(401);
    const localBypass = await fetch(`http://127.0.0.1:${port}/api/auth/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${handle.localBypassToken}` },
      body: JSON.stringify({ userId: "test" }),
    });
    expect(localBypass.status).toBe(200);

    await appSetRemoteAccessHandler({ enabled: false }, { host: "host.local", port });
    const disabled = await waitForDaemonInfo(
      (info) => info.port === port && info.bindHostname === "127.0.0.1" && info.authToken === null,
    );
    expect(disabled.port).toBe(port);

    await appSetRemoteAccessHandler(
      { enabled: true },
      { generateToken: () => "remote-token-b", host: "host.local", port },
    );
    const reenabled = await waitForDaemonInfo(
      (info) =>
        info.port === port &&
        info.bindHostname === "0.0.0.0" &&
        info.authToken === "remote-token-b",
    );
    expect(reenabled.port).toBe(port);
  });

  it("stop is idempotent", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });

    await handle.stop();
    await handle.stop();
  });

  it("throws a typed startup error when the port is already in use", async () => {
    const occupied = createServer((_req, res) => res.end("busy"));
    const occupiedPort = await listen(occupied);
    try {
      await expect(
        startEmbeddedDaemon({ sessionName: sessionName!, port: occupiedPort }),
      ).rejects.toMatchObject({
        name: "DaemonStartupError",
        reason: "port_in_use",
      } satisfies Partial<DaemonStartupError>);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("SIGTERMs PTY bridges in the registry on stop", async () => {
    handle = await startEmbeddedDaemon({ sessionName: sessionName! });
    const bridge = new FakeBridge();
    defaultPtyBridgeRegistry.acquire("embed-test-pty", () => bridge, { idleMs: 60_000 });

    await handle.stop();

    expect(bridge.killed).toContain("SIGTERM");
  });

  it("starts without a sessionName and does not require tmux", async () => {
    killTmuxSession(sessionName);
    sessionName = null;

    handle = await startEmbeddedDaemon({});

    expect(handle.port).toBeGreaterThan(0);
    const res = await fetch(`${handle.apiBaseUrl}/api/daemon/health`);
    expect(await res.json()).toMatchObject({ session: "__embedded__" });
  });

  it("does not start the orchestrator at boot in sessionless mode", async () => {
    const started: string[] = [];

    handle = await startEmbeddedDaemon({
      orchestratorStarter: async (name) => {
        started.push(name);
        return () => {};
      },
    });

    expect(started).toEqual([]);
  });

  it("activates a registered project and stop tears it down", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tmux-ide-embed-project-"));
    writeFileSync(
      join(projectDir, "ide.yml"),
      "name: alpha\norchestrator:\n  enabled: true\nrows:\n  - panes:\n      - title: Shell\n",
    );
    await registerProject({ dir: projectDir, name: "alpha" });
    const stops: string[] = [];

    handle = await startEmbeddedDaemon({
      orchestratorStarter: async (name) => {
        return () => {
          stops.push(name);
        };
      },
    });

    await handle.activateProject("alpha", { orchestrate: true });
    await handle.stop();

    expect(stops).toEqual(["alpha"]);
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("supports two active projects and stops them in activation order", async () => {
    const projectA = mkdtempSync(join(tmpdir(), "tmux-ide-embed-project-a-"));
    const projectB = mkdtempSync(join(tmpdir(), "tmux-ide-embed-project-b-"));
    writeFileSync(
      join(projectA, "ide.yml"),
      "name: alpha\norchestrator:\n  enabled: true\nrows:\n  - panes:\n      - title: Shell\n",
    );
    writeFileSync(
      join(projectB, "ide.yml"),
      "name: beta\norchestrator:\n  enabled: true\nrows:\n  - panes:\n      - title: Shell\n",
    );
    await registerProject({ dir: projectA, name: "alpha" });
    await registerProject({ dir: projectB, name: "beta" });
    const stops: string[] = [];

    handle = await startEmbeddedDaemon({
      orchestratorStarter: async (name) => {
        return () => {
          stops.push(name);
        };
      },
    });

    await activateProject("alpha", { orchestrate: true });
    await activateProject("beta", { orchestrate: true });
    expect(listActiveProjects()).toEqual(["alpha", "beta"]);

    await handle.stop();

    expect(stops).toEqual(["alpha", "beta"]);
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it("does not start project orchestrators unless activation opts in", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "tmux-ide-embed-project-"));
    writeFileSync(
      join(projectDir, "ide.yml"),
      "name: alpha\norchestrator:\n  enabled: true\nrows:\n  - panes:\n      - title: Shell\n",
    );
    await registerProject({ dir: projectDir, name: "alpha" });
    const started: string[] = [];

    handle = await startEmbeddedDaemon({
      orchestratorStarter: async (name) => {
        started.push(name);
        return () => {};
      },
    });

    await activateProject("alpha");

    expect(started).toEqual([]);
    rmSync(projectDir, { recursive: true, force: true });
  });
});
