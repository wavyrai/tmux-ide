import { defaultNodePtyAdapter } from "../terminal/NodePtyAdapter.ts";
import type { PtyProcess } from "../terminal/PtyAdapter.ts";
import type { PaneStreamServerFrame } from "@tmux-ide/contracts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocket } from "ws";
import { attachPaneStreamWebSocket } from "../server/pane-stream-upgrade.ts";
import type { Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  tmuxServerPaneStreamPath,
  type TmuxServerScope,
} from "@tmux-ide/contracts";
import { createTmuxServerClient } from "@tmux-ide/daemon-client/tmux-server-client";
import { createScopedTmuxServerTransport } from "@tmux-ide/daemon-client/scoped-tmux-server-transport";
import { TmuxServerOwners } from "./tmux-server-owners.ts";
import { createNativeTmuxServerOwner, type NativeTmuxServerOwner } from "./tmux-server-owner.ts";
import { createTmuxServerProbe } from "./tmux-server-registration.ts";
import { mountTmuxServerRoutes } from "../command-center/tmux-servers.ts";
type PaneStreamLayoutFrame = Extract<PaneStreamServerFrame, { type: "layout" }>;
const executable = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim();
describe.skipIf(!executable)("combined multi-server/native-client coexistence", () => {
  it("preserves native sizing, focus, zoom and linked backing with independent scoped streams", async () => {
    const root = mkdtempSync("/tmp/tmux-scoped-http-");
    const tmux = realpathSync(executable);
    const sockets = [join(root, "a.sock"), join(root, "b.sock")];
    const run = (socket: string, args: string[]) =>
      execFileSync(tmux, ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trim();
    let baseUrl = "";
    const manager = new TmuxServerOwners<NativeTmuxServerOwner>({
      probe: createTmuxServerProbe(tmux),
      create: async (registration, scope, observation) =>
        createNativeTmuxServerOwner({
          ...scope,
          tmuxAuthority: observation.authority,
          nativeServerIdentity: observation.nativeServerIdentity,
          stateDirectory: join(root, registration.serverId),
          webSocketUrl: baseUrl.replace("http:", "ws:") + tmuxServerPaneStreamPath(scope),
        }),
    });
    const app = new Hono();
    mountTmuxServerRoutes(app, { owners: manager, ownerToken: "owner" });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const socketsOpen: WebSocket[] = [];
    const nativeClients: PtyProcess[] = [];
    const streamFrames: PaneStreamServerFrame[][] = [];
    const boundaries: ReturnType<typeof attachPaneStreamWebSocket>[] = [];
    const transports: ReturnType<typeof createScopedTmuxServerTransport>[] = [];
    try {
      for (const socket of sockets) {
        run(socket, ["new-session", "-d", "-s", "shared", "-x", "120", "-y", "40", "sh"]);
        run(socket, ["set-option", "-t", "shared", "status", "off"]);
        run(socket, ["set-option", "-p", "-t", "shared:0.0", "@tmux_ide_pane_id", "pane.shared"]);
        run(socket, ["set-option", "-w", "-t", "shared:0", "@tmux_ide_window_id", "window.shared"]);
      }
      run(sockets[0]!, ["split-window", "-d", "-t", "shared:0", "sh"]);
      run(sockets[0]!, [
        "set-option",
        "-p",
        "-t",
        "shared:0.1",
        "@tmux_ide_pane_id",
        "pane.second",
      ]);
      run(sockets[0]!, ["link-window", "-s", "shared:0", "-t", "shared:1"]);
      run(sockets[0]!, ["select-window", "-t", "shared:0"]);
      expect(
        run(sockets[0]!, [
          "display-message",
          "-p",
          "-t",
          "shared:0.0",
          "#{session_id}|#{window_id}|#{pane_id}",
        ]),
      ).toBe(
        run(sockets[1]!, [
          "display-message",
          "-p",
          "-t",
          "shared:0.0",
          "#{session_id}|#{window_id}|#{pane_id}",
        ]),
      );
      for (const viewport of [
        { cols: 140, rows: 44 },
        { cols: 96, rows: 28 },
      ]) {
        nativeClients.push(
          defaultNodePtyAdapter.spawnSync(
            {
              shell: tmux,
              args: ["-S", sockets[0]!, "attach", "-t", "=shared"],
              cwd: root,
              ...viewport,
              env: { ...process.env, TMUX: "", TMUX_TMPDIR: "", TERM: "xterm-256color" },
              name: "xterm-256color",
              encoding: null,
            },
            { onData: () => undefined, onExit: () => undefined },
          ),
        );
      }
      await vi.waitFor(
        () =>
          expect(
            run(sockets[0]!, ["list-clients", "-F", "#{client_width}x#{client_height}"]).split(
              "\n",
            ),
          ).toEqual(expect.arrayContaining(["140x44", "96x28"])),
        { timeout: 10000 },
      );
      const scopes: TmuxServerScope[] = [];
      const clients: ReturnType<typeof createTmuxServerClient>[] = [];
      const resources: { semanticPaneIds: readonly string[] }[] = [];
      const options = {
        baseUrl,
        ownerToken: "owner",
        hostClientId: randomUUID(),
        origin: baseUrl,
        timeoutMs: 10000,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await fetch(input, init);
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
          return response;
        }) as typeof fetch,
      };
      for (const [index, socket] of sockets.entries()) {
        const registration = await manager.register({
          label: String(index),
          selector: { kind: "path", path: socket },
        });
        if (registration.state !== "online") throw new Error("owner offline");
        const scope = { serverId: registration.serverId, generation: registration.generation };
        scopes.push(scope);
        boundaries.push(
          attachPaneStreamWebSocket(
            server as Server,
            manager.current(scope).paneStreamRuntime.coordinator,
            tmuxServerPaneStreamPath(scope),
          ),
        );
        const client = createTmuxServerClient(options, scope);
        clients.push(client);
        const selected = (await client.sessions()).sessions[0]!;

        const opened = await client.openSession(selected.liveSessionId);
        const target = {
          workspaceName: opened.workspaceName,
          daemon: {
            protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
            productVersion: "2.9.0",
            instanceId: scope.generation,
            startedAt: new Date().toISOString(),
          },
        };
        const transport = createScopedTmuxServerTransport({
          scope,
          target,
          clientOptions: options,
          sessionName: "shared",
          liveSessionId: selected.liveSessionId,
        });
        transports.push(transport);
        const prepared = await transport.prepareTerminalRuntimeInventory(
          target,
          AbortSignal.timeout(10000),
        );
        resources[index] = transport.adoptTerminalRuntimeInventory(prepared, (resource) => {
          resources[index] = resource;
        })!;
        expect(resources[index]!.semanticPaneIds).toHaveLength(index === 0 ? 2 : 1);
        const issued = await client.issuePaneStream(
          randomUUID(),
          {
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            workspaceName: opened.workspaceName,
            panes: [...resources[index]!.semanticPaneIds],
            viewerMode: "interactive",
            terminalDelivery: {
              protocolVersions: [1],
              encodings: ["semantic-v1"],
              richPlacements: false,
            },
          },
          selected.liveSessionId,
        );
        if (issued.status !== "issued") throw new Error(JSON.stringify(issued));
        const ws = new WebSocket(
          issued.descriptor.webSocketUrl,
          [PANE_STREAM_WEBSOCKET_SUBPROTOCOL],
          { origin: baseUrl },
        );
        socketsOpen.push(ws);
        const frames: PaneStreamServerFrame[] = [];
        streamFrames.push(frames);
        ws.on("message", (data) => frames.push(JSON.parse(String(data))));
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        ws.send(
          JSON.stringify({
            type: "redeem",
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            ticket: issued.descriptor.redemptionTicket,
            requestId: issued.descriptor.requestId,
            daemonInstanceId: scope.generation,
          }),
        );
        await vi.waitFor(
          () => expect(frames.some((frame) => frame.type === "layout-snapshot")).toBe(true),
          { timeout: 10000 },
        );
        ws.send(
          JSON.stringify({ type: "presence", generation: scope.generation, state: "foreground" }),
        );
        ws.send(
          JSON.stringify({
            type: "authority-request",
            generation: scope.generation,
            requestId: randomUUID(),
            authority: "input",
          }),
        );
        await vi.waitFor(
          () => expect(frames.some((frame) => frame.type === "authority-receipt")).toBe(true),
          { timeout: 10000 },
        );
      }
      const nativeState = (socket: string) =>
        run(socket, [
          "display-message",
          "-p",
          "-t",
          "shared:0",
          "#{window_width}|#{window_height}|#{window_zoomed_flag}|#{@tmux_ide_pane_id}",
        ]);
      const layout = (index: number): PaneStreamLayoutFrame | undefined => {
        for (const frame of [...streamFrames[index]!].reverse()) {
          if (frame.type === "layout" && frame.semanticWindowId === "window.shared") return frame;
          if (frame.type === "layout-snapshot")
            return frame.layouts.find((entry) => entry.semanticWindowId === "window.shared");
        }
        return undefined;
      };
      const assertConverged = async () => {
        await vi.waitFor(
          () => {
            const [cols, rows, zoomed, active] = nativeState(sockets[0]!).split("|");
            expect(layout(0)).toMatchObject({
              cols: Number(cols),
              rows: Number(rows),
              zoomed: zoomed === "1",
            });
            expect(layout(0)?.panes.find((pane) => pane.active)?.pane).toBe(active);
          },
          { timeout: 10000 },
        );
      };
      const stateB = nativeState(sockets[1]!);
      for (const [policy, cols, rows] of [
        ["smallest", 96, 28],
        ["largest", 140, 44],
      ] as const) {
        run(sockets[0]!, ["set-option", "-w", "-t", "shared:0", "window-size", policy]);
        await vi.waitFor(() =>
          expect(nativeState(sockets[0]!).split("|").slice(0, 2)).toEqual([
            String(cols),
            String(rows),
          ]),
        );
        await assertConverged();
      }
      // Two links share one backing and one native geometry, never separate PTYs.
      expect(
        run(sockets[0]!, [
          "list-windows",
          "-t",
          "shared",
          "-F",
          "#{window_id}|#{window_width}|#{window_height}",
        ]).split("\n"),
      ).toEqual(["@0|140|44", "@0|140|44"]);
      run(sockets[0]!, ["resize-window", "-t", "shared:0", "-x", "110", "-y", "35"]);
      nativeClients[0]!.write("\r");
      await assertConverged();
      expect(nativeState(sockets[0]!).startsWith("110|35|")).toBe(true);
      expect(run(sockets[0]!, ["show-options", "-wv", "-t", "shared:0", "window-size"])).toBe(
        "manual",
      );
      run(sockets[0]!, ["set-option", "-w", "-t", "shared:0", "window-size", "latest"]);
      nativeClients[0]!.write("\r");
      await vi.waitFor(() => expect(nativeState(sockets[0]!).startsWith("140|44|")).toBe(true));
      nativeClients[1]!.resize(104, 32);
      nativeClients[1]!.write("\r");
      await vi.waitFor(() => expect(nativeState(sockets[0]!).startsWith("104|32|")).toBe(true));
      await assertConverged();
      run(sockets[0]!, ["select-pane", "-t", "shared:0.1"]);
      run(sockets[0]!, ["resize-pane", "-Z", "-t", "shared:0.1"]);
      await assertConverged();
      expect(layout(0)?.zoomed).toBe(true);
      const selectedA = (await clients[0]!.sessions()).sessions[0]!;
      const mutation = await clients[0]!.mutate(
        randomUUID(),
        {
          verb: "workspace.rename",
          workspaceName: "shared",
          scope: "window",
          target: { by: "pane", semanticPaneId: "pane.shared" },
          name: "coexisting",
        },
        selectedA.liveSessionId,
      );
      expect(mutation).toBeDefined();
      expect(run(sockets[0]!, ["display-message", "-p", "-t", "shared:0", "#{window_name}"])).toBe(
        "coexisting",
      );
      run(sockets[0]!, ["select-window", "-t", "shared:1"]);
      await vi.waitFor(() => {
        const snapshot = [...streamFrames[0]!]
          .reverse()
          .find((frame) => frame.type === "layout-snapshot");
        expect(snapshot?.type).toBe("layout-snapshot");
        if (snapshot?.type !== "layout-snapshot") return;
        expect(snapshot.windowLinks.links).toHaveLength(2);
        expect(snapshot.layouts).toHaveLength(1);
        expect(
          snapshot.windowLinks.links.find(
            (link) => link.linkId === snapshot.windowLinks.activeLinkId,
          )?.displayIndex,
        ).toBe(1);
      });
      socketsOpen[0]!.send(
        JSON.stringify({
          type: "input",
          kind: "text",
          pane: "pane.shared",
          seq: 1,
          data: "echo COEXIST_A_$((40+2))",
        }),
      );
      socketsOpen[0]!.send(
        JSON.stringify({ type: "input", kind: "key", pane: "pane.shared", seq: 2, data: "Enter" }),
      );
      await vi.waitFor(() =>
        expect(run(sockets[0]!, ["capture-pane", "-p", "-t", "shared:0.0"])).toContain(
          "COEXIST_A_42",
        ),
      );
      expect(run(sockets[1]!, ["capture-pane", "-p", "-t", "shared:0.0"])).not.toContain(
        "COEXIST_A_",
      );
      expect(nativeState(sockets[1]!)).toBe(stateB);
      expect(socketsOpen[1]!.readyState).toBe(WebSocket.OPEN);
      const beforeClose = nativeState(sockets[0]!);
      transports[0]!.disposeEventSupervisor();
      socketsOpen[0]!.terminate();
      await manager.remove(scopes[0]!.serverId);
      expect(nativeState(sockets[0]!)).toBe(beforeClose);
      nativeClients[0]!.write("\r");
      await vi.waitFor(() => expect(nativeState(sockets[0]!).startsWith("140|44|")).toBe(true));
      expect(nativeState(sockets[1]!)).toBe(stateB);
      socketsOpen[1]!.send(
        JSON.stringify({
          type: "input",
          kind: "text",
          pane: "pane.shared",
          seq: 1,
          data: "echo COEXIST_B_$((40+3))",
        }),
      );
      socketsOpen[1]!.send(
        JSON.stringify({ type: "input", kind: "key", pane: "pane.shared", seq: 2, data: "Enter" }),
      );
      await vi.waitFor(() =>
        expect(run(sockets[1]!, ["capture-pane", "-p", "-t", "shared:0.0"])).toContain(
          "COEXIST_B_43",
        ),
      );
      expect(run(sockets[0]!, ["capture-pane", "-p", "-t", "shared:0.0"])).not.toContain(
        "COEXIST_B_",
      );
    } finally {
      for (const transport of transports) transport.disposeEventSupervisor();
      for (const ws of socketsOpen) ws.terminate();
      for (const boundary of boundaries) await boundary.close();
      await manager.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const client of nativeClients) {
        try {
          client.kill("SIGKILL");
        } catch {
          /* server cleanup below */
        }
      }
      for (const socket of sockets)
        spawnSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
