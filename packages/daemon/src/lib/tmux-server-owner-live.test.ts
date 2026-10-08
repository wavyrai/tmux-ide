import { PANE_SOURCE_CREDENTIAL_OPTION } from "./pane-source-credentials.ts";
import { Hono } from "hono";
import { streamTmuxInteractions } from "../command-center/tmux-server-interaction-events.ts";
import { subscribeTmuxServerInteractions } from "@tmux-ide/daemon-client/tmux-server-interaction-events";
import type { InteractionJournalEntry } from "@tmux-ide/contracts";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  const root = mkdtempSync(join(tmpdir(), "tmux-owner-"));
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
          environmentId: "00000000-0000-4000-8000-000000000001",
          serverId: `tmux-server.${String(index).padStart(32, "0")}`,
          generation: randomUUID(),
          tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socket } },
          stateDirectory: join(root, `state-${index}`),
          webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
        }),
      );
    }
    const tokens = sockets.map((socket) =>
      run(socket, ["show-options", "-p", "-v", "-t", "shared:0.0", PANE_SOURCE_CREDENTIAL_OPTION]),
    );
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens.every((token) => token.length > 32)).toBe(true);
    for (const index of [0, 1]) {
      expect(
        owners[index]!.resolveInteractionSource(tokens[index]!, "shared", "pane.shared"),
      ).not.toBeNull();
      expect(
        owners[index]!.resolveInteractionSource(tokens[1 - index]!, "shared", "pane.shared"),
      ).toBeNull();
      expect(
        owners[index]!.resolveInteractionSource(tokens[index]!, "missing", "pane.shared"),
      ).toBeNull();
      expect(
        owners[index]!.resolveInteractionSource(tokens[index]!, "shared", "pane.wrong"),
      ).toBeNull();
    }
    // A replaced installed credential invalidates the previous local grant.
    run(sockets[0]!, [
      "set-option",
      "-p",
      "-t",
      "shared:0.0",
      PANE_SOURCE_CREDENTIAL_OPTION,
      "replaced",
    ]);
    expect(owners[0]!.resolveInteractionSource(tokens[0]!, "shared", "pane.shared")).toBeNull();
    tokens[0] = run(sockets[0]!, [
      "show-options",
      "-p",
      "-v",
      "-t",
      "shared:0.0",
      PANE_SOURCE_CREDENTIAL_OPTION,
    ]);
    expect(owners[0]!.resolveInteractionSource(tokens[0]!, "shared", "pane.shared")).not.toBeNull();
    expect(owners[0]!.sessionRuntimeRegistry.sessionCount()).toBe(0);
    expect(owners[1]!.sessionRuntimeRegistry.sessionCount()).toBe(0);
    // Raw traffic must be visible before the first product mutation and must
    // stay in its owner despite colliding session and semantic pane names.
    const beforeA = owners[0]!.interactionReceipts.read(0).cursor;
    const beforeB = owners[1]!.interactionReceipts.read(0).cursor;
    const streamScope = {
      serverId: `tmux-server.${"0".repeat(32)}`,
      generation: owners[0]!.generation,
    };
    const observed: InteractionJournalEntry[] = [];
    const app = new Hono();
    app.get("/events", (c) =>
      streamTmuxInteractions(
        c,
        streamScope,
        owners[0]!.interactionReceipts,
        beforeA,
        () => {},
        owners[0]!.interactionObservation!,
      ),
    );
    const subscription = subscribeTmuxServerInteractions({
      baseUrl: "http://localhost",
      ownerToken: "fixture",
      server: streamScope,
      resume: { server: streamScope, cursor: beforeA },
      fetch: (async () => app.request("/events")) as typeof fetch,
      onBatch: (batch) => {
        observed.push(...batch.receipts);
      },
    });
    await subscription.ready;
    expect(subscription.getObservationStatus()).toMatchObject({ serverScope: streamScope });
    run(sockets[0]!, ["send-keys", "-t", "shared:0.0", "-l", "raw-before-mutation"]);
    run(sockets[0]!, ["capture-pane", "-p", "-t", "shared:0.0"]);
    await vi.waitFor(() => {
      const receipts = owners[0]!.interactionReceipts.read(beforeA).receipts;
      expect(
        receipts.some(
          (receipt) =>
            "operationKind" in receipt && receipt.operationKind === "workspace.pane.send",
        ),
      ).toBe(true);
      expect(
        receipts.some(
          (receipt) =>
            "operationKind" in receipt && receipt.operationKind === "workspace.pane.read",
        ),
      ).toBe(true);
      expect(
        receipts.every(
          (receipt) =>
            "origin" in receipt &&
            receipt.origin === "external" &&
            receipt.sourceSemanticPaneId === null,
        ),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        observed.some(
          (receipt) =>
            "operationKind" in receipt && receipt.operationKind === "workspace.pane.send",
        ),
      ).toBe(true);
      expect(
        observed.some(
          (receipt) =>
            "operationKind" in receipt && receipt.operationKind === "workspace.pane.read",
        ),
      ).toBe(true);
    });
    subscription.close();
    await subscription.done;
    expect(owners[1]!.interactionReceipts.read(beforeB).receipts).toEqual([]);
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
    expect(owners[0]!.resolveInteractionSource(tokens[0]!, "shared", "pane.shared")).toBeNull();
    expect(() => owners[0]!.interactionReceipts.read(beforeA)).toThrow("retired");
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
          environmentId: "00000000-0000-4000-8000-000000000001",
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
      const oldToken = run(a, [
        "show-options",
        "-p",
        "-v",
        "-t",
        "managed:0.0",
        PANE_SOURCE_CREDENTIAL_OPTION,
      ]);
      expect(oldA.resolveInteractionSource(oldToken, "managed", "pane.shared")).not.toBeNull();
      run(a, ["kill-server"]);
      // The old in-memory grant cannot authorize when its generation runner fails.
      expect(oldA.resolveInteractionSource(oldToken, "managed", "pane.shared")).toBeNull();
      run(a, ["new-session", "-d", "-s", "managed", "-n", "replacement", "sh"]);
      run(a, ["set-option", "-p", "-t", "managed:0.0", "@tmux_ide_pane_id", "pane.shared"]);
      expect(oldA.resolveInteractionSource(oldToken, "managed", "pane.shared")).toBeNull();
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
  it("keeps spaced and healthy native sessions attachable in one owner", async () => {
    const socket = join(root, "spaced.sock");
    sockets.push(socket);
    const names = ["prototyper mgt", "sfora"];
    const sessionIds = names.map((name, index) => {
      const id = run(socket, [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
        "-s",
        name,
        "-n",
        "original",
        "exec sleep 300",
      ]);
      run(socket, ["set-option", "-p", "-t", id, "@tmux_ide_pane_id", `pane.${index}`]);
      run(socket, ["set-option", "-w", "-t", id, "@tmux_ide_window_id", `window.${index}`]);
      return id;
    });
    const owner = await createNativeTmuxServerOwner({
      environmentId: "00000000-0000-4000-8000-000000000001",
      serverId: `tmux-server.${"3".repeat(32)}`,
      generation: randomUUID(),
      tmuxAuthority: { executablePath, socketSelector: { kind: "path", path: socket } },
      stateDirectory: join(root, "spaced-state"),
      webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
    });
    owners.push(owner);
    expect((await owner.catalog()).map((row) => row.sessionName).sort()).toEqual([...names].sort());
    for (const [index, name] of names.entries()) {
      const workspace = owner.workspaceRegistry.list().find((row) => row.sessionName === name)!;
      await expect(
        owner.terminalInventoryRuntime.discoverTerminalRuntimeSession(name),
      ).resolves.toMatchObject({ runtimeSessionId: sessionIds[index], catalogIssue: null });
      await expect(
        owner.terminalInventoryRuntime.semanticPaneCatalog.resolve({
          workspaceName: workspace.name,
          semanticPaneId: `pane.${index}`,
        }),
      ).resolves.toMatchObject({ source: { sessionId: sessionIds[index] } });
    }
    expect(run(socket, ["list-sessions", "-F", "#{session_name}"]).split("\n").sort()).toEqual(
      [...names].sort(),
    );
  }, 30_000);
});
