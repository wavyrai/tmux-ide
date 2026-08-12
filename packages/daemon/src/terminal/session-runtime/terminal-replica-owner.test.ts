import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";

const generation = "00000000-0000-4000-8000-000000000001";

describe("SessionRuntimeTerminalReplicaOwner", () => {
  it("captures a controlled probe once at reset and leaves the following delta anonymous", async () => {
    let request: MirrorSubscribeRequest | undefined;
    const trace: SessionRuntimeTraceContext = {
      traceId: "00000000-0000-4000-8000-000000000099",
      scenario: "terminal-input-to-paint",
      authority: { generation, incarnation: `${generation}:0` },
    };
    const takeOutputTrace = vi
      .fn()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(trace)
      .mockReturnValue(null);
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onEvent({ type: "reset", cols: 4, rows: 1 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("BOOT") });
          candidate.onEvent({ type: "cursor", x: 0, y: 0 });
        });
        return subscription(candidate);
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      generation,
      "workspace",
      "pane-a",
      mirror as never,
      {
        incarnation: `${generation}:0`,
        initialRevision: 0,
        takeOutputTrace,
      },
    );
    const observed: Array<SessionRuntimeTraceContext | null> = [];
    const liveSubscription = await owner.subscribe((_update, candidate) =>
      observed.push(candidate),
    );
    expect(observed).toEqual([null]);
    request!.onEvent({ type: "reset", cols: 4, rows: 1 });
    request!.onEvent({ type: "seed", data: new TextEncoder().encode("A") });
    request!.onEvent({ type: "cursor", x: 1, y: 0 });
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(observed[1]).toEqual(trace);
    request!.onEvent({ type: "delta", data: new TextEncoder().encode("B") });
    await vi.waitFor(() => expect(observed).toHaveLength(3));
    expect(observed[2]).toBeNull();
    expect(takeOutputTrace).toHaveBeenCalledTimes(3);
    await liveSubscription.close();
    await owner.dispose();
  });

  it("waits for one atomic capture seed, shares one parser after clients leave, and isolates listeners", async () => {
    let request: MirrorSubscribeRequest | undefined;
    let subscriptions = 0;
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        subscriptions += 1;
        request = candidate;
        setTimeout(() => {
          candidate.onEvent({ type: "reset", cols: 10, rows: 2 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("abc") });
          candidate.onLayout?.(layout(12, 3));
          candidate.onEvent({ type: "cursor", x: 1, y: 0 });
        }, 0);
        return {
          session: candidate.session,
          semanticPaneId: candidate.semanticPaneId,
          freeze: () => undefined,
          thaw: () => undefined,
          sendText: () => undefined,
          sendKey: () => undefined,
          close: async () => undefined,
        };
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      generation,
      "workspace",
      "pane-a",
      mirror as never,
      { incarnation: `${generation}:0`, initialRevision: 0 },
    );
    const firstUpdates: CanonicalTerminalReplicaUpdate[] = [];
    const first = await owner.subscribe((update) => firstUpdates.push(update));
    expect(firstUpdates.map((update) => [update.type, update.revision])).toEqual([
      ["terminal.seed", 0],
    ]);
    expect(firstUpdates[0]).toMatchObject({ cols: 12, rows: 3 });
    await first.close();

    const throwing = await owner.subscribe(() => {
      throw new Error("client paint failed");
    });
    const healthyUpdates: CanonicalTerminalReplicaUpdate[] = [];
    const healthy = await owner.subscribe((update) => healthyUpdates.push(update));
    request!.onEvent({ type: "delta", data: new TextEncoder().encode("Z") });
    await vi.waitFor(() => expect(healthyUpdates.at(-1)?.type).toBe("terminal.patch"));
    expect(subscriptions).toBe(1);
    await throwing.close();
    await healthy.close();
    await owner.dispose();
  });

  it("does not publish a blank seed when layout precedes the reset capture", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        queueMicrotask(() => {
          candidate.onLayout?.(layout(12, 3));
          candidate.onEvent({ type: "reset", cols: 10, rows: 2 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("populated") });
          candidate.onEvent({ type: "cursor", x: 9, y: 0 });
        });
        return subscription(candidate);
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      generation,
      "workspace",
      "pane-a",
      mirror as never,
      { incarnation: `${generation}:0`, initialRevision: 0 },
    );
    await owner.subscribe((update) => updates.push(update));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 10, rows: 2 });
    expect(
      updates[0]?.type === "terminal.seed" && updates[0].snapshot.grid[0]?.cells[0]?.grapheme,
    ).toBe("p");
    await owner.dispose();
  });

  it("reports pane closure after the tombstone is revisioned", async () => {
    let request: MirrorSubscribeRequest | undefined;
    let closed = 0;
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onEvent({ type: "reset", cols: 4, rows: 1 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("x") });
          candidate.onEvent({ type: "cursor", x: 0, y: 0 });
        });
        return {
          session: candidate.session,
          semanticPaneId: candidate.semanticPaneId,
          freeze: () => undefined,
          thaw: () => undefined,
          sendText: () => undefined,
          sendKey: () => undefined,
          close: async () => undefined,
        };
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      generation,
      "workspace",
      "pane-a",
      mirror as never,
      { incarnation: `${generation}:0`, initialRevision: 0, onClosed: () => (closed += 1) },
    );
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    await owner.subscribe((update) => updates.push(update));
    request!.onEvent({ type: "closed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates.at(-1)?.type).toBe("terminal.tombstone");
    expect(closed).toBe(1);
  });
});

function subscription(candidate: MirrorSubscribeRequest): MirrorSubscription {
  return {
    session: candidate.session,
    semanticPaneId: candidate.semanticPaneId,
    freeze: () => undefined,
    thaw: () => undefined,
    sendText: () => undefined,
    sendKey: () => undefined,
    close: async () => undefined,
  };
}

function layout(width: number, height: number) {
  return {
    type: "layout" as const,
    session: "workspace",
    semanticWindowId: "window-a",
    windowName: "main",
    currentWindow: true,
    cols: width,
    rows: height,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [
      {
        semanticPaneId: "pane-a",
        left: 0,
        top: 0,
        width,
        height,
        active: true,
      },
    ],
  };
}
