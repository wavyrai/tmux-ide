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
const executable = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim();
describe.skipIf(!executable)("scoped terminal HTTP transport", () => {
  it("opens ordinary same-named sessions, adopts SSE-fenced inventory and tracks only selected owner layout", async () => {
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
    const boundaries: ReturnType<typeof attachPaneStreamWebSocket>[] = [];
    const transports: ReturnType<typeof createScopedTmuxServerTransport>[] = [];
    try {
      for (const socket of sockets)
        run(socket, ["new-session", "-d", "-s", "shared", "exec sleep 300"]);
      const scopes: TmuxServerScope[] = [];
      const clients: ReturnType<typeof createTmuxServerClient>[] = [];
      const resources: { semanticPaneIds: readonly string[] }[] = [];
      let inventoryReads = 0;
      const options = {
        baseUrl,
        ownerToken: "owner",
        hostClientId: randomUUID(),
        origin: baseUrl,
        timeoutMs: 10000,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input).includes("/inventory/")) inventoryReads++;
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
        expect(run(socket, ["display-message", "-p", "-t", "shared", "#{@tmux_ide_pane_id}"])).toBe(
          "",
        );
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
        expect(resources[index]!.semanticPaneIds).toHaveLength(1);
        const issued = await client.issuePaneStream(
          randomUUID(),
          {
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            workspaceName: opened.workspaceName,
            panes: [...resources[index]!.semanticPaneIds],
            viewerMode: "interactive",
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
        const frames: { type: string }[] = [];
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
          () => expect(frames.some((frame) => frame.type === "seed-batch")).toBe(true),
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
      const selectedA = (await clients[0]!.sessions()).sessions[0]!;
      await clients[0]!.mutate(
        randomUUID(),
        {
          verb: "workspace.window.split",
          workspaceName: "shared",
          semanticPaneId: resources[0]!.semanticPaneIds[0]!,
          direction: "right",
        },
        selectedA.liveSessionId,
      );
      await vi.waitFor(() => expect(resources[0]!.semanticPaneIds).toHaveLength(2), {
        timeout: 10000,
      });
      expect(resources[1]!.semanticPaneIds).toHaveLength(1);
      expect(
        run(sockets[1]!, ["list-panes", "-t", "shared", "-F", "#{pane_id}"]).split("\n"),
      ).toHaveLength(1);
      // Geometry stays on the pane-stream fast lane; inventory HTTP is topology-only.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const readsBeforeResize = inventoryReads;
      for (let index = 0; index < 8; index++)
        run(sockets[0]!, [
          "resize-window",
          "-t",
          "shared:0",
          "-x",
          String(100 + index),
          "-y",
          "30",
        ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(inventoryReads).toBe(readsBeforeResize);
      const created = await clients[0]!.createPane(
        randomUUID(),
        { kind: "terminal", workspaceName: "shared", placement: { kind: "window" } },
        selectedA.liveSessionId,
      );
      expect(created.resource.workspaceName).toBe("shared");
      await vi.waitFor(() => expect(resources[0]!.semanticPaneIds).toHaveLength(3), {
        timeout: 10000,
      });
      expect(resources[1]!.semanticPaneIds).toHaveLength(1);
      run(sockets[0]!, ["kill-window", "-t", "shared:1"]);
      await vi.waitFor(() => expect(resources[0]!.semanticPaneIds).toHaveLength(2), {
        timeout: 10000,
      });
      expect(resources[0]!.semanticPaneIds).not.toContain(created.resource.semanticPaneId);
      run(sockets[0]!, ["kill-pane", "-t", "shared:0.1"]);
      await vi.waitFor(() => expect(resources[0]!.semanticPaneIds).toHaveLength(1), {
        timeout: 10000,
      });
      expect(resources[1]!.semanticPaneIds).toHaveLength(1);
      const sessionCreated = await clients[0]!.createSession(randomUUID(), {
        displayName: "second",
      });
      expect(sessionCreated.daemonInstanceId).toBe(scopes[0]!.generation);
      expect(
        (await clients[0]!.sessions()).sessions.map((session) => session.workspaceName),
      ).toContain(sessionCreated.workspaceName);
      expect(
        (await clients[1]!.sessions()).sessions.map((session) => session.workspaceName),
      ).not.toContain(sessionCreated.workspaceName);
      expect(scopes[0]!.generation).not.toBe(scopes[1]!.generation);
    } finally {
      for (const transport of transports) transport.disposeEventSupervisor();
      for (const ws of socketsOpen) ws.terminate();
      for (const boundary of boundaries) await boundary.close();
      await manager.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets)
        spawnSync(tmux, ["-S", socket, "kill-server"], { stdio: "ignore" });
      rmSync(root, { recursive: true, force: true });
    }
  }, 40000);
});
