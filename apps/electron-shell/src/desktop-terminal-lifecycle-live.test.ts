import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  type DesktopDaemonHostState,
  type TerminalAttachRequest,
} from "@tmux-ide/contracts";

import {
  createNativeTerminalWebSocketTransport,
  type NativeTerminalEvent,
  type NativeTerminalWebSocket,
  type NativeTerminalWebSocketFactory,
} from "../../desktop-renderer/src/terminal/native-terminal-transport.ts";
import { WorkspaceRegistry } from "../../../packages/daemon/src/lib/workspace-registry.ts";
import { GROUPED_TMUX_VIEW_SESSION_PREFIX } from "../../../packages/daemon/src/terminal/attachments/grouped-tmux.ts";
import { DaemonConnectionCoordinator } from "./daemon-connection-coordinator.ts";
import { canonicalDaemonPreflight, runDaemonPreflight } from "./daemon-preflight.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repoRoot, "bin/cli.js");
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const hasNodePty =
  spawnSync(process.execPath, ["-e", "require('node-pty')"], {
    cwd: repoRoot,
    stdio: "ignore",
  }).status === 0;
const hasLiveTerminalDependencies = hasTmux && hasNodePty;
const rendererOrigin = "tmux-ide://app";

type SocketEventType = Parameters<NativeTerminalWebSocket["addEventListener"]>[0];
type SocketListener = Parameters<NativeTerminalWebSocket["addEventListener"]>[1];

interface SocketCounters {
  connections: number;
  outboundBinaryFrames: number;
}

interface ChildOutput {
  stdout: string;
  stderr: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitUntil<T>(read: () => T | null, message: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(message);
}

function countingWebSocketFactory(counters: SocketCounters): NativeTerminalWebSocketFactory {
  return (url, protocol) => {
    counters.connections += 1;
    const socket = new WebSocket(url, protocol, { origin: rendererOrigin });
    const registrations = new Map<SocketEventType, Map<SocketListener, (event: unknown) => void>>();
    return {
      get readyState() {
        return socket.readyState;
      },
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      get protocol() {
        return socket.protocol;
      },
      get binaryType() {
        return socket.binaryType as BinaryType;
      },
      set binaryType(value: BinaryType) {
        socket.binaryType = value === "blob" ? "arraybuffer" : value;
      },
      addEventListener(type, listener) {
        const wrapped = (event: unknown): void => {
          listener({
            data:
              type === "message" && typeof event === "object" && event !== null && "data" in event
                ? event.data
                : undefined,
          });
        };
        const byListener = registrations.get(type) ?? new Map();
        byListener.set(listener, wrapped);
        registrations.set(type, byListener);
        socket.addEventListener(type, wrapped);
      },
      removeEventListener(type, listener) {
        const wrapped = registrations.get(type)?.get(listener);
        if (!wrapped) return;
        registrations.get(type)?.delete(listener);
        socket.removeEventListener(type, wrapped);
      },
      send(data) {
        if (typeof data !== "string") counters.outboundBinaryFrames += 1;
        socket.send(data);
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    };
  };
}

describe
  .skipIf(!hasLiveTerminalDependencies)
  .sequential("desktop terminal lifecycle against an isolated canonical daemon", () => {
    // Keep both the tmux and canonical Unix-domain paths below macOS limits.
    // A skipped suite must not allocate a directory that its hooks never clean.
    const root = hasLiveTerminalDependencies
      ? mkdtempSync(join(tmpdir(), "tmux-ide-terminal-e2e-"))
      : join(tmpdir(), "tmux-ide-terminal-e2e-unavailable");
    const socketPath = join(root, "tmux.sock");
    const daemonInfoDir = join(root, "daemon");
    const registryDir = join(root, "registry");
    const settingsDir = join(root, "settings");
    const homeDir = join(root, "home");
    const noReplayProof = join(root, "no-replay-proof");
    // Application-shell discovery currently gates registered sessions by
    // workspace name rather than the catalog's explicit sessionName mapping.
    // Keep this fixture on that supported path; a differing-name case belongs
    // in the discovery contract once that production limitation is fixed.
    const workspaceName = "desktop-terminal-e2e";
    const sessionName = workspaceName;
    const seedSemanticPaneId = "pane.desktop-terminal-seed";
    const executablePath = hasTmux
      ? realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim())
      : "tmux";
    const previousEnvironment: Record<string, string | undefined> = {};
    const children = new Set<ChildProcessWithoutNullStreams>();
    const childOutput = new WeakMap<ChildProcessWithoutNullStreams, ChildOutput>();

    const runTmux = (argv: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...argv], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        env: { TERM: process.env.TERM ?? "xterm-256color" },
        stdio: ["ignore", "pipe", "pipe"],
      }).replace(/(?:\r?\n)+$/u, "");

    const viewSessions = (): string[] => {
      const output = runTmux(["list-sessions", "-F", "#{session_name}"]);
      return output.split("\n").filter((name) => name.startsWith(GROUPED_TMUX_VIEW_SESSION_PREFIX));
    };

    const spawnDaemon = (): ChildProcessWithoutNullStreams => {
      const child = spawn(process.execPath, [cliPath, "--headless", "--json"], {
        cwd: root,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const output = { stdout: "", stderr: "" };
      childOutput.set(child, output);
      child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
      return child;
    };

    const waitForChildExit = async (
      child: ChildProcessWithoutNullStreams,
      timeoutMs = 10_000,
    ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      return await new Promise((resolveExit, reject) => {
        const timeout = setTimeout(() => {
          const output = childOutput.get(child);
          reject(
            new Error(
              `daemon child did not exit; stdout=${output?.stdout ?? ""}; stderr=${output?.stderr ?? ""}`,
            ),
          );
        }, timeoutMs);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolveExit({ code, signal });
        });
      });
    };

    const waitForConnectedDaemon = async (
      excludedInstanceId?: string,
    ): Promise<Extract<DesktopDaemonHostState, { status: "connected" }>> => {
      const deadline = Date.now() + 12_000;
      let last: DesktopDaemonHostState | null = null;
      while (Date.now() < deadline) {
        last = await runDaemonPreflight(canonicalDaemonPreflight, 1_000);
        if (
          last.status === "connected" &&
          (excludedInstanceId === undefined || last.descriptor.instanceId !== excludedInstanceId)
        ) {
          return last;
        }
        await delay(50);
      }
      const diagnostics = [...children]
        .map((child) => childOutput.get(child))
        .filter((output): output is ChildOutput => output !== undefined);
      throw new Error(
        `canonical daemon did not become connected: ${JSON.stringify({ last, diagnostics })}`,
      );
    };

    const transportFor = (coordinator: DaemonConnectionCoordinator, counters: SocketCounters) =>
      createNativeTerminalWebSocketTransport({
        createWebSocket: countingWebSocketFactory(counters),
        issueAttachment: async (attachment: TerminalAttachRequest) => {
          const state = coordinator.state();
          if (state.status !== "connected") throw new Error("daemon authority unavailable");
          const issued = await coordinator.issueTerminalAttachment(
            {
              requestId: randomUUID(),
              expectedDaemonInstanceId: state.identity.instanceId,
              attachment,
            },
            rendererOrigin,
          );
          if (issued.status !== "issued") throw new Error(issued.error.code);
          return issued.descriptor;
        },
      });

    beforeAll(() => {
      for (const name of [
        "HOME",
        "TMUX",
        "TMUX_IDE_DAEMON_INFO_DIR",
        "TMUX_IDE_HOME",
        "TMUX_IDE_REGISTRY_DIR",
        "TMUX_IDE_SETTINGS_DIR",
        "TMUX_IDE_TMUX_BIN",
      ]) {
        previousEnvironment[name] = process.env[name];
      }
      for (const directory of [daemonInfoDir, registryDir, settingsDir, homeDir]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
      }
      process.env.HOME = homeDir;
      process.env.TMUX_IDE_DAEMON_INFO_DIR = daemonInfoDir;
      process.env.TMUX_IDE_HOME = root;
      process.env.TMUX_IDE_REGISTRY_DIR = registryDir;
      process.env.TMUX_IDE_SETTINGS_DIR = settingsDir;
      process.env.TMUX_IDE_TMUX_BIN = executablePath;

      runTmux([
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        sessionName,
        "-c",
        root,
        "-n",
        "seed",
        "exec sleep 300",
      ]);
      runTmux([
        "set-option",
        "-p",
        "-t",
        `=${sessionName}:0.0`,
        "@tmux_ide_pane_id",
        seedSemanticPaneId,
      ]);
      process.env.TMUX = `${socketPath},${process.pid},0`;

      const registry = new WorkspaceRegistry({
        dir: registryDir,
        listSessions: () => [sessionName],
      });
      registry.add({ name: workspaceName, sessionName, projectDir: root });
    });

    afterAll(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(
        [...children].map((child) => waitForChildExit(child).catch(() => undefined)),
      );
      spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });

    it("creates through Electron authority, streams a real PTY, and survives crash/restart without input replay", async () => {
      const firstChild = spawnDaemon();
      const firstDaemon = await waitForConnectedDaemon();
      expect(firstDaemon.descriptor.instanceId).toBeTruthy();
      const firstCoordinator = new DaemonConnectionCoordinator({
        initialDaemon: firstDaemon,
        preflight: canonicalDaemonPreflight,
      });

      const listed = await firstCoordinator.listWorkspaces();
      expect(listed).toMatchObject({
        status: "ok",
        daemon: { instanceId: firstDaemon.descriptor.instanceId },
        workspaces: [{ workspaceName }],
      });

      const operationId = randomUUID();
      const created = await firstCoordinator.createWorkspacePane({
        operationId,
        expectedDaemonInstanceId: firstDaemon.descriptor.instanceId,
        intent: { kind: "terminal", workspaceName, displayTitle: "Lifecycle proof" },
      });
      expect(created).toMatchObject({
        operationId,
        daemonInstanceId: firstDaemon.descriptor.instanceId,
        outcome: "created",
        resource: { kind: "terminal", workspaceName, displayTitle: "Lifecycle proof" },
      });

      const runtimeRows = runTmux([
        "list-panes",
        "-s",
        "-t",
        `=${sessionName}`,
        "-F",
        "#{window_id}|#{pane_id}|#{@tmux_ide_pane_id}",
      ])
        .split("\n")
        .map((line) => line.split("|"));
      const createdRuntime = runtimeRows.find(
        ([, , semanticPaneId]) => semanticPaneId === created.resource.semanticPaneId,
      );
      expect(createdRuntime, JSON.stringify(runtimeRows)).toEqual([
        expect.stringMatching(/^@[0-9]+$/u),
        expect.any(String),
        created.resource.semanticPaneId,
      ]);

      // The current application-shell resource can inventory the selected
      // window. Target issuance below independently proves all-window semantic
      // resolution through the daemon attachment catalog.
      runTmux(["select-window", "-t", createdRuntime![0]!]);
      const shell = await firstCoordinator.fetchApplicationShell(workspaceName);
      expect(shell.status, JSON.stringify(shell)).toBe("ok");
      expect(shell).toMatchObject({
        status: "ok",
        envelope: {
          daemon: { instanceId: firstDaemon.descriptor.instanceId },
          resource: {
            focus: { appFocusedPaneId: created.resource.semanticPaneId },
            project: { readiness: { state: "ready" } },
          },
        },
      });

      const request: TerminalAttachRequest = {
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        target: {
          workspaceName,
          semanticPaneId: created.resource.semanticPaneId,
        },
        viewerMode: "interactive",
        viewport: { cols: 100, rows: 30 },
      };
      const firstCounters: SocketCounters = { connections: 0, outboundBinaryFrames: 0 };
      const firstEvents: NativeTerminalEvent[] = [];
      const firstConnection = await transportFor(firstCoordinator, firstCounters).connect(
        request,
        (event) => {
          firstEvents.push(event);
        },
      );
      expect(firstConnection.status).toBe("connected");
      if (firstConnection.status !== "connected") throw new Error(firstConnection.error.reason);
      expect(firstCounters).toEqual({ connections: 1, outboundBinaryFrames: 0 });
      expect(viewSessions()).toHaveLength(1);

      const outputMarker = `TMUX_IDE_E2E_${randomUUID().replaceAll("-", "")}`;
      const acknowledged = await firstConnection.attachment.write(
        new TextEncoder().encode(`printf '${outputMarker}\\n'\r`),
      );
      expect(acknowledged).toEqual({ status: "ok" });
      expect(firstCounters.outboundBinaryFrames).toBe(1);
      await waitUntil(
        () =>
          Buffer.concat(
            firstEvents.flatMap((event) =>
              event.type === "output" ? [Buffer.from(event.bytes)] : [],
            ),
          )
            .toString("utf8")
            .includes(outputMarker)
            ? true
            : null,
        "bounded input was acknowledged but its command output was not observed",
      );

      const resized = await firstConnection.attachment.resize({ cols: 91, rows: 27 });
      expect(resized).toEqual({ status: "ok" });
      await waitUntil(
        () =>
          firstEvents.some(
            (event) =>
              event.type === "geometry" &&
              event.clientViewport.cols === 91 &&
              event.clientViewport.rows === 27,
          )
            ? true
            : null,
        "daemon-authoritative resized geometry was not observed",
      );

      // Kill immediately after handing one complete frame to the OS. The
      // result is deliberately uncertain (accepted+acked, accepted without an
      // observed ack, or never accepted), but the next generation must never
      // replay it. The durable file therefore contains at most one `x`.
      const uncertainWrite = firstConnection.attachment.write(
        new TextEncoder().encode(`printf x >> '${noReplayProof}'\r`),
      );
      expect(firstCounters.outboundBinaryFrames).toBe(2);
      expect(firstChild.kill("SIGKILL")).toBe(true);
      await expect(waitForChildExit(firstChild)).resolves.toMatchObject({ signal: "SIGKILL" });
      await expect(
        Promise.race([
          uncertainWrite,
          delay(5_000).then(() => {
            throw new Error("in-flight terminal write did not settle after daemon crash");
          }),
        ]),
      ).resolves.toMatchObject({ status: expect.stringMatching(/^(?:ok|error)$/u) });
      await waitUntil(
        () =>
          firstEvents.some((event) => event.type === "state" && event.state === "disconnected")
            ? true
            : null,
        "renderer transport did not observe the daemon crash",
      );
      expect(existsSync(join(daemonInfoDir, "daemon.json"))).toBe(true);
      expect(viewSessions()).toHaveLength(1);
      firstCoordinator.dispose();

      const secondChild = spawnDaemon();
      const secondDaemon = await waitForConnectedDaemon(firstDaemon.descriptor.instanceId);
      expect(secondDaemon.descriptor.instanceId).not.toBe(firstDaemon.descriptor.instanceId);
      expect(viewSessions()).toEqual([]);
      const secondCoordinator = new DaemonConnectionCoordinator({
        initialDaemon: secondDaemon,
        preflight: canonicalDaemonPreflight,
      });
      const secondCounters: SocketCounters = { connections: 0, outboundBinaryFrames: 0 };
      const secondEvents: NativeTerminalEvent[] = [];
      const secondConnection = await transportFor(secondCoordinator, secondCounters).connect(
        request,
        (event) => {
          secondEvents.push(event);
        },
      );
      expect(secondConnection.status).toBe("connected");
      if (secondConnection.status !== "connected") throw new Error(secondConnection.error.reason);
      await delay(200);
      expect(secondCounters).toEqual({ connections: 1, outboundBinaryFrames: 0 });

      const beforeExplicitInput = existsSync(noReplayProof)
        ? readFileSync(noReplayProof, "utf8")
        : "";
      expect(beforeExplicitInput === "" || beforeExplicitInput === "x").toBe(true);
      await expect(
        secondConnection.attachment.write(
          new TextEncoder().encode(`printf y >> '${noReplayProof}'\r`),
        ),
      ).resolves.toEqual({ status: "ok" });
      await waitUntil(
        () =>
          existsSync(noReplayProof) && readFileSync(noReplayProof, "utf8").includes("y")
            ? readFileSync(noReplayProof, "utf8")
            : null,
        "explicit post-reconnect terminal input did not execute",
      );
      const afterExplicitInput = readFileSync(noReplayProof, "utf8");
      expect(afterExplicitInput.match(/x/gu)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(afterExplicitInput.match(/y/gu)?.length ?? 0).toBe(1);
      expect(secondCounters.outboundBinaryFrames).toBe(1);

      expect(secondChild.kill("SIGTERM")).toBe(true);
      await expect(waitForChildExit(secondChild)).resolves.toEqual({ code: 0, signal: null });
      await waitUntil(
        () => (!existsSync(join(daemonInfoDir, "daemon.json")) ? true : null),
        "graceful daemon shutdown left canonical ownership behind",
      );
      await waitUntil(
        () => (viewSessions().length === 0 ? true : null),
        "graceful daemon shutdown left a grouped terminal view behind",
      );
      await waitUntil(
        () =>
          secondEvents.some((event) => event.type === "state" && event.state === "disconnected")
            ? true
            : null,
        "renderer transport did not observe graceful daemon shutdown",
      );
      secondCoordinator.dispose();

      const survivingSemanticIds = runTmux([
        "list-panes",
        "-s",
        "-t",
        `=${sessionName}`,
        "-F",
        "#{@tmux_ide_pane_id}",
      ]).split("\n");
      expect(survivingSemanticIds).toEqual(
        expect.arrayContaining([seedSemanticPaneId, created.resource.semanticPaneId]),
      );
    }, 45_000);
  });
