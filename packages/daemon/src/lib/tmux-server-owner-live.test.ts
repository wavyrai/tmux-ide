import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createNativeTmuxServerOwner, type NativeTmuxServerOwner } from "./tmux-server-owner.ts";

import { createServer } from "node:http";
import { WebSocket } from "ws";
import {
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PANE_STREAM_REDEEM_PATH,
} from "@tmux-ide/contracts";
import { attachPaneStreamWebSocket } from "../server/pane-stream-upgrade.ts";
import { TmuxServerOwners } from "./tmux-server-owners.ts";
import { createTmuxServerProbe } from "./tmux-server-registration.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
describe.skipIf(!hasTmux).sequential("independent native tmux server owners", () => {
  const root = mkdtempSync("/tmp/tmux-owner-");
  const executablePath = realpathSync(execFileSync("which", ["tmux"], { encoding: "utf8" }).trim());
  const sockets = [join(root, "a.sock"), join(root, "b.sock")];
  const owners: NativeTmuxServerOwner[] = [];
  const run = (socket: string, args: string[]) =>
    execFileSync(executablePath, ["-S", socket, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env: { ...process.env, TMUX: "" },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  afterAll(async () => {
    await Promise.all(owners.map((owner) => owner.dispose()));
    for (const socket of sockets)
      spawnSync(executablePath, ["-S", socket, "kill-server"], {
        stdio: "ignore",
        env: { ...process.env, TMUX: "" },
      });
    rmSync(root, { recursive: true, force: true });
  });
  it("isolates same runtime/stamped IDs, operation ledgers and retirement", async () => {
    for (const [index, socket] of sockets.entries()) {
      run(socket, ["new-session", "-d", "-s", "shared", "-n", "original", "exec sleep 300"]);
      run(socket, ["set-option", "-w", "-t", "shared:0", "@tmux_ide_window_id", "win.shared"]);
      run(socket, ["set-option", "-p", "-t", "shared:0.0", "@tmux_ide_pane_id", "pane.shared"]);
      owners.push(
        await createNativeTmuxServerOwner({
          serverId: `server-${index}`,
          generation: randomUUID(),
          tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socket } },
          stateDirectory: join(root, `state-${index}`),
          webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
        }),
      );
    }
    expect(owners[0]!.sessionRuntimeRegistry.sessionCount()).toBe(0);
    expect(owners[1]!.sessionRuntimeRegistry.sessionCount()).toBe(0);
    expect((await owners[0]!.catalog())[0]!.sessionName).toBe("shared");
    expect((await owners[1]!.catalog())[0]!.sessionName).toBe("shared");
    expect(owners[0]!.sessionRuntimeRegistry).not.toBe(owners[1]!.sessionRuntimeRegistry);
    const operationId = randomUUID();
    const rename = (owner: NativeTmuxServerOwner, name: string) =>
      owner.multiplexerBackend.mutate(
        {
          operationId,
          expectedDaemonInstanceId: owner.generation,
          intent: {
            verb: "workspace.rename",
            workspaceName: "shared",
            scope: "window",
            target: { by: "pane", semanticPaneId: "pane.shared" },
            name,
          },
        },
        undefined,
        undefined,
        true,
      );
    await expect(
      owners[1]!.multiplexerBackend.mutate(
        {
          operationId,
          expectedDaemonInstanceId: owners[0]!.generation,
          intent: {
            verb: "workspace.rename",
            workspaceName: "shared",
            scope: "window",
            target: { by: "pane", semanticPaneId: "pane.shared" },
            name: "bad",
          },
        },
        undefined,
        undefined,
        true,
      ),
    ).rejects.toThrow("generation mismatch");
    await rename(owners[0]!, "alpha");
    expect(run(sockets[0]!, ["display-message", "-p", "-t", "shared:0", "#{window_name}"])).toBe(
      "alpha",
    );
    expect(run(sockets[1]!, ["display-message", "-p", "-t", "shared:0", "#{window_name}"])).toBe(
      "original",
    );
    await rename(owners[1]!, "beta");
    await owners[0]!.dispose();
    await expect(owners[0]!.catalog()).rejects.toThrow("retired");
    await expect(rename(owners[0]!, "bad")).rejects.toThrow("retired");
    expect((await owners[1]!.catalog())[0]!.paneCount).toBe(1);
    expect(run(sockets[1]!, ["display-message", "-p", "-t", "shared:0", "#{window_name}"])).toBe(
      "beta",
    );
  }, 30_000);
  it("deduplicates aliases, fences replacement A, and retains B's live stream and input", async () => {
    const a = join(root, "managed-a.sock"),
      b = join(root, "managed-b.sock");
    sockets.push(a, b);
    for (const socket of [a, b]) {
      run(socket, ["new-session", "-d", "-s", "managed", "-n", "original", "sh"]);
      run(socket, ["set-option", "-p", "-t", "managed:0.0", "@tmux_ide_pane_id", "pane.shared"]);
    }
    const endpoints: Array<{
      server: ReturnType<typeof createServer>;
      close: () => Promise<void>;
    }> = [];
    const clients: WebSocket[] = [];
    const manager = new TmuxServerOwners({
      probe: createTmuxServerProbe(executablePath),
      create: async (_registration, scope, observation) => {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing port");
        const owner = await createNativeTmuxServerOwner({
          ...scope,
          tmuxAuthority: observation.authority,
          stateDirectory: join(root, scope.generation),
          webSocketUrl: `ws://127.0.0.1:${address.port}${PANE_STREAM_REDEEM_PATH}`,
        });
        const boundary = attachPaneStreamWebSocket(server, owner.paneStreamRuntime.coordinator);
        endpoints.push({ server, close: () => boundary.close() });
        return owner;
      },
    });
    try {
      const scopeA = await manager.register({ label: "A", selector: { kind: "path", path: a } });
      const scopeB = await manager.register({ label: "B", selector: { kind: "path", path: b } });
      if (!scopeA.generation || !scopeB.generation) throw new Error("Expected online servers");
      const oldA = manager.current({ serverId: scopeA.serverId, generation: scopeA.generation });
      const oldB = manager.current({ serverId: scopeB.serverId, generation: scopeB.generation });
      const alias = join(root, "alias-a.sock");
      symlinkSync(a, alias);
      expect(
        await manager.register({ label: "Alias", selector: { kind: "path", path: alias } }),
      ).toEqual(scopeA);
      expect(manager.list()).toHaveLength(2);
      const open = async (owner: NativeTmuxServerOwner) => {
        const requestId = randomUUID();
        const descriptor = await owner.paneStreamRuntime.coordinator.issue(
          {
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            workspaceName: "managed",
            panes: ["pane.shared"],
            viewerMode: "interactive",
          },
          {
            requestId,
            projectIdentity: "managed",
            sessionName: "managed",
            rendererOrigin: "tmux-ide://app",
            hostClientId: `test-host:${requestId}`,
          },
        );
        const ws = new WebSocket(descriptor.webSocketUrl, [PANE_STREAM_WEBSOCKET_SUBPROTOCOL], {
          origin: "tmux-ide://app",
        });
        clients.push(ws);
        const frames: Array<Record<string, unknown>> = [];
        ws.on("message", (data) => frames.push(JSON.parse(String(data))));
        await new Promise<void>((resolve, reject) => {
          ws.once("open", resolve);
          ws.once("error", reject);
        });
        ws.send(
          JSON.stringify({
            type: "redeem",
            protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
            ticket: descriptor.redemptionTicket,
            requestId,
            daemonInstanceId: owner.generation,
          }),
        );
        await vi.waitFor(
          () => expect(frames.some((frame) => frame.type === "seed-batch")).toBe(true),
          { timeout: 10_000 },
        );
        return { ws, frames };
      };
      const streamA = await open(oldA),
        streamB = await open(oldB);
      run(a, ["kill-server"]);
      run(a, ["new-session", "-d", "-s", "managed", "-n", "replacement", "sh"]);
      run(a, ["set-option", "-p", "-t", "managed:0.0", "@tmux_ide_pane_id", "pane.shared"]);
      // A recreated socket immediately invalidates the old scope before refresh.
      await vi.waitFor(() =>
        expect(() =>
          manager.current({ serverId: scopeA.serverId, generation: scopeA.generation! }),
        ).toThrow("stale-generation"),
      );
      const refreshed = await manager.refresh();
      const freshA = refreshed.find((server) => server.serverId === scopeA.serverId)!;
      expect(freshA.generation).not.toBe(scopeA.generation);
      expect(freshA.state).toBe("online");
      expect(manager.current({ serverId: scopeB.serverId, generation: scopeB.generation })).toBe(
        oldB,
      );
      await expect(
        manager.withOwner({ serverId: scopeA.serverId, generation: scopeA.generation }, (owner) =>
          owner.multiplexerBackend.mutate(
            {
              operationId: randomUUID(),
              expectedDaemonInstanceId: owner.generation,
              intent: {
                verb: "workspace.rename",
                workspaceName: "managed",
                scope: "window",
                target: { by: "pane", semanticPaneId: "pane.shared" },
                name: "BAD",
              },
            },
            undefined,
            undefined,
            true,
          ),
        ),
      ).rejects.toThrow("stale-generation");
      expect(run(a, ["display-message", "-p", "-t", "managed:0", "#{window_name}"])).toBe(
        "replacement",
      );
      await vi.waitFor(() => expect(streamA.ws.readyState).toBe(WebSocket.CLOSED));
      expect(streamB.ws.readyState).toBe(WebSocket.OPEN);
      streamB.ws.send(
        JSON.stringify({ type: "presence", generation: oldB.generation, state: "foreground" }),
      );
      streamB.ws.send(
        JSON.stringify({
          type: "authority-request",
          generation: oldB.generation,
          requestId: randomUUID(),
          authority: "input",
        }),
      );
      await vi.waitFor(() =>
        expect(streamB.frames.filter((frame) => frame.type === "authority-receipt")).toEqual([
          expect.objectContaining({ status: "granted" }),
        ]),
      );
      streamB.ws.send(
        JSON.stringify({
          type: "input",
          kind: "text",
          pane: "pane.shared",
          seq: 1,
          data: "echo OWNER_B_$((20+22))",
        }),
      );
      streamB.ws.send(
        JSON.stringify({ type: "input", kind: "key", pane: "pane.shared", seq: 2, data: "Enter" }),
      );
      await vi.waitFor(
        () =>
          expect(
            streamB.frames
              .filter((frame) => ["input-ack", "error", "closed"].includes(String(frame.type)))
              .map((frame) => (frame.type === "input-ack" ? frame.seq : frame)),
          ).toEqual([1, 2]),
        { timeout: 10_000 },
      );
      await vi.waitFor(() =>
        expect(run(b, ["capture-pane", "-p", "-t", "managed:0.0"])).toContain("OWNER_B_42"),
      );
    } finally {
      for (const ws of clients) ws.terminate();
      await manager.dispose();
      for (const endpoint of endpoints) {
        await endpoint.close();
        await new Promise<void>((resolve) => endpoint.server.close(() => resolve()));
      }
    }
  }, 45_000);
});
