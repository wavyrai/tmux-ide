import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 45_000, hookTimeout: 30_000 });
import type { DesktopDaemonHostState } from "@tmux-ide/contracts";

import {
  createPaneStreamTransport,
  type PaneMirrorEvent,
  type PaneStreamTransportError,
  type PaneStreamWebSocket,
  type PaneStreamWebSocketFactory,
} from "../../desktop-renderer/src/terminal/pane-stream-transport.ts";
import { WorkspaceRegistry } from "../../../packages/daemon/src/lib/workspace-registry.ts";
import { DaemonConnectionCoordinator } from "./daemon-connection-coordinator.ts";
import { DaemonResourceBroker } from "./daemon-resource-broker.ts";
import { canonicalDaemonPreflight, runDaemonPreflight } from "./daemon-preflight.ts";
import { inspectCanonicalDaemonInfo } from "../../../packages/daemon/src/lib/canonical-daemon.ts";

type ConnectedDaemonState = Extract<DesktopDaemonHostState, { status: "connected" }>;

function liveBrokerFactory(daemon: ConnectedDaemonState): DaemonResourceBroker {
  const canonical = inspectCanonicalDaemonInfo();
  if (canonical.status !== "valid" || !canonical.info.authToken) {
    throw new Error("canonical daemon owner capability is unavailable");
  }
  return new DaemonResourceBroker({
    daemon,
    ownerToken: canonical.info.authToken,
    requestTimeoutMs: 20_000,
  });
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = join(repoRoot, "bin/cli.js");
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const rendererOrigin = "tmux-ide://app";

interface WireRecord {
  readonly direction: "sent" | "received";
  readonly type: string;
  readonly pane?: string;
  readonly code?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

/** Semantic delivery is projected to ANSI row patches before the xterm sink. */
function visibleTerminalText(value: string): string {
  const ansiEscapeSequence = new RegExp(
    `${String.fromCharCode(27)}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`,
    "gu",
  );
  return value.replace(ansiEscapeSequence, "");
}

async function waitUntil<T>(read: () => T | null, message: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(message);
}

/** Browser-shaped socket over `ws`, auditing every frame that crosses the wire. */
function auditingWebSocketFactory(transcript: WireRecord[]): PaneStreamWebSocketFactory {
  return (url, protocol) => {
    const socket = new WebSocket(url, protocol, { origin: rendererOrigin });
    const record = (direction: "sent" | "received", data: unknown): void => {
      try {
        const frame = JSON.parse(String(data)) as { type?: string; pane?: string; code?: string };
        transcript.push({
          direction,
          type: typeof frame.type === "string" ? frame.type : "unknown",
          ...(typeof frame.pane === "string" ? { pane: frame.pane } : {}),
          ...(typeof frame.code === "string" ? { code: frame.code } : {}),
        });
      } catch {
        transcript.push({ direction, type: "unparseable" });
      }
    };
    const registrations = new Map<string, Map<unknown, (event: unknown) => void>>();
    const facade: PaneStreamWebSocket = {
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
          const data =
            type === "message" && typeof event === "object" && event !== null && "data" in event
              ? typeof (event as { data: unknown }).data === "string"
                ? (event as { data: unknown }).data
                : String(event ? (event as { data: unknown }).data : "")
              : undefined;
          if (type === "message") record("received", data);
          listener({ data });
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
        socket.removeEventListener(type, wrapped as (event: unknown) => void);
      },
      send(data) {
        record("sent", data);
        socket.send(data);
      },
      close(code, reason) {
        socket.close(code, reason);
      },
    };
    return facade;
  };
}

describe
  .skipIf(!hasTmux)
  .sequential("desktop pane-stream mirror against an isolated canonical daemon", () => {
    const root = hasTmux
      ? mkdtempSync(join(tmpdir(), "tmux-ide-pane-stream-e2e-"))
      : join(tmpdir(), "tmux-ide-pane-stream-e2e-unavailable");
    const socketPath = join(root, "tmux.sock");
    const daemonInfoDir = join(root, "daemon");
    const registryDir = join(root, "registry");
    const settingsDir = join(root, "settings");
    const homeDir = join(root, "home");
    const workspaceName = "pane-stream-e2e";
    const sessionName = workspaceName;
    const PANE_ONE = "pane.m43.one";
    const PANE_TWO = "pane.m43.two";
    const PANE_THREE = "pane.m43.three";
    const executablePath = hasTmux
      ? realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim())
      : "tmux";
    const previousEnvironment: Record<string, string | undefined> = {};
    const children = new Set<ChildProcessWithoutNullStreams>();

    const runTmux = (argv: readonly string[]): string =>
      execFileSync(executablePath, ["-S", socketPath, ...argv], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
        env: { TERM: process.env.TERM ?? "xterm-256color" },
        stdio: ["ignore", "pipe", "pipe"],
      }).replace(/(?:\r?\n)+$/u, "");

    const spawnDaemon = (): ChildProcessWithoutNullStreams => {
      const child = spawn(process.execPath, [cliPath, "--headless", "--json"], {
        cwd: root,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.stdout.resume();
      child.stderr.resume();
      return child;
    };

    const waitForConnectedDaemon = async (): Promise<ConnectedDaemonState> => {
      const deadline = Date.now() + 15_000;
      let last: DesktopDaemonHostState | null = null;
      while (Date.now() < deadline) {
        last = await runDaemonPreflight(canonicalDaemonPreflight, 1_000);
        if (last.status === "connected") return last;
        await delay(50);
      }
      throw new Error(`canonical daemon did not become connected: ${JSON.stringify(last)}`);
    };

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

      // A real 3-pane window under verified semantic identity.
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
        "work",
        "exec sh -i",
      ]);
      runTmux(["split-window", "-t", `=${sessionName}:0`, "-c", root, "exec sh -i"]);
      runTmux(["split-window", "-t", `=${sessionName}:0`, "-c", root, "exec sh -i"]);
      runTmux(["select-layout", "-t", `=${sessionName}:0`, "even-horizontal"]);
      const paneIds = runTmux(["list-panes", "-t", `=${sessionName}:0`, "-F", "#{pane_id}"]).split(
        "\n",
      );
      expect(paneIds).toHaveLength(3);
      const semanticIds = [PANE_ONE, PANE_TWO, PANE_THREE];
      for (const [index, paneId] of paneIds.entries()) {
        runTmux(["set-option", "-p", "-t", paneId, "@tmux_ide_pane_id", semanticIds[index]!]);
      }
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
      spawnSync(executablePath, ["-S", socketPath, "kill-server"], { stdio: "ignore" });
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await delay(100);
      rmSync(root, { recursive: true, force: true });
    });

    it("mirrors two panes independently, isolates a flood, and fails closed on topology change", async () => {
      spawnDaemon();
      const daemon = await waitForConnectedDaemon();
      const coordinator = new DaemonConnectionCoordinator({
        initialDaemon: daemon,
        preflight: canonicalDaemonPreflight,
        createBroker: liveBrokerFactory,
      });

      const transcript: WireRecord[] = [];
      const paneBytes = new Map<string, Buffer[]>([
        [PANE_ONE, []],
        [PANE_TWO, []],
        [PANE_THREE, []],
      ]);
      const paneEvents: { pane: string; type: PaneMirrorEvent["type"] }[] = [];
      const ends: (PaneStreamTransportError | null)[] = [];
      const paneText = (pane: string): string =>
        Buffer.concat(paneBytes.get(pane) ?? []).toString("utf8");
      const visiblePaneText = (pane: string): string => visibleTerminalText(paneText(pane));

      const transport = createPaneStreamTransport({
        createWebSocket: auditingWebSocketFactory(transcript),
        issuePaneStream: async (request) => {
          const state = coordinator.state();
          if (state.status !== "connected") throw new Error("daemon authority unavailable");
          const issued = await coordinator.issuePaneStream(
            {
              requestId: randomUUID(),
              expectedDaemonInstanceId: state.identity.instanceId,
              stream: request,
            },
            rendererOrigin,
          );
          if (issued.status !== "issued") throw new Error(issued.error.code);
          return issued.descriptor;
        },
      });

      const connection = await transport.connect(
        { workspaceName, panes: [PANE_ONE, PANE_TWO, PANE_THREE] },
        {
          onPaneEvent: (pane, event) => {
            paneEvents.push({ pane, type: event.type });
            if (event.type === "seed-batch") {
              paneBytes.get(pane)?.push(Buffer.from(event.batch.seed));
              for (const held of event.batch.held) paneBytes.get(pane)?.push(Buffer.from(held));
            } else if (event.type === "output") {
              paneBytes.get(pane)?.push(Buffer.from(event.bytes));
            }
          },
          onEnd: (error) => {
            ends.push(error);
          },
        },
      );
      expect(connection.status, JSON.stringify(connection)).toBe("connected");

      // Every leased pane seeds atomically before (or without) any delta.
      await waitUntil(
        () =>
          [PANE_ONE, PANE_TWO, PANE_THREE].every((pane) =>
            paneEvents.some((event) => event.pane === pane && event.type === "seed-batch"),
          )
            ? true
            : null,
        "every pane must deliver its atomic seed-batch",
      );
      for (const pane of [PANE_ONE, PANE_TWO, PANE_THREE]) {
        const first = paneEvents.find((event) => event.pane === pane);
        expect(first, `first frame for ${pane} must be the seed`).toMatchObject({
          type: "seed-batch",
        });
      }

      // Type into the REAL tmux pane externally: bytes appear in ITS node only.
      const markerOne = `M43_ONE_${randomUUID().slice(0, 8)}`;
      runTmux(["send-keys", "-t", `=${sessionName}:0.0`, `echo ${markerOne}`, "Enter"]);
      await waitUntil(
        () => (visiblePaneText(PANE_ONE).includes(markerOne) ? true : null),
        "external tmux input must stream into the mirror node",
      );
      expect(visiblePaneText(PANE_TWO)).not.toContain(markerOne);

      // Flood pane two; pane one must stay independently live DURING the flood.
      runTmux([
        "send-keys",
        "-t",
        `=${sessionName}:0.1`,
        "i=0; while [ $i -lt 20000 ]; do echo FLOOD-$i; i=$((i+1)); done",
        "Enter",
      ]);
      await waitUntil(
        () => (visiblePaneText(PANE_TWO).includes("FLOOD-") ? true : null),
        "flood output must reach the flooded pane's node",
      );
      const markerDuringFlood = `M43_LIVE_${randomUUID().slice(0, 8)}`;
      runTmux(["send-keys", "-t", `=${sessionName}:0.0`, `echo ${markerDuringFlood}`, "Enter"]);
      await waitUntil(
        () => (visiblePaneText(PANE_ONE).includes(markerDuringFlood) ? true : null),
        "the sibling pane must stay live while another pane floods",
      );
      expect(ends).toEqual([]);

      // Kill a pane: the exact-inventory lease fails closed so WorkspaceClient
      // can refresh topology and reconnect rather than retaining stale lanes.
      runTmux(["kill-pane", "-t", `=${sessionName}:0.2`]);
      await waitUntil(
        () => (ends.length === 1 ? true : null),
        "a killed pane must retire the exact-inventory stream",
      );
      expect(ends).toEqual([
        expect.objectContaining({ code: "topology-changed", retryable: true }),
      ]);

      // Wire transcript audit: one redeem, one lease ready, one semantic lane
      // per pane, semantic ACKs flowing back, and an honest retryable topology
      // retirement when the lease's exact pane inventory changes.
      expect(transcript.filter(({ type }) => type === "redeem")).toHaveLength(1);
      expect(transcript.filter(({ type }) => type === "ready")).toHaveLength(1);
      expect(transcript[0]).toMatchObject({ direction: "sent", type: "redeem" });
      for (const pane of [PANE_ONE, PANE_TWO, PANE_THREE]) {
        expect(
          transcript.some(
            (record) =>
              record.direction === "received" &&
              record.type === "terminal-delivery-ready" &&
              record.pane === pane,
          ),
          `transcript must negotiate the ${pane} semantic lane`,
        ).toBe(true);
      }
      expect(
        transcript.filter(
          (record) => record.direction === "sent" && record.type === "terminal-delivery-ack",
        ).length,
      ).toBeGreaterThan(0);
      expect(
        transcript.some(
          (record) =>
            record.direction === "received" &&
            record.type === "error" &&
            record.code === "topology-changed",
        ),
      ).toBe(true);
      expect(
        transcript.filter((record) => record.direction === "sent" && record.type === "input"),
      ).toHaveLength(0);

      if (connection.status === "connected") {
        connection.session.dispose();
      }
      coordinator.dispose();
    });
  });
