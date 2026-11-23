import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { afterEach, expect, it } from "vitest";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import {
  createWorkspaceEventSupervisor,
  type WorkspaceEventSocket,
} from "@tmux-ide/daemon-client/workspace-event-supervisor";
import { closeHomeCatalogTransport } from "./home-catalog.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A peer that accepts TCP but never answers the upgrade keeps the socket CONNECTING.
async function silentPeer() {
  const held: Socket[] = [];
  const server = createServer((connection) => {
    held.push(connection);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const accepted = once(server, "connection");
  cleanups.push(async () => {
    for (const connection of held) connection.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No peer address");
  return { port: address.port, accepted };
}

it("closes a home catalog transport whose socket is still connecting without an unhandled error", async () => {
  const peer = await silentPeer();
  const socket = new WebSocket(`ws://127.0.0.1:${peer.port}/ws/events?mode=semantic`);
  // An 'error' emitted with no listener is what kills the browser helper process.
  const unhandled: unknown[] = [];
  const emit = socket.emit.bind(socket);
  socket.emit = ((type: string | symbol, ...args: unknown[]) => {
    if (type === "error" && socket.listenerCount("error") === 0) {
      unhandled.push(args[0]);
      return false;
    }
    return emit(type, ...args);
  }) as typeof socket.emit;
  const supervisor = createWorkspaceEventSupervisor({
    socket: socket as unknown as WorkspaceEventSocket,
    daemon: {
      pid: process.pid,
      instanceId: randomUUID(),
      startedAt: new Date().toISOString(),
      productVersion: "test-peer",
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    },
    workspaceName: "alpha",
    sessionName: "alpha",
    fetchTerminalRuntimeInventory: () => Promise.reject(new Error("no inventory")),
  });
  const subscription = supervisor.connectWorkspaceCatalog(() => {}, { terminalFirst: false });
  subscription.ready.catch(() => {});
  await peer.accepted;
  expect(socket.readyState).toBe(WebSocket.CONNECTING);
  // Not events.once: it adds its own 'error' listener and would hide the bug.
  const closed = new Promise<void>((done) => socket.once("close", () => done()));
  closeHomeCatalogTransport(subscription, supervisor);
  await closed;
  expect(unhandled.map(String)).toEqual([]);
});
