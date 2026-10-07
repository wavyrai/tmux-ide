// Controlled issued-route text correctness only; no HTTP discovery, renderer or resource qualification.
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import {
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  type TerminalDeliveryEnvelope,
} from "@tmux-ide/contracts";
import {
  connectIssuedPaneStreamRuntimeClient,
  type PaneStreamRuntimeClient,
  type PaneStreamClientSocket,
} from "@tmux-ide/daemon-client/pane-stream-client";
import { createTerminalFastLane } from "../../../../daemon-client/src/terminal-fast-lane.ts";
import { runtimeResourceSnapshot } from "@tmux-ide/daemon-client/runtime-resource-ledger";
import { createNativeTmuxServerOwner } from "../../lib/tmux-server-owner.ts";
import { attachPaneStreamWebSocket } from "../../server/pane-stream-upgrade.ts";
import {
  connectOpenTuiWorkspaceRuntimePort,
  type OpenTuiWorkspaceRuntimePort,
} from "../../tui/mirror/open-tui-workspace-runtime-port.ts";
import type { OpenTuiVerifiedRoutingContext } from "../../tui/mirror/open-tui-verified-routing.ts";

const binary = process.env.TMUX_IDE_BOUNDARY_TEST_BINARY;
const enabled = process.env.TMUX_IDE_PRODUCTION_VIEWER_CORRECTNESS === "1" && !!binary;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const absent = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
};
async function until(predicate: () => boolean, label: string) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= end) throw Error(`Timed out: ${label}`);
    await sleep(20);
  }
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Error("cleanup timeout")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

it.skipIf(!enabled)(
  "admits real native output through two production ports and fast lanes",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tmux-production-viewer-"));
    const socket = join(root, "tmux.sock"),
      stop = join(root, "stop"),
      script = join(root, "producer.cjs");
    const receipt = process.env.TMUX_IDE_PRODUCTION_VIEWER_RECEIPT ?? join(root, "receipt.json");
    const env = { ...process.env, TMUX: "", HOME: root, TERM: "xterm-256color" };
    const native = (...args: string[]) =>
      execFileSync(binary!, ["-S", socket, "-f", "/dev/null", ...args], {
        env,
        encoding: "utf8",
        timeout: 3000,
      }).trimEnd();
    const workspace = "soak",
      semantic = "pane.soak0",
      generation = randomUUID();
    const faults: string[] = [],
      cleanup: string[] = [],
      checkpoints: unknown[] = [];
    const sockets: WebSocket[] = [];
    const server = createServer();
    let owner: Awaited<ReturnType<typeof createNativeTmuxServerOwner>> | undefined;
    let boundary: ReturnType<typeof attachPaneStreamWebSocket> | undefined;
    let serverPid = 0,
      producerPid = 0,
      pane = "",
      failure: string | undefined;
    const before = runtimeResourceSnapshot();
    type Viewer = {
      port?: OpenTuiWorkspaceRuntimePort;
      lane?: ReturnType<typeof createTerminalFastLane>;
      client?: PaneStreamRuntimeClient;
      envelope?: TerminalDeliveryEnvelope;
      deliveries: number;
      acks: number;
      closed: boolean;
      release?: () => void;
    };
    const viewers: Viewer[] = [];
    const snapshot = (v: Viewer) => v.lane?.paneState(semantic)?.snapshot;
    const text = (v: Viewer, y: number) =>
      snapshot(v)
        ?.grid[y]?.cells.map((c) => (c.width === 0 ? "" : c.grapheme || " "))
        .join("")
        .trimEnd();
    const retire = async (v: Viewer) => {
      v.closed = true;
      v.release?.();
      v.lane?.dispose();
      await v.port?.close();
      v.client?.close();
    };
    const open = async (interactive: boolean) => {
      const v: Viewer = { deliveries: 0, acks: 0, closed: false };
      viewers.push(v);
      const hostClientId = `production-proof:${randomUUID()}`;
      const assertRoute = (expected: {
        daemonInstanceId: string;
        workspaceName: string;
        sessionName: string;
      }) => {
        expect(expected).toEqual({
          daemonInstanceId: generation,
          workspaceName: workspace,
          sessionName: workspace,
        });
        expect(owner!.sessionRuntimeRegistry.qualificationSnapshot().generation).toBe(generation);
        expect(
          native("display-message", "-p", "-t", pane, "#{session_name}|#{@tmux_ide_pane_id}"),
        ).toBe(`${workspace}|${semantic}`);
        if (v.closed) throw Error("Retired controlled route");
      };
      const routing: OpenTuiVerifiedRoutingContext = {
        daemonInstanceId: generation,
        workspaceName: workspace,
        sessionName: workspace,
        assertCurrent: assertRoute,
        retire: () => {
          v.closed = true;
        },
        openPaneStream: async (expected, options) => {
          assertRoute(expected);
          const stream = {
            ...options.stream,
            viewerMode: interactive ? ("interactive" as const) : ("read-only" as const),
          };
          expect(stream.panes).toEqual([semantic]);
          const descriptor = await owner!.paneStreamRuntime.coordinator.issue(stream, {
            requestId: options.requestId ?? randomUUID(),
            projectIdentity: workspace,
            sessionName: workspace,
            rendererOrigin: options.origin,
            hostClientId,
          });
          const client = await connectIssuedPaneStreamRuntimeClient(
            {
              ...options,
              stream,
              hostClientId,
              requestInitialInputAuthority: interactive,
              createSocket: (d, headers) => {
                const ws = new WebSocket(d.webSocketUrl, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], {
                  headers,
                });
                sockets.push(ws);
                ws.once("close", () => {
                  const i = sockets.indexOf(ws);
                  if (i >= 0) sockets.splice(i, 1);
                });
                // Adapt ws event types without changing its browser-style payloads.
                type Listener = Parameters<PaneStreamClientSocket["addEventListener"]>[1];
                type Event = WebSocket.WebSocketEventMap[keyof WebSocket.WebSocketEventMap];
                const listeners = new Map<string, Map<Listener, (event: Event) => void>>();
                const adapted: PaneStreamClientSocket = {
                  get readyState() {
                    return ws.readyState;
                  },
                  get bufferedAmount() {
                    return ws.bufferedAmount;
                  },
                  send: (data) => ws.send(data),
                  close: (code, reason) => ws.close(code, reason),
                  addEventListener(type, listener) {
                    let entries = listeners.get(type);
                    if (!entries) {
                      entries = new Map();
                      listeners.set(type, entries);
                    }
                    if (entries.has(listener)) return;
                    const callback = (event: Event) => {
                      if ("data" in event) listener({ data: event.data });
                      else if ("code" in event)
                        listener({ code: event.code, reason: event.reason });
                      else listener({});
                    };
                    entries.set(listener, callback);
                    ws.addEventListener(type, callback);
                  },
                  removeEventListener(type, listener) {
                    const entries = listeners.get(type),
                      callback = entries?.get(listener);
                    if (callback) {
                      ws.removeEventListener(type, callback);
                      entries!.delete(listener);
                    }
                    if (entries?.size === 0) listeners.delete(type);
                  },
                };
                return adapted;
              },
              onTerminalDelivery: (p, message) => {
                if (message.type === "terminal.delivery") v.envelope = message;
                return options.onTerminalDelivery(p, message);
              },
              onFault: (f) => {
                faults.push(String(f));
                options.onFault?.(f);
              },
            },
            {
              ...descriptor,
              panes: [...descriptor.panes],
              subprotocol: PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
            },
          );
          const ack = client.ack.bind(client);
          client.ack = (message) => {
            if (v.closed) throw Error("ACK after retirement");
            v.acks++;
            ack(message);
          };
          v.client = client;
          return client;
        },
      };
      v.port = await connectOpenTuiWorkspaceRuntimePort({
        inventory: {
          workspaceName: workspace,
          workspaceId: "isolated-proof",
          sessionId: workspace,
          daemonGeneration: generation,
          shellGeneration: 1,
          semanticPaneIds: [semantic],
        },
        routing,
        onFault: (e) => faults.push(String(e)),
        prepareRuntime: async (port) => {
          const subscription = await port.subscribeTerminal({
            workspaceName: workspace,
            semanticPaneId: semantic,
          });
          if (!port.ownsConnectionAuthority || !port.requestAuthority)
            throw Error("Production authority methods unavailable");
          const ownsAuthority = port.ownsConnectionAuthority.bind(port);
          const requestAuthority = port.requestAuthority.bind(port);
          v.lane = createTerminalFastLane({
            address: { workspaceName: workspace, generation },
            source: { subscribe: (_a, listener) => subscription.onUpdate(listener) },
            control: {
              owns: (authority) => ownsAuthority(authority),
              request: async (authority) => {
                await requestAuthority(authority);
                return ownsAuthority(authority);
              },
              write: (target, input) => port.sendTerminalInput(target, input),
              resize: (_target, viewport) =>
                port.fitViewport(viewport.cols, viewport.rows, viewport.semanticWindowId),
            },
            repair: {
              request: (r) => {
                faults.push(`repair:${r.reason}`);
                port.requestTerminalRepair?.(r.address, r.reason);
              },
            },
          });
          v.release = v.lane.subscribePane(semantic, () => {
            v.deliveries++;
          });
        },
      });
      await until(() => !!snapshot(v) && v.acks > 0, "production canonical admission");
      return v;
    };
    const visibility = (v: Viewer, value: "hidden" | "visible") => {
      const e = v.envelope!;
      v.client!.setVisibility(
        {
          workspaceName: workspace,
          pane: semantic,
          generation: e.generation,
          incarnation: e.incarnation,
          deliveryNonce: e.deliveryNonce,
        },
        value,
      );
    };
    const checkpoint = async (vs: Viewer[], label: string) => {
      writeFileSync(stop, "checkpoint");
      await sleep(150);
      const dims = native("display-message", "-p", "-t", pane, "#{pane_width}|#{pane_height}")
        .split("|")
        .map(Number);
      expect(dims).toEqual([100, 24]);
      const rows = native("capture-pane", "-p", "-t", pane).split("\n");
      await until(() => vs.every((v) => text(v, 0) === rows[0] && text(v, 1) === rows[1]), label);
      for (const v of vs) {
        const s = snapshot(v)!;
        expect(s.cols).toBe(100);
        expect(s.rows).toBe(24);
        for (let y = 2; y < s.rows; y++) expect(text(v, y)).toBe("");
      }
      checkpoints.push({ label, rows: rows.slice(0, 2), viewers: vs.length });
      unlinkSync(stop);
    };
    try {
      writeFileSync(
        script,
        "const fs=require('node:fs');let n=0,input='';process.stdin.setRawMode(true);function draw(){process.stdout.write('\\x1b[2J\\x1b[HP0 '+n+'\\x1b[2;1HINPUT '+input+'\\x1b[3;1H')}process.stdin.on('data',b=>{input=b.toString('hex');draw()});setInterval(()=>{if(!fs.existsSync(process.argv[2])){n++;draw()}},100);draw();",
      );
      pane = native(
        "new-session",
        "-d",
        "-s",
        workspace,
        "-x",
        "100",
        "-y",
        "24",
        "-P",
        "-F",
        "#{pane_id}",
        `exec ${quote(process.execPath)} ${quote(script)} ${quote(stop)}`,
      );
      serverPid = Number(native("display-message", "-p", "-t", pane, "#{pid}"));
      producerPid = Number(native("display-message", "-p", "-t", pane, "#{pane_pid}"));
      const birth = (pid: number) =>
        execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 1000,
        }).trim();
      writeFileSync(
        `${receipt}.ownership.json`,
        JSON.stringify(
          {
            root,
            socket,
            binary,
            serverPid,
            producerPid,
            serverBirth: birth(serverPid),
            producerBirth: birth(producerPid),
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );

      native("set-option", "-t", workspace, "status", "off");
      native("resize-window", "-t", pane, "-x", "100", "-y", "24");
      native("set-option", "-p", "-t", pane, "@tmux_ide_pane_id", semantic);
      native("set-option", "-w", "-t", pane, "@tmux_ide_window_id", "win.soak0");
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing server address");
      owner = await createNativeTmuxServerOwner({
        environmentId: "00000000-0000-4000-8000-000000000001",
        serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
        generation,
        tmuxAuthority: { executablePath: binary!, socketSelector: { kind: "path", path: socket } },
        stateDirectory: join(root, "state"),
        webSocketUrl: `ws://127.0.0.1:${address.port}${PANE_STREAM_REDEEM_PATH}`,
      });
      boundary = attachPaneStreamWebSocket(server, owner.paneStreamRuntime.coordinator);
      const active = await open(true);
      let observer = await open(false);
      await checkpoint([active, observer], "initial");
      visibility(observer, "hidden");
      await until(
        () =>
          (() => {
            const entries = owner!.sessionRuntimeRegistry
              .qualificationSnapshot()
              .sessions.flatMap((s) => s.convergence.clients)
              .filter(
                (c) =>
                  c.clientId.startsWith(`${observer.client!.connectionClientId}:`) &&
                  c.semanticPaneId === semantic,
              );
            return (
              entries.length === 1 &&
              entries[0]!.visibility === "hidden" &&
              entries[0]!.inFlightRevision === null &&
              entries[0]!.queueDepth === 0
            );
          })(),
        "hidden ACK boundary",
      );
      const hidden = observer.deliveries;
      expect(
        await active.port!.sendTerminalInput(
          { workspaceName: workspace, semanticPaneId: semantic },
          { kind: "text", data: "a" },
        ),
      ).toBe("ok");
      await until(() => text(active, 1) === "INPUT 61", "active input");
      expect(observer.deliveries).toBe(hidden);
      visibility(observer, "visible");
      await checkpoint([active, observer], "revealed");
      await retire(observer);
      const retiredAcks = observer.acks,
        retiredDeliveries = observer.deliveries;
      const retired = observer;
      observer = await open(false);
      await checkpoint([active, observer], "reopened");
      expect(retired.acks).toBe(retiredAcks);
      expect(retired.deliveries).toBe(retiredDeliveries);
      expect(faults).toEqual([]);
    } catch (e) {
      failure = e instanceof Error ? e.stack : String(e);
    } finally {
      for (const v of viewers)
        try {
          await bounded(retire(v));
        } catch (e) {
          cleanup.push(String(e));
        }
      try {
        await bounded(owner?.dispose() ?? Promise.resolve());
      } catch (e) {
        cleanup.push(String(e));
      }
      for (const ws of sockets) ws.terminate();
      try {
        await bounded(boundary?.close() ?? Promise.resolve());
      } catch (e) {
        cleanup.push(String(e));
      }
      server.closeAllConnections();
      if (server.listening)
        try {
          await bounded(
            new Promise<void>((resolve, reject) =>
              server.close((e) => (e ? reject(e) : resolve())),
            ),
          );
        } catch (e) {
          cleanup.push(String(e));
        }
      if (serverPid)
        spawnSync(binary!, ["-S", socket, "kill-server"], { env, timeout: 3000, stdio: "ignore" });
      try {
        await until(
          () =>
            (!serverPid || absent(serverPid)) &&
            (!producerPid || absent(producerPid)) &&
            sockets.length === 0,
          "physical cleanup",
        );
        const after = runtimeResourceSnapshot();
        for (const k of Object.keys(before) as (keyof typeof before)[])
          expect(after[k].active).toBe(before[k].active);
      } catch (e) {
        cleanup.push(String(e));
      }
      writeFileSync(
        receipt,
        JSON.stringify(
          {
            failure,
            cleanup,
            faults,
            checkpoints,
            root,
            serverPid,
            producerPid,
            serverAbsent: serverPid ? absent(serverPid) : null,
            producerAbsent: producerPid ? absent(producerPid) : null,
            viewers: viewers.map((v) => ({
              closed: v.closed,
              acks: v.acks,
              deliveries: v.deliveries,
            })),
            scope:
              "Controlled issued route to real isolated owner; production runtime port and fast lane. No full discovery/HTTP inventory, rendering, resource or parity qualification.",
          },
          null,
          2,
        ),
      );
    }
    expect(failure).toBeUndefined();
    expect(cleanup).toEqual([]);
  },
  45_000,
);
