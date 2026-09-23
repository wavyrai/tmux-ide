import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamIssueResultSchemaZ,
  tmuxServerPaneStreamPath,
  TmuxServersResourceSchemaZ,
  TmuxServerProofSchema,
  TmuxServerDescriptorSchemaZ,
} from "@tmux-ide/contracts";
import { captureTmuxServerProof } from "./tmux-server-proof.ts";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "./daemon-embed.ts";
import { WorkspaceRegistry, _setDefaultWorkspaceRegistryForTests } from "./workspace-registry.ts";

const executable = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout.trim();
describe.skipIf(!executable).sequential("embedded multi-server HTTP integration", () => {
  it("borrows default authority and keeps B alive across default A replacement", async () => {
    const root = mkdtempSync("/tmp/tmux-embedded-owners-");
    const tmux = realpathSync(executable);
    const sockets = [join(root, "a.sock"), join(root, "b.sock")];
    const saved = new Map<string, string | undefined>();
    const env: Record<string, string | undefined> = {
      TMUX: "",
      TMUX_IDE_RUNTIME_MODE: "test",
      TMUX_IDE_CLEANUP_TOKEN: randomUUID(),
      TMUX_IDE_HOME: root,
      TMUX_IDE_REGISTRY_DIR: join(root, "registry"),
      TMUX_IDE_DAEMON_INFO_DIR: join(root, "daemon"),
      TMUX_IDE_SETTINGS_DIR: join(root, "settings"),
      TMUX_IDE_CONFIG: join(root, "config.json"),
      TMUX_IDE_TMUX_SOCKET_PATH: sockets[0],
      TMUX_IDE_TMUX_SOCKET_NAME: undefined,
    };
    let handle: EmbeddedDaemonHandle | null = null;
    const clients: WebSocket[] = [];
    const ownerToken = `fixture-${randomUUID()}`;
    const run = (socket: string, args: string[]) =>
      execFileSync(tmux, ["-S", socket, "-f", "/dev/null", ...args], {
        cwd: root,
        env: { ...process.env, TMUX: "" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    // Session names remain discoverable; isolation is the two owned private sockets.
    const start = (socket: string) => {
      run(socket, ["new-session", "-d", "-s", "same", "-n", "original", "exec sleep 300"]);
      run(socket, ["set-option", "-p", "-t", "same:0.0", "@tmux_ide_pane_id", "pane.same"]);
      run(socket, ["set-option", "-w", "-t", "same:0", "@tmux_ide_window_id", "window.same"]);
    };
    try {
      for (const [key, value] of Object.entries(env)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      for (const socket of sockets) start(socket);
      expect(
        run(sockets[0]!, [
          "display-message",
          "-p",
          "-t",
          "same:0.0",
          "#{session_id}|#{window_id}|#{pane_id}",
        ]),
      ).toBe(
        run(sockets[1]!, [
          "display-message",
          "-p",
          "-t",
          "same:0.0",
          "#{session_id}|#{window_id}|#{pane_id}",
        ]),
      );
      const registry = new WorkspaceRegistry({
        dir: join(root, "registry"),
        listSessions: () => ["same"],
      });
      registry.add({
        name: "same",
        sessionName: "same",
        projectDir: root,
        persistence: "volatile",
      });
      _setDefaultWorkspaceRegistryForTests(registry);
      handle = await startEmbeddedDaemon({
        bindHostname: "127.0.0.1",
        authToken: null,
        localBypassToken: ownerToken,
        silent: true,
      });
      const generation = handle.instanceId;
      const identityResponse = await fetch(`${handle.apiBaseUrl}/identity?tmuxServerProof=1`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      expect(identityResponse.status).toBe(200);
      const identity = (await identityResponse.json()) as { tmuxServerProof: unknown };
      const proof = TmuxServerProofSchema.parse(identity.tmuxServerProof);
      expect(proof.kind).toBe("live");
      expect(proof).toEqual(captureTmuxServerProof((args) => run(sockets[0]!, [...args])));

      const request = (path: string, method = "GET", body?: unknown, authorized = true) =>
        fetch(`${handle!.apiBaseUrl}/api/v1/tmux-servers${path}`, {
          method,
          headers: {
            ...(authorized ? { Authorization: `Bearer ${ownerToken}` } : {}),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      expect((await request("", "GET", undefined, false)).status).toBe(401);
      const initial = TmuxServersResourceSchemaZ.parse(await (await request("")).json());
      expect(initial.servers).toHaveLength(1);
      const a = initial.servers[0]!;
      expect(a.generation).toBe(generation);
      const registered = await request("", "POST", {
        label: "B",
        selector: { kind: "path", path: sockets[1] },
      });
      expect(registered.status).toBe(201);
      const b = TmuxServerDescriptorSchemaZ.parse(await registered.json());
      expect(b.state).toBe("online");
      expect(b.generation).not.toBe(a.generation);
      const scope = (server: typeof a) => `/${server.serverId}/${server.generation}`;
      for (const server of [a, b]) {
        const response = await request(scope(server) + "/sessions");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          sessions: [{ sessionName: "same", paneCount: 1 }],
        });
      }
      const origin = "tmux-ide://app";
      const issue = async (server: typeof a) => {
        const requestId = randomUUID();
        const response = await fetch(
          `${handle!.apiBaseUrl}/api/v1/tmux-servers${scope(server)}/pane-streams/issue`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
              Origin: origin,
              "X-Tmux-Ide-Request-Id": requestId,
              "X-Tmux-Ide-Expected-Daemon-Instance-Id": server.generation!,
              "X-Tmux-Ide-Host-Client-Id": `embedded:${requestId}`,
            },
            body: JSON.stringify({
              requestId,
              expectedDaemonInstanceId: server.generation,
              stream: {
                protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
                workspaceName: "same",
                panes: ["pane.same"],
                viewerMode: "read-only",
                terminalDelivery: {
                  protocolVersions: [1],
                  encodings: ["semantic-v1"],
                  richPlacements: true,
                },
              },
            }),
          },
        );
        const result = PaneStreamIssueResultSchemaZ.parse(await response.json());
        if (result.status !== "issued")
          throw new Error(`Scoped stream issue failed: ${JSON.stringify(result)}`);
        return result.descriptor;
      };
      const defaultTicket = await issue(a);
      const bTicket = await issue(b);
      expect(new URL(bTicket.webSocketUrl).port).toBe(String(handle.port));
      expect(new URL(bTicket.webSocketUrl).pathname).toBe(
        tmuxServerPaneStreamPath({ serverId: b.serverId, generation: b.generation! }),
      );
      const connect = async (url: string) => {
        const ws = new WebSocket(url, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], { origin });
        clients.push(ws);
        const frames: Record<string, unknown>[] = [];
        ws.on("message", (data) => frames.push(JSON.parse(String(data))));
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        return { ws, frames };
      };
      const redemption = {
        type: "redeem",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        ticket: bTicket.redemptionTicket,
        requestId: bTicket.requestId,
        daemonInstanceId: bTicket.daemonInstanceId,
      };
      // A pending A ticket permits transport admission; B's bearer cannot redeem A authority.
      const wrongOwner = await connect(defaultTicket.webSocketUrl);
      wrongOwner.ws.send(JSON.stringify(redemption));
      await vi.waitFor(
        () => expect(wrongOwner.frames.some((frame) => frame.type === "error")).toBe(true),
        { timeout: 5000 },
      );
      expect(
        wrongOwner.frames.some((frame) => frame.type === "redeemed" || frame.type === "seed-batch"),
      ).toBe(false);
      const streamB = await connect(bTicket.webSocketUrl);
      streamB.ws.send(JSON.stringify(redemption));
      await vi.waitFor(
        () =>
          expect(streamB.frames).toContainEqual(
            expect.objectContaining({ type: "layout-snapshot" }),
          ),
        { timeout: 10000 },
      );
      expect(streamB.frames.find((frame) => frame.type === "layout-snapshot")).toMatchObject({
        windowLinks: { liveSessionId: expect.any(String) },
        layouts: [{ panes: [{ pane: "pane.same" }] }],
      });
      const refused = async (url: string) =>
        new Promise<number>((resolve, reject) => {
          const ws = new WebSocket(url, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], { origin });
          clients.push(ws);
          ws.once("unexpected-response", (_request, response) => {
            response.resume();
            resolve(response.statusCode!);
            ws.terminate();
          });
          ws.once("open", () => reject(new Error("Unknown scope upgraded")));
          ws.on("error", () => {});
          setTimeout(() => reject(new Error("Unknown scope did not refuse upgrade")), 3000).unref();
        });
      const unknown = new URL(bTicket.webSocketUrl);
      unknown.pathname = tmuxServerPaneStreamPath({
        serverId: `tmux-server.${"f".repeat(32)}`,
        generation: randomUUID(),
      });
      expect(await refused(unknown.href)).toBe(410);
      const stalePath = new URL(bTicket.webSocketUrl);
      stalePath.pathname = tmuxServerPaneStreamPath({
        serverId: b.serverId,
        generation: randomUUID(),
      });
      expect(await refused(stalePath.href)).toBe(410);
      const operationId = randomUUID();
      const rename = (server: typeof a, name: string) =>
        request(scope(server) + "/mutations", "POST", {
          operationId,
          expectedDaemonInstanceId: server.generation,
          intent: {
            verb: "workspace.rename",
            workspaceName: "same",
            scope: "window",
            target: { by: "pane", semanticPaneId: "pane.same" },
            name,
          },
        });
      expect((await rename(a, "only-a")).status).toBe(200);
      expect(run(sockets[1]!, ["display-message", "-p", "-t", "same:0", "#{window_name}"])).toBe(
        "original",
      );
      expect((await rename(b, "only-b")).status).toBe(200);
      const bPid = run(sockets[1]!, ["display-message", "-p", "#{pid}"]);
      const persisted = JSON.parse(readFileSync(join(root, "tmux-servers.json"), "utf8"));
      expect(JSON.stringify(persisted)).toContain(b.serverId);
      expect(statSync(join(root, "tmux-servers.json")).mode & 0o777).toBe(0o600);
      run(sockets[0]!, ["kill-server"]);
      start(sockets[0]!);
      expect(await handle.tmuxAuthorityReplaced?.()).toBe(false);
      expect(handle.instanceId).toBe(generation);
      expect(streamB.ws.readyState).toBe(WebSocket.OPEN);
      const refreshed = TmuxServersResourceSchemaZ.parse(await (await request("")).json());
      const nextA = refreshed.servers.find((server) => server.serverId === a.serverId)!;
      expect(nextA.state).toBe("online");
      expect(nextA.generation).not.toBe(a.generation);
      expect(refreshed.servers.find((server) => server.serverId === b.serverId)?.generation).toBe(
        b.generation,
      );
      expect((await rename(a, "stale-must-not-run")).status).toBe(409);
      expect((await request(scope(b) + "/sessions")).status).toBe(200);
      expect(run(sockets[1]!, ["display-message", "-p", "#{pid}"])).toBe(bPid);
      expect(run(sockets[1]!, ["display-message", "-p", "-t", "same:0", "#{window_name}"])).toBe(
        "only-b",
      );
      expect(run(sockets[0]!, ["display-message", "-p", "-t", "same:0", "#{window_name}"])).toBe(
        "original",
      );
      await handle.stop({ gracefulMs: 100 });
      handle = null;
      for (const socket of sockets) expect(run(socket, ["has-session", "-t", "same"])).toBe("");
      // Canonical parent spelling is an equivalent selector; socket-leaf symlinks are intentionally forbidden.
      const alias = join(realpathSync(root), "a.sock");
      process.env.TMUX_IDE_TMUX_SOCKET_PATH = alias;
      handle = await startEmbeddedDaemon({
        bindHostname: "127.0.0.1",
        authToken: null,
        localBypassToken: ownerToken,
        silent: true,
      });
      const restarted = TmuxServersResourceSchemaZ.parse(await (await request("")).json());
      expect(restarted.servers).toHaveLength(2);
      expect(restarted.servers.find((server) => server.serverId === a.serverId)?.generation).toBe(
        handle.instanceId,
      );
      expect(restarted.servers.some((server) => server.serverId === b.serverId)).toBe(true);
      await handle.stop({ gracefulMs: 100 });
      handle = null;
      for (const socket of sockets) expect(run(socket, ["has-session", "-t", "same"])).toBe("");
    } finally {
      for (const client of clients) client.terminate();
      await handle?.stop({ gracefulMs: 100 }).catch(() => undefined);
      _setDefaultWorkspaceRegistryForTests(null);
      for (const socket of sockets)
        spawnSync(tmux, ["-S", socket, "kill-server"], {
          stdio: "ignore",
          env: { ...process.env, TMUX: "" },
        });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
