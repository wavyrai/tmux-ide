import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
} from "@tmux-ide/core";

import type {
  PaneStreamSessionListeners,
  PaneStreamTransport,
} from "../terminal/pane-stream-transport.ts";
import { connectWebWorkspaceRuntime } from "./web-workspace-runtime.ts";

const GENERATION = "20000000-0000-4000-8000-000000000001";
const PANE = "pane.workspace.primary";

function seed(revision: number): CanonicalTerminalReplicaUpdate {
  const snapshot = blankTerminalReplicaSnapshot(12, 4);
  return Object.freeze({
    type: "terminal.seed",
    workspaceName: "workspace-a",
    semanticPaneId: PANE,
    generation: GENERATION,
    incarnation: `${GENERATION}:0`,
    revision,
    cols: snapshot.cols,
    rows: snapshot.rows,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
    snapshot,
  });
}

describe("Web WorkspaceClient runtime adapter", () => {
  it("reports authority only when the exact physical connection holds its lease", async () => {
    let localClientId: string | null = null;
    const runtime = await connectWebWorkspaceRuntime({
      transport: {
        connect: async (_request, listeners) => {
          listeners.onAuthoritySnapshot?.({
            generation: GENERATION,
            session: "runtime-a",
            revision: 1,
            owners: { input: null, focus: null, geometry: "client-a" },
            nativeGeometryYieldUntilMs: 0,
            clients: [],
          });
          return {
            status: "connected",
            session: {
              dispose: vi.fn(),
              connectionAuthorityClientId: () => localClientId,
            },
          };
        },
      },
      inventory: {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: [PANE],
      },
      signal: new AbortController().signal,
    });
    expect(runtime.ownsConnectionAuthority?.("geometry")).toBe(false);
    expect(runtime.connectionAuthorityClientId?.("geometry")).toBeNull();
    localClientId = "client-a";
    expect(runtime.ownsConnectionAuthority?.("geometry")).toBe(true);
    expect(runtime.connectionAuthorityClientId?.("geometry")).toBe("client-a");
    localClientId = null;
    expect(runtime.ownsConnectionAuthority?.("geometry")).toBe(false);
    runtime.close();
  });

  it("records only accepted seed-first replacement evidence in detailed mode", async () => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    let listeners: PaneStreamSessionListeners | null = null;
    const runtime = await connectWebWorkspaceRuntime({
      transport: {
        connect: async (_request, next) => {
          listeners = next;
          next.onDiagnosticLifecycle?.({
            generation: GENERATION,
            requestId: "10000000-0000-4000-8000-000000000001",
            stage: "issued",
            code: "none",
            origin: "client",
            closeCode: null,
            closeReason: "none",
          });
          next.onDiagnosticLifecycle?.({
            generation: GENERATION,
            requestId: "10000000-0000-4000-8000-000000000001",
            stage: "server-ready",
            code: "none",
            origin: "unknown",
            closeCode: null,
            closeReason: "none",
          });
          return { status: "connected", session: { dispose: vi.fn() } };
        },
      },
      inventory: {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: [PANE],
      },
      signal: new AbortController().signal,
    });
    const replacement = seed(0);
    await listeners!.onPaneEvent(PANE, {
      type: "output",
      bytes: new Uint8Array(),
      canonicalUpdate: replacement,
      canonicalSnapshot: replacement.type === "terminal.seed" ? replacement.snapshot : undefined,
    });
    listeners!.onDeliveryAckSent?.({
      generation: GENERATION,
      canonicalRevision: 0,
    } as never);
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      events: readonly unknown[];
      socketEvents: readonly unknown[];
      ackEvents: readonly unknown[];
      lifecycleEvents: readonly unknown[];
    };
    expect(read().events).toEqual([
      { type: "terminal.seed", generation: GENERATION, revision: 0, acceptedOrdinal: 0 },
    ]);
    expect(read().socketEvents).toEqual([{ generation: GENERATION, outcome: "open", ordinal: 0 }]);
    expect(read().ackEvents).toEqual([{ generation: GENERATION, revision: 0, ordinal: 0 }]);
    runtime.close();
    expect(read().socketEvents).toEqual([
      { generation: GENERATION, outcome: "open", ordinal: 0 },
      { generation: GENERATION, outcome: "closed", ordinal: 1 },
    ]);
    expect(read().lifecycleEvents).toEqual([
      expect.objectContaining({ stage: "issued", ordinal: 0 }),
      expect.objectContaining({ stage: "server-ready", ordinal: 1 }),
      expect.objectContaining({
        stage: "terminal",
        code: "runtime-ended",
        origin: "client",
        ordinal: 2,
      }),
    ]);
    delete globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
    delete globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__;
    delete globals.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  });

  it("labels an unclassified transport fallback unknown and suppresses its late dispose terminal", async () => {
    const globals = globalThis as typeof globalThis & Record<string, unknown>;
    globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    let listeners: PaneStreamSessionListeners | null = null;
    const runtime = await connectWebWorkspaceRuntime({
      transport: {
        connect: async (_request, next) => {
          listeners = next;
          next.onDiagnosticLifecycle?.({
            generation: GENERATION,
            requestId: "10000000-0000-4000-8000-000000000002",
            stage: "issued",
            code: "none",
            origin: "client",
            closeCode: null,
            closeReason: "none",
          });
          return {
            status: "connected",
            session: {
              dispose: () =>
                next.onDiagnosticLifecycle?.({
                  generation: GENERATION,
                  requestId: "10000000-0000-4000-8000-000000000002",
                  stage: "terminal",
                  code: "disposed",
                  origin: "dispose",
                  closeCode: 1000,
                  closeReason: "renderer-disposed",
                }),
            },
          };
        },
      },
      inventory: {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: [PANE],
      },
      signal: new AbortController().signal,
    });
    listeners!.onEnd({ code: "unclassified", reason: "bounded", retryable: true });
    await runtime.closed;
    const read = globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ as () => {
      lifecycleEvents: readonly Record<string, unknown>[];
    };
    expect(read().lifecycleEvents.filter(({ stage }) => stage === "terminal")).toEqual([
      expect.objectContaining({ code: "runtime-fault", origin: "unknown" }),
    ]);
    delete globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
    delete globals.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__;
    delete globals.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  });

  it("owns one issued stream, fans canonical truth out synchronously, and replays on thaw", async () => {
    let listeners: PaneStreamSessionListeners | null = null;
    const write = vi.fn(async () => true);
    const resize = vi.fn(async () => "ok" as const);
    const dispose = vi.fn();
    const connect = vi.fn<PaneStreamTransport["connect"]>(async (_request, next) => {
      listeners = next;
      return { status: "connected", session: { dispose, write, resize } };
    });
    const runtime = await connectWebWorkspaceRuntime({
      transport: { connect },
      inventory: {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: [PANE, "pane.workspace.secondary"],
      },
      signal: new AbortController().signal,
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0]?.[0]).toEqual({
      workspaceName: "workspace-a",
      panes: [PANE, "pane.workspace.secondary"],
      viewerMode: "interactive",
    });

    const target = { workspaceName: "workspace-a", semanticPaneId: PANE };
    const first = await runtime.subscribeTerminal(target);
    const second = await runtime.subscribeTerminal(target);
    const firstUpdates: CanonicalTerminalReplicaUpdate[] = [];
    const secondUpdates: CanonicalTerminalReplicaUpdate[] = [];
    first.onUpdate((update) => firstUpdates.push(update as CanonicalTerminalReplicaUpdate));
    second.onUpdate((update) => secondUpdates.push(update as CanonicalTerminalReplicaUpdate));

    const firstSeed = seed(0);
    const secondSeed = seed(1);
    await listeners!.onPaneEvent(PANE, {
      type: "output",
      bytes: new Uint8Array(),
      canonicalUpdate: firstSeed,
      canonicalSnapshot: firstSeed.type === "terminal.seed" ? firstSeed.snapshot : undefined,
    });
    expect(firstUpdates).toHaveLength(1);
    expect(secondUpdates).toHaveLength(1);
    first.freeze();
    await listeners!.onPaneEvent(PANE, {
      type: "output",
      bytes: new Uint8Array(),
      canonicalUpdate: secondSeed,
      canonicalSnapshot: secondSeed.type === "terminal.seed" ? secondSeed.snapshot : undefined,
    });
    expect(firstUpdates).toHaveLength(1);
    expect(secondUpdates).toHaveLength(2);
    first.thaw();
    expect(firstUpdates).toHaveLength(2);
    expect(firstUpdates[1]).toMatchObject({ type: "terminal.seed", revision: 1 });
    first.freeze();
    const tombstone: CanonicalTerminalReplicaUpdate = {
      type: "terminal.tombstone",
      workspaceName: "workspace-a",
      semanticPaneId: PANE,
      generation: GENERATION,
      incarnation: `${GENERATION}:0`,
      baseRevision: 1,
      revision: 2,
      cols: 12,
      rows: 4,
      stateHash: hashTerminalReplicaTombstone("pane-closed"),
      hashAlgorithm: "fnv1a64-v1",
      tombstone: { reason: "pane-closed" },
    };
    await listeners!.onPaneEvent(PANE, {
      type: "closed",
      canonicalUpdate: tombstone,
    });
    expect(secondUpdates.at(-1)).toMatchObject({ type: "terminal.tombstone", revision: 2 });
    first.thaw();
    expect(firstUpdates).toHaveLength(2);

    await expect(
      runtime.sendTerminalInput(target, { kind: "text", data: "echo ok" }),
    ).resolves.toBe("ok");
    await expect(runtime.fitViewport(100, 30)).resolves.toBe("ok");
    expect(write).toHaveBeenCalledWith(PANE, { kind: "text", data: "echo ok" });
    expect(resize).toHaveBeenCalledWith(100, 30);
    runtime.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit geometry rejection but rejects generic resize failure", async () => {
    let listeners: PaneStreamSessionListeners | null = null;
    let resizeResult:
      | "geometry-authority-conflict"
      | "authority-timeout"
      | "viewport-timeout"
      | "stream-closed"
      | "failed" = "geometry-authority-conflict";
    let resizeThrows = false;
    const connect = vi.fn<PaneStreamTransport["connect"]>(async (_request, next) => {
      listeners = next;
      return {
        status: "connected",
        session: {
          dispose: vi.fn(),
          resize: vi.fn(async () => {
            if (resizeThrows) throw new Error("private resize fault");
            return resizeResult;
          }),
        },
      };
    });
    const runtime = await connectWebWorkspaceRuntime({
      transport: { connect },
      inventory: {
        workspaceName: "workspace-a",
        workspaceId: "workspace-a",
        sessionId: "session-a",
        daemonGeneration: GENERATION,
        shellGeneration: 1,
        semanticPaneIds: [PANE],
      },
      signal: new AbortController().signal,
    });
    expect(listeners).not.toBeNull();

    await expect(runtime.fitViewport(140, 46)).resolves.toBe("geometry-authority-conflict");
    for (const [result, code] of [
      ["authority-timeout", "geometry-authority-timeout"],
      ["viewport-timeout", "geometry-viewport-timeout"],
      ["stream-closed", "pane-stream-closed"],
      ["failed", "geometry-resize-failed"],
    ] as const) {
      resizeResult = result;
      await expect(runtime.fitViewport(140, 46)).rejects.toEqual(expect.objectContaining({ code }));
    }
    resizeThrows = true;
    await expect(runtime.fitViewport(140, 46)).rejects.toEqual(
      expect.objectContaining({ code: "geometry-resize-failed" }),
    );
    resizeThrows = false;
    runtime.close();
    await expect(runtime.fitViewport(140, 46)).rejects.toEqual(
      expect.objectContaining({ code: "geometry-lifecycle-retired" }),
    );
  });
});
