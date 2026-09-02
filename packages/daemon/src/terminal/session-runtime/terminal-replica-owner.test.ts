import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";

const generation = "00000000-0000-4000-8000-000000000001";

describe("SessionRuntimeTerminalReplicaOwner", () => {
  it("delegates interactive write priority synchronously", async () => {
    const delegated = vi.spyOn(TerminalReplicaInterpreter.prototype, "prioritizeNextWrite");
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        queueMicrotask(() => {
          candidate.onLayout?.(layout(4, 1));
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
      { incarnation: `${generation}:0`, initialRevision: 0 },
    );
    owner.prioritizeNextWrite();
    expect(delegated).toHaveBeenCalledTimes(1);
    await owner.subscribe(() => undefined);
    await owner.dispose();
    delegated.mockRestore();
  });

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
          candidate.onLayout?.(layout(4, 1));
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
          candidate.onLayout?.(layout(12, 3, "top"));
          candidate.onEvent({ type: "reset", cols: 12, rows: 2 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("abc") });
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

  it("atomically projects a native top-border capture into canonical visible geometry", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        queueMicrotask(() => {
          candidate.onLayout?.(layout(12, 3, "top"));
          candidate.onEvent({ type: "reset", cols: 12, rows: 2 });
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
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 12, rows: 3 });
    expect(
      updates[0]?.type === "terminal.seed" && updates[0].snapshot.grid[0]?.cells[0]?.grapheme,
    ).toBe("p");
    await owner.dispose();
  });

  it.each([
    ["off", 3, 3],
    ["top", 3, 4],
    ["bottom", 3, 4],
  ] as const)(
    "publishes exactly one %s-border seed at the leased visible geometry",
    async (status, nativeRows, visibleRows) => {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
          queueMicrotask(() => {
            candidate.onLayout?.(layout(8, visibleRows, status));
            candidate.onEvent({ type: "reset", cols: 8, rows: nativeRows });
            candidate.onEvent({
              type: "seed",
              data: new TextEncoder().encode("A界e\u0301\r\nheld"),
            });
            candidate.onEvent({ type: "delta", data: new TextEncoder().encode("-delta") });
            candidate.onEvent({ type: "cursor", x: 3, y: 1 });
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
      expect(updates[0]).toMatchObject({
        type: "terminal.seed",
        revision: 0,
        cols: 8,
        rows: visibleRows,
        snapshot: { cursor: { x: 3, y: 1 } },
      });
      await owner.dispose();
    },
  );

  it.each(["top", "bottom"] as const)(
    "keeps an interior pane's full native height with %s border status",
    async (status) => {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
          queueMicrotask(() => {
            const base = layout(8, 10, status);
            candidate.onLayout?.({
              ...base,
              panes: [{ ...base.panes[0]!, top: 3, height: 4 }],
            });
            candidate.onEvent({ type: "reset", cols: 8, rows: 4 });
            candidate.onEvent({ type: "seed", data: new TextEncoder().encode("interior") });
            candidate.onEvent({ type: "cursor", x: 1, y: 0 });
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
      expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 4 });
      await owner.dispose();
    },
  );

  it("normalizes tmux's right-margin cursor state into the final canonical column", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        queueMicrotask(() => {
          candidate.onLayout?.(layout(8, 4, "top"));
          candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("wrapped!") });
          candidate.onEvent({ type: "cursor", x: 8, y: 0 });
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
    expect(updates[0]).toMatchObject({
      type: "terminal.seed",
      snapshot: { cursor: { x: 7, y: 0 } },
    });
    await owner.dispose();
  });

  it("retries one crossed layout epoch and commits only the current capture", async () => {
    let request: MirrorSubscribeRequest | undefined;
    let reseeds = 0;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const emitCapture = (candidate: MirrorSubscribeRequest, visibleRows: number, text: string) => {
      candidate.onEvent({ type: "reset", cols: 8, rows: visibleRows - 1 });
      candidate.onEvent({ type: "seed", data: new TextEncoder().encode(text) });
      candidate.onEvent({ type: "cursor", x: 1, y: 0 });
    };
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.(layout(8, 4, "top"));
          emitCapture(candidate, 4, "stale");
          candidate.onLayout?.(layout(8, 5, "top"));
        });
        return {
          ...subscription(candidate),
          reseed: () => {
            reseeds += 1;
            emitCapture(candidate, 5, "current");
          },
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
    await owner.subscribe((update) => updates.push(update));
    expect(request).toBeDefined();
    expect(reseeds).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 5 });
    expect(
      updates[0]?.type === "terminal.seed" && updates[0].snapshot.grid[0]?.cells[0]?.grapheme,
    ).toBe("c");
    await owner.dispose();
  });

  it("ignores unrelated windows before and after its target lease without clearing or retrying", async () => {
    let reseeds = 0;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        queueMicrotask(() => {
          candidate.onLayout?.(layoutFor("window-unrelated", "pane-other", 20, 6, "off"));
          candidate.onLayout?.(layoutFor("window-a", "pane-a", 8, 4, "top"));
          candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("target") });
          candidate.onLayout?.(layoutFor("window-unrelated", "pane-other", 30, 7, "off"));
          candidate.onEvent({ type: "cursor", x: 1, y: 0 });
        });
        return {
          ...subscription(candidate),
          reseed: () => (reseeds += 1),
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
    await owner.subscribe((update) => updates.push(update));
    expect(reseeds).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 4 });
    await owner.dispose();
  });

  it.each(["target-absent", "malformed"] as const)(
    "invalidates a pending lease when its owning window becomes %s",
    async (failure) => {
      let reseeds = 0;
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
          queueMicrotask(() => {
            candidate.onLayout?.(layoutFor("window-a", "pane-a", 8, 4, "top"));
            candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
            candidate.onEvent({ type: "seed", data: new TextEncoder().encode("stale") });
            candidate.onLayout?.(
              failure === "target-absent"
                ? layoutFor("window-a", "pane-other", 8, 4, "top")
                : { ...layoutFor("window-a", "pane-a", 8, 4, "top"), cols: 0 },
            );
            candidate.onEvent({ type: "cursor", x: 1, y: 0 });
          });
          return {
            ...subscription(candidate),
            reseed: () => {
              reseeds += 1;
              candidate.onLayout?.(layoutFor("window-a", "pane-a", 8, 4, "top"));
              candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
              candidate.onEvent({ type: "seed", data: new TextEncoder().encode("current") });
              candidate.onEvent({ type: "cursor", x: 1, y: 0 });
            },
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
      await owner.subscribe((update) => updates.push(update));
      expect(reseeds).toBe(1);
      expect(updates).toHaveLength(1);
      expect(
        updates[0]?.type === "terminal.seed" && updates[0].snapshot.grid[0]?.cells[0]?.grapheme,
      ).toBe("c");
      await owner.dispose();
    },
  );

  it("fences an old owning window after a pane move and admits the new window lease", async () => {
    let request: MirrorSubscribeRequest | undefined;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.(layoutFor("window-a", "pane-a", 8, 4, "top"));
          candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("a") });
          candidate.onEvent({ type: "cursor", x: 1, y: 0 });
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
    request!.onLayout?.(layoutFor("window-b", "pane-a", 10, 5, "top"));
    request!.onLayout?.(layoutFor("window-a", "pane-other", 8, 4, "top"));
    request!.onEvent({ type: "reset", cols: 10, rows: 4 });
    request!.onEvent({ type: "seed", data: new TextEncoder().encode("b") });
    request!.onEvent({ type: "cursor", x: 1, y: 0 });
    await vi.waitFor(() => expect(updates).toHaveLength(3));
    expect(updates.map((update) => [update.type, update.cols, update.rows])).toEqual([
      ["terminal.seed", 8, 4],
      ["terminal.patch", 10, 5],
      ["terminal.seed", 10, 5],
    ]);
    await owner.dispose();
  });

  it("suppresses identical layout leases and patches only a true later geometry change", async () => {
    let request: MirrorSubscribeRequest | undefined;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.(layout(8, 4, "top"));
          candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("stable") });
          candidate.onEvent({ type: "cursor", x: 1, y: 0 });
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
    request!.onLayout?.(layout(8, 4, "top"));
    await Promise.resolve();
    expect(updates.map((update) => update.type)).toEqual(["terminal.seed"]);
    request!.onLayout?.(layout(9, 4, "top"));
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toMatchObject({ type: "terminal.patch", cols: 9, rows: 4 });
    await owner.dispose();
  });

  it("keeps a pending capture valid across ordinary tmux focus changes", async () => {
    let reseeds = 0;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        queueMicrotask(() => {
          const initial = layout(8, 4, "top");
          candidate.onLayout?.(initial);
          candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("stable") });
          candidate.onLayout?.({
            ...initial,
            currentWindow: false,
            panes: initial.panes.map((pane) => ({ ...pane, active: false })),
          });
          candidate.onEvent({ type: "cursor", x: 1, y: 0 });
        });
        return {
          ...subscription(candidate),
          reseed: () => (reseeds += 1),
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
    await owner.subscribe((update) => updates.push(update));
    expect(reseeds).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 4 });
    await owner.dispose();
  });

  it.each([
    ["column mismatch", layout(9, 4, "top"), { cols: 8, rows: 3, x: 1, y: 0 }],
    ["off-row mismatch", layout(8, 4, "off"), { cols: 8, rows: 3, x: 1, y: 0 }],
    ["cursor overflow", layout(8, 4, "top"), { cols: 8, rows: 3, x: 9, y: 0 }],
    [
      "duplicate pane identity",
      {
        ...layout(8, 4, "top"),
        panes: [...layout(8, 4, "top").panes, ...layout(8, 4, "top").panes],
      },
      { cols: 8, rows: 3, x: 1, y: 0 },
    ],
    [
      "wrong window identity",
      { ...layout(8, 4, "top"), semanticWindowId: null },
      { cols: 8, rows: 3, x: 1, y: 0 },
    ],
  ] as const)("retries once then fails closed for %s", async (_label, candidateLayout, native) => {
    let reseeds = 0;
    const faults: unknown[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        const emitInvalid = () => {
          candidate.onLayout?.(candidateLayout);
          candidate.onEvent({ type: "reset", cols: native.cols, rows: native.rows });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("invalid") });
          candidate.onEvent({ type: "cursor", x: native.x, y: native.y });
        };
        queueMicrotask(emitInvalid);
        return {
          ...subscription(candidate),
          reseed: () => {
            reseeds += 1;
            emitInvalid();
          },
        };
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
        onFault: (error) => faults.push(error),
      },
    );
    await expect(owner.subscribe(() => undefined)).rejects.toThrow(/terminal reseed/u);
    expect(reseeds).toBe(1);
    expect(faults).toHaveLength(1);
    expect(owner.qualificationSnapshot()).toMatchObject({ revision: null, stateHash: null });
    await owner.dispose();
  });

  it("fences delayed capture completion after disposal without retry or publication", async () => {
    let request: MirrorSubscribeRequest | undefined;
    let reseeds = 0;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        return {
          ...subscription(candidate),
          reseed: () => (reseeds += 1),
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
    await Promise.resolve();
    request!.onLayout?.(layout(8, 4, "top"));
    request!.onEvent({ type: "reset", cols: 8, rows: 3 });
    request!.onEvent({ type: "seed", data: new TextEncoder().encode("late") });
    await owner.dispose();
    request!.onEvent({ type: "cursor", x: 1, y: 0 });
    await Promise.resolve();
    expect(reseeds).toBe(0);
    expect(updates).toEqual([]);
  });

  it("reports pane closure after the tombstone is revisioned", async () => {
    let request: MirrorSubscribeRequest | undefined;
    let closed = 0;
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.(layout(4, 1));
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
    reseed: () => undefined,
    sendText: () => undefined,
    sendKey: () => undefined,
    close: async () => undefined,
  };
}

function layout(width: number, height: number, paneBorderStatus: "top" | "bottom" | "off" = "off") {
  return layoutFor("window-a", "pane-a", width, height, paneBorderStatus);
}

function layoutFor(
  semanticWindowId: string,
  semanticPaneId: string,
  width: number,
  height: number,
  paneBorderStatus: "top" | "bottom" | "off" = "off",
) {
  return {
    type: "layout" as const,
    session: "workspace",
    semanticWindowId,
    windowName: "main",
    currentWindow: true,
    cols: width,
    rows: height,
    zoomed: false,
    paneBorderStatus,
    panes: [
      {
        semanticPaneId,
        left: 0,
        top: 0,
        width,
        height,
        active: true,
      },
    ],
  };
}
