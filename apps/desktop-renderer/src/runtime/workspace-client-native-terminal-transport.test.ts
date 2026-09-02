/* @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import {
  blankTerminalReplicaSnapshot,
  hashTerminalReplicaSnapshot,
  hashTerminalReplicaTombstone,
} from "@tmux-ide/core";

import type { NativeTerminalEvent } from "../terminal/native-terminal-transport.ts";
import type {
  PaneStreamSessionListeners,
  PaneStreamTransport,
} from "../terminal/pane-stream-transport.ts";
import type { WebWorkspaceClient } from "./web-workspace-client.ts";
import { WebWorkspaceViewportError } from "./web-workspace-runtime.ts";
import { createWorkspaceClientNativeTerminalTransport } from "./workspace-client-native-terminal-transport.ts";

const GENERATION = "20000000-0000-4000-8000-000000000001";
const TARGET = { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.primary" };

function seed(revision: number, generation = GENERATION): CanonicalTerminalReplicaUpdate {
  const snapshot = blankTerminalReplicaSnapshot(20, 6);
  return {
    type: "terminal.seed",
    ...TARGET,
    generation,
    incarnation: `${generation}:0`,
    revision,
    cols: snapshot.cols,
    rows: snapshot.rows,
    stateHash: hashTerminalReplicaSnapshot(snapshot),
    hashAlgorithm: "fnv1a64-v1",
    snapshot,
  };
}

describe("WorkspaceClient native terminal adapter", () => {
  it("projects only an exact geometry conflict as a typed resize result", async () => {
    let result: "geometry-authority-conflict" | "authority-lost" = "geometry-authority-conflict";
    const client = {
      subscribeTerminal: () => () => undefined,
      fitViewport: vi.fn(async () => result),
    } as unknown as WebWorkspaceClient;
    const connected = await createWorkspaceClientNativeTerminalTransport(client).connect(
      {
        protocolVersion: 1,
        target: TARGET,
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 39, rows: 24 },
      },
      () => undefined,
    );
    if (connected.status !== "connected") throw new Error("attachment unavailable");

    await expect(connected.attachment.resize({ cols: 140, rows: 46 })).resolves.toEqual({
      status: "error",
      error: {
        code: "geometry-authority-conflict",
        reason: "Another client controls terminal geometry.",
        retryable: true,
      },
    });
    result = "authority-lost";
    await expect(connected.attachment.resize({ cols: 140, rows: 46 })).resolves.toMatchObject({
      status: "error",
      error: { code: "geometry-authority-lost", retryable: false },
    });
    connected.attachment.dispose();
  });

  it.each([
    ["geometry-authority-timeout", "Geometry authority did not settle before its deadline."],
    ["geometry-viewport-timeout", "Terminal geometry did not settle before its deadline."],
    ["pane-stream-closed", "The terminal stream closed before geometry settled."],
    ["geometry-lifecycle-retired", "The terminal runtime retired before geometry settled."],
    ["geometry-resize-failed", "Terminal geometry was not accepted."],
  ] as const)("preserves fatal runtime viewport code %s", async (code, reason) => {
    const client = {
      subscribeTerminal: () => () => undefined,
      fitViewport: vi.fn(async () => {
        throw new WebWorkspaceViewportError(code);
      }),
    } as unknown as WebWorkspaceClient;
    const connected = await createWorkspaceClientNativeTerminalTransport(client).connect(
      {
        protocolVersion: 1,
        target: TARGET,
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 39, rows: 24 },
      },
      () => undefined,
    );
    if (connected.status !== "connected") throw new Error("attachment unavailable");
    await expect(connected.attachment.resize({ cols: 140, rows: 46 })).resolves.toEqual({
      status: "error",
      error: { code, reason, retryable: false },
    });
  });

  it("carries authenticated raw seed and output through the one WorkspaceClient stream", async () => {
    let paneListeners: PaneStreamSessionListeners | null = null;
    const dispose = vi.fn();
    const paneStream = {
      connect: vi.fn(async (_request, listeners) => {
        paneListeners = listeners;
        return {
          status: "connected" as const,
          session: {
            dispose,
            write: vi.fn(async () => true),
            resize: vi.fn(async () => "ok" as const),
          },
        };
      }),
    } satisfies PaneStreamTransport;
    const client = {
      getSnapshot: () => ({ target: { daemon: { instanceId: GENERATION } } }),
    } as unknown as WebWorkspaceClient;
    const events: NativeTerminalEvent[] = [];
    const connected = await createWorkspaceClientNativeTerminalTransport(
      client,
      paneStream,
    ).connect(
      {
        protocolVersion: 1,
        target: TARGET,
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 20, rows: 5 },
      },
      (event) => {
        events.push(event);
      },
    );
    const seedBytes = new Uint8Array([0, 27, 91, 51, 74, 255]);
    const outputBytes = new Uint8Array([27, 91, 49, 109, 65]);
    await paneListeners!.onPaneEvent(TARGET.semanticPaneId, {
      type: "seed-batch",
      batch: {
        reset: { cols: 20, rows: 5 },
        seed: seedBytes,
        held: [],
        cursor: { x: 0, y: 0 },
      },
    });
    await paneListeners!.onPaneEvent(TARGET.semanticPaneId, {
      type: "output",
      bytes: outputBytes,
    });
    expect(
      events
        .filter(
          (event): event is Extract<NativeTerminalEvent, { type: "output" }> =>
            event.type === "output",
        )
        .map(({ bytes }) => bytes),
    ).toEqual([seedBytes, outputBytes]);
    if (connected.status !== "connected") throw new Error("attachment unavailable");
    connected.attachment.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("routes rolling history patches through bounded incremental xterm bytes", async () => {
    type Metadata = {
      canonicalSnapshot: ReturnType<typeof blankTerminalReplicaSnapshot> | null;
    };
    const listeners = new Set<
      (update: CanonicalTerminalReplicaUpdate, metadata: Metadata) => void
    >();
    const client = {
      subscribeTerminal: (
        _target: typeof TARGET,
        listener: (update: CanonicalTerminalReplicaUpdate, metadata: Metadata) => void,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      requestTerminalRepair: vi.fn(),
      sendTerminalInput: vi.fn(),
      fitViewport: vi.fn(),
    } as unknown as WebWorkspaceClient;
    const outputs: Uint8Array[] = [];
    const connected = await createWorkspaceClientNativeTerminalTransport(client).connect(
      {
        protocolVersion: 1,
        target: TARGET,
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 20, rows: 5 },
      },
      (event) => {
        if (event.type === "output") outputs.push(event.bytes);
      },
    );
    const blank = blankTerminalReplicaSnapshot(20, 5);
    const history = Array.from({ length: 5_000 }, () => blank.grid[0]!);
    const baseline = { ...blank, history };
    const seeded: CanonicalTerminalReplicaUpdate = {
      type: "terminal.seed",
      ...TARGET,
      generation: GENERATION,
      incarnation: `${GENERATION}:0`,
      revision: 0,
      cols: 20,
      rows: 5,
      stateHash: hashTerminalReplicaSnapshot(baseline),
      hashAlgorithm: "fnv1a64-v1",
      snapshot: baseline,
    };
    for (const listener of listeners) listener(seeded, { canonicalSnapshot: baseline });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const appended = { ...blank.grid[0]!, wrapped: false };
    const target = {
      ...blank,
      history: [...history, appended],
      grid: [...baseline.grid.slice(1), appended],
    };
    const patched: CanonicalTerminalReplicaUpdate = {
      type: "terminal.patch",
      ...TARGET,
      generation: GENERATION,
      incarnation: `${GENERATION}:0`,
      baseRevision: 0,
      revision: 1,
      cols: 20,
      rows: 5,
      stateHash: hashTerminalReplicaSnapshot(target),
      hashAlgorithm: "fnv1a64-v1",
      patch: {
        historyDelta: { trim: 0, append: [appended] },
        rows: [{ index: 4, row: appended }],
      },
    };
    for (const listener of listeners) listener(patched, { canonicalSnapshot: target });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(outputs).toHaveLength(2);
    const rolling = new TextDecoder().decode(outputs[1]);
    expect(rolling).toContain("\u001b[5;1H\n");
    expect(rolling).not.toContain("\u001b[2J");
    expect(rolling).not.toContain("\u001b[3J");
    expect(outputs[1]!.byteLength).toBeLessThan(256);
    if (connected.status !== "connected") throw new Error("attachment unavailable");
    connected.attachment.dispose();
  });

  it("coalesces a slow Web paint to latest canonical truth without blocking client ingress", async () => {
    const listeners = new Set<
      (
        update: CanonicalTerminalReplicaUpdate,
        metadata: { canonicalSnapshot: ReturnType<typeof blankTerminalReplicaSnapshot> | null },
      ) => void
    >();
    const sendTerminalInput = vi.fn(async () => "ok" as const);
    const fitViewport = vi.fn(async () => "ok" as const);
    const client = {
      subscribeTerminal: (
        _target: typeof TARGET,
        listener: typeof listeners extends Set<infer Listener> ? Listener : never,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      requestTerminalRepair: vi.fn(),
      sendTerminalInput,
      fitViewport,
    } as unknown as WebWorkspaceClient;
    const transport = createWorkspaceClientNativeTerminalTransport(client);
    const events: NativeTerminalEvent[] = [];
    let releaseFirstOutput!: () => void;
    const firstOutput = new Promise<void>((resolve) => {
      releaseFirstOutput = resolve;
    });
    let outputCount = 0;
    const result = await transport.connect(
      {
        protocolVersion: 1,
        target: TARGET,
        viewerMode: "interactive",
        geometryOwnership: "owner",
        viewport: { cols: 20, rows: 6 },
      },
      async (event) => {
        events.push(event);
        if (event.type === "output" && outputCount++ === 0) await firstOutput;
      },
    );
    expect(result.status).toBe("connected");
    const publish = (update: CanonicalTerminalReplicaUpdate): void => {
      for (const listener of listeners)
        listener(update, {
          canonicalSnapshot:
            update.type === "terminal.tombstone"
              ? null
              : update.type === "terminal.seed"
                ? update.snapshot
                : null,
        });
    };
    publish(seed(0));
    await Promise.resolve();
    publish(seed(1));
    publish(seed(2));
    expect(events.filter(({ type }) => type === "output")).toHaveLength(1);
    releaseFirstOutput();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const output = events.filter(
      (event): event is Extract<NativeTerminalEvent, { type: "output" }> => event.type === "output",
    );
    expect(output).toHaveLength(2);
    expect(output[1]?.canonical?.revision).toBe(2);
    publish({
      type: "terminal.tombstone",
      ...TARGET,
      generation: GENERATION,
      incarnation: `${GENERATION}:0`,
      baseRevision: 2,
      revision: 3,
      cols: 20,
      rows: 6,
      stateHash: hashTerminalReplicaTombstone("pane-closed"),
      hashAlgorithm: "fnv1a64-v1",
      tombstone: { reason: "pane-closed" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events.filter(({ type }) => type === "state").at(-1)).toMatchObject({
      type: "state",
      state: "disconnected",
    });
    const replacement = "30000000-0000-4000-8000-000000000001";
    publish(seed(0, replacement));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events.filter(({ type }) => type === "state").at(-1)).toMatchObject({
      type: "state",
      state: "connected",
    });
    expect(
      events
        .filter(
          (event): event is Extract<NativeTerminalEvent, { type: "output" }> =>
            event.type === "output",
        )
        .at(-1)?.canonical?.generation,
    ).toBe(replacement);

    if (result.status !== "connected") throw new Error("attachment unavailable");
    await expect(result.attachment.write(new TextEncoder().encode("echo ok"))).resolves.toEqual({
      status: "ok",
    });
    await expect(result.attachment.resize({ cols: 100, rows: 30 })).resolves.toEqual({
      status: "ok",
    });
    expect(sendTerminalInput).toHaveBeenCalledWith(TARGET, { kind: "text", data: "echo ok" });
    expect(fitViewport).toHaveBeenCalledWith(100, 30);
    const passive = await transport.connect(
      {
        protocolVersion: 1,
        target: { workspaceName: "workspace-a", semanticPaneId: "pane.workspace.secondary" },
        viewerMode: "interactive",
        geometryOwnership: "passive",
        viewport: { cols: 20, rows: 6 },
      },
      async () => undefined,
    );
    if (passive.status !== "connected") throw new Error("passive pane unavailable");
    await expect(passive.attachment.resize({ cols: 70, rows: 20 })).resolves.toEqual({
      status: "ok",
    });
    expect(fitViewport).toHaveBeenCalledTimes(1);
    passive.attachment.dispose();
    result.attachment.dispose();
    expect(listeners.size).toBe(0);
  });
});
