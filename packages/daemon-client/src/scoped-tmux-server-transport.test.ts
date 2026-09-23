import { describe, expect, it } from "bun:test";
import { DAEMON_WIRE_PROTOCOL_VERSION } from "@tmux-ide/contracts";
import { createScopedTmuxServerTransport } from "./scoped-tmux-server-transport.ts";
const scope = {
  serverId: `tmux-server.${"a".repeat(32)}`,
  generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const target = {
  workspaceName: "main",
  daemon: {
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    productVersion: "2.9.0",
    instanceId: scope.generation,
    startedAt: "2026-09-23T10:00:00.000Z",
  },
};
const inventory = {
  workspaceName: "main",
  workspaceId: "workspace.main",
  sessionId: "session.abcdefghijklmnop",
  semanticPaneIds: ["pane.one"],
  resourceRevision: 0,
};
function fixture() {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  let inventoryReads = 0;
  const pending: (() => void)[] = [];
  const transport = createScopedTmuxServerTransport({
    scope,
    target,
    sessionName: "main",
    liveSessionId: `live-session.${"a".repeat(20)}`,
    clientOptions: {
      baseUrl: "http://localhost:4000",
      ownerToken: "owner",
      origin: "http://localhost",
      hostClientId: "client",
      timeoutMs: 50,
      fetch: (async (input: RequestInfo | URL) => {
        const path = new URL(String(input));
        expect(path.pathname).toStartWith(
          `/api/v1/tmux-servers/${scope.serverId}/${scope.generation}/`,
        );
        if (path.pathname.includes("session-events")) return new Response(body);
        inventoryReads++;
        await new Promise<void>((resolve) => pending.push(resolve));
        return Response.json({ version: 1, server: scope, resource: inventory });
      }) as typeof fetch,
    },
  });
  const frame = (type: string, revision: number, server = scope) =>
    stream.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ version: 1, server, type, revision })}\n\n`,
      ),
    );
  return { transport, frame, pending, reads: () => inventoryReads };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("scoped terminal transport", () => {
  it("waits for owner subscription barrier and rejects dirty prepared inventory", async () => {
    const f = fixture();
    try {
      const preparation = f.transport.prepareTerminalRuntimeInventory(
        target,
        new AbortController().signal,
      );
      await turn();
      expect(f.reads()).toBe(0);
      f.frame("ready", 0);
      await turn();
      expect(f.reads()).toBe(1);
      f.pending.shift()!();
      const prepared = await preparation;
      f.frame("invalidate", 1);
      await turn();
      expect(prepared.consume()).toBeNull();
    } finally {
      f.transport.disposeEventSupervisor();
    }
  });
  it("aborts preparation while event headers/barrier are pending", async () => {
    const f = fixture();
    const abort = new AbortController();
    const preparing = f.transport.prepareTerminalRuntimeInventory(target, abort.signal);
    abort.abort(new Error("selection changed"));
    await expect(preparing).rejects.toThrow("selection changed");
    expect(f.reads()).toBe(0);
    f.transport.disposeEventSupervisor();
  });
  it("rejects an event from another registered server before reading inventory", async () => {
    const f = fixture();
    const preparing = f.transport.prepareTerminalRuntimeInventory(
      target,
      new AbortController().signal,
    );
    f.frame("ready", 0, { ...scope, serverId: `tmux-server.${"b".repeat(32)}` });
    await expect(preparing).rejects.toThrow("generation mismatch");
    expect(f.reads()).toBe(0);
    f.transport.disposeEventSupervisor();
  });
  it("bounds a missing subscription barrier", async () => {
    const f = fixture();
    await expect(
      f.transport.prepareTerminalRuntimeInventory(target, new AbortController().signal),
    ).rejects.toThrow("deadline");
    f.transport.disposeEventSupervisor();
  });
});
