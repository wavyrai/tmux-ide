import { describe, expect, it, vi } from "vitest";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import type { MirrorSubscribeRequest, MirrorSubscription } from "../mirror/mirror-service.ts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { SessionRuntimeTerminalReplicaOwner } from "./terminal-replica-owner.ts";
import type { SessionRuntimeTraceContext } from "./runtime-observability.ts";

const generation = "00000000-0000-4000-8000-000000000001";

describe("SessionRuntimeTerminalReplicaOwner", () => {
  it.each(["stable", "output", "layout", "content", "dimensions", "disposal"])(
    "admits native backing only for matching canonical state: %s",
    async (change) => {
      let request!: MirrorSubscribeRequest;
      let release!: (value: import("../mirror/native-grid-reader.ts").NativeGridReadResult) => void;
      let rawCurrent = true;
      const captureNativeBacking = vi.fn(
        () =>
          new Promise<import("../mirror/native-grid-reader.ts").NativeGridReadResult>((resolve) => {
            release = resolve;
          }),
      );
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
          request = candidate;
          queueMicrotask(() => {
            candidate.onLayout?.(layout(4, 1));
            candidate.onEvent({ type: "reset", cols: 4, rows: 1 });
            candidate.onEvent({ type: "seed", data: new TextEncoder().encode("BOOT") });
            candidate.onEvent({ type: "cursor", x: 0, y: 0 });
          });
          return { ...subscription(candidate), captureNativeBacking };
        },
      };
      const owner = new SessionRuntimeTerminalReplicaOwner(
        generation,
        "workspace",
        "pane-a",
        mirror as never,
        { incarnation: `${generation}:0`, initialRevision: 0 },
      );
      try {
        await owner.subscribe(() => undefined);
        const before = owner.qualificationSnapshot();
        const pending = owner.captureNativeBacking();
        await vi.waitFor(() => expect(captureNativeBacking).toHaveBeenCalledOnce());
        if (change === "output")
          request.onEvent({ type: "delta", data: new TextEncoder().encode("X") });
        if (change === "layout") request.onLayout?.(layout(5, 1));
        if (change === "disposal") await owner.dispose();
        release({
          status: "captured",
          isCurrent: () => rawCurrent,
          snapshot: {
            cols: change === "dimensions" ? 3 : 4,
            rows: 1,
            history: 0,
            hscrolled: 0,
            limit: 2000,
            cursor: [0, 0],
            grid: [
              {
                flags: 0,
                cells: [...(change === "content" ? "WRNG" : "BOOT")].map((text) => ({
                  flags: 0,
                  width: 1,
                  bytesHex: Buffer.from(text).toString("hex"),
                  text,
                  attributes: 0,
                  foreground: 8,
                  background: 8,
                  underline: 8,
                  link: 0,
                  storageFlags: 0,
                })),
              },
            ],
          },
        });
        const result = await pending;
        if (change === "stable") {
          expect(result.status).toBe("captured");
          if (result.status !== "captured") throw new Error("Missing qualified backing");
          expect(result.authority).toEqual({
            generation,
            workspaceName: "workspace",
            semanticPaneId: "pane-a",
            incarnation: before.incarnation,
            revision: before.revision,
            stateHash: before.stateHash,
          });
          expect(result.isCurrent()).toBe(true);
          rawCurrent = false;
          expect(result.isCurrent()).toBe(false);
        } else
          expect(result.status).toBe(
            change === "content" || change === "dimensions" ? "mismatch" : "changed",
          );
      } finally {
        await owner.dispose();
      }
    },
  );

  it.each([false, true])(
    "reports native recovery faults to the lifecycle owner (bootstrapped: %s)",
    async (bootstrapped) => {
      let request!: MirrorSubscribeRequest;
      const onFault = vi.fn();
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
          request = candidate;
          queueMicrotask(() => {
            candidate.onLayout?.(layout(4, 1));
            if (bootstrapped) {
              candidate.onEvent({ type: "reset", cols: 4, rows: 1 });
              candidate.onEvent({ type: "seed", data: new TextEncoder().encode("BOOT") });
              candidate.onEvent({ type: "cursor", x: 0, y: 0 });
            } else candidate.onEvent({ type: "fault", reason: "native-recovery-failed" });
          });
          return subscription(candidate);
        },
      };
      const owner = new SessionRuntimeTerminalReplicaOwner(
        generation,
        "workspace",
        "pane-a",
        mirror as never,
        { incarnation: `${generation}:0`, initialRevision: 0, onFault },
      );
      try {
        const opening = owner.subscribe(() => undefined);
        if (bootstrapped) {
          await opening;
          request.onEvent({ type: "fault", reason: "native-recovery-failed" });
        } else await expect(opening).rejects.toThrow("Native terminal recovery failed");
        expect(onFault).toHaveBeenCalledOnce();
        expect(onFault.mock.calls[0]![0]).toBeInstanceOf(Error);
      } finally {
        await owner.dispose();
      }
    },
  );

  it("shares history checks and ignores counts overtaken by output or disposal", async () => {
    let request!: MirrorSubscribeRequest;
    const replies: Array<(size: number | null) => void> = [];
    const readHistorySize = vi.fn(
      () => new Promise<number | null>((resolve) => replies.push(resolve)),
    );
    const reseed = vi.fn();
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.(layout(4, 1));
          candidate.onEvent({ type: "reset", cols: 4, rows: 1 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("BOOT") });
          candidate.onEvent({ type: "cursor", x: 0, y: 0 });
        });
        return { ...subscription(candidate), readHistorySize, reseed };
      },
    };
    const owner = new SessionRuntimeTerminalReplicaOwner(
      generation,
      "workspace",
      "pane-a",
      mirror as never,
      { incarnation: `${generation}:0`, initialRevision: 0 },
    );
    try {
      await owner.subscribe(() => undefined);
      await owner.subscribe(() => undefined);
      const output = () => request.onEvent({ type: "delta", data: new TextEncoder().encode("x") });
      output();
      output();
      await vi.waitFor(() => expect(readHistorySize).toHaveBeenCalledTimes(1));
      output();
      replies.shift()!(999);
      await vi.waitFor(() => expect(readHistorySize).toHaveBeenCalledTimes(2));
      expect(reseed).not.toHaveBeenCalled();
      replies.shift()!(999);
      await vi.waitFor(() => expect(reseed).toHaveBeenCalledTimes(1));
      output();
      await vi.waitFor(() => expect(readHistorySize).toHaveBeenCalledTimes(3));
      await owner.dispose();
      replies.shift()!(999);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(reseed).toHaveBeenCalledTimes(1);
      expect(readHistorySize).toHaveBeenCalledTimes(3);
    } finally {
      await owner.dispose();
    }
  });

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
    expect(firstUpdates[0]).toMatchObject({ cols: 12, rows: 2 });
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

  it("atomically projects a native top-border capture into canonical native content geometry", async () => {
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
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 12, rows: 2 });
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
    "publishes exactly one %s-border seed at the native content geometry",
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
        rows: nativeRows,
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

  it.each([
    ["right-margin wrap pending", 8, 8],
    ["cursor retained after a non-reflow width shrink", 106, 118],
  ] as const)(
    "normalizes tmux %s into the final canonical column",
    async (_label, cols, cursorX) => {
      const updates: CanonicalTerminalReplicaUpdate[] = [];
      const mirror = {
        subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
          queueMicrotask(() => {
            candidate.onLayout?.(layout(cols, 4, "top"));
            candidate.onEvent({ type: "reset", cols, rows: 3 });
            candidate.onEvent({ type: "seed", data: new TextEncoder().encode("wrapped!") });
            candidate.onEvent({ type: "cursor", x: cursorX, y: 0 });
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
        snapshot: { cursor: { x: cols - 1, y: 0 } },
      });
      await owner.dispose();
    },
  );

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
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 4 });
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
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 3 });
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

  it("recaptures quiet native rows after a width shrink instead of reflowing the painted seed", async () => {
    let request: MirrorSubscribeRequest | undefined;
    let reseeds = 0;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest) => {
        request = candidate;
        const emit = (cols: number) => {
          candidate.onEvent({ type: "reset", cols, rows: 3 });
          candidate.onEvent({
            type: "seed",
            data: new TextEncoder().encode(
              ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"].map((row) => row.slice(0, cols)).join("\r\n"),
            ),
          });
          candidate.onEvent({ type: "cursor", x: 0, y: 0 });
        };
        queueMicrotask(() => {
          candidate.onLayout?.(layout(8, 4, "top"));
          emit(8);
        });
        return {
          ...subscription(candidate),
          reseed: () => {
            reseeds++;
            emit(4);
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
    try {
      await owner.subscribe((update) => updates.push(update));
      request!.onLayout?.(layout(4, 4, "top"));
      await vi.waitFor(() => expect(reseeds).toBe(1));
      await vi.waitFor(() => expect(updates.at(-1)?.type).toBe("terminal.seed"));
      const seed = updates.at(-1)!;
      expect(
        seed.type === "terminal.seed" &&
          seed.snapshot.grid
            .slice(0, 3)
            .map((row) => row.cells.map((cell) => cell.grapheme).join("")),
      ).toEqual(["AAAA", "BBBB", "CCCC"]);
      expect(updates.map((update) => update.type)).toEqual(["terminal.seed", "terminal.seed"]);
    } finally {
      await owner.dispose();
    }
  });

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
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates.map((update) => [update.type, update.cols, update.rows])).toEqual([
      ["terminal.seed", 8, 3],
      ["terminal.seed", 10, 4],
    ]);
    await owner.dispose();
  });

  it("suppresses identical layout leases and recaptures only a true later geometry change", async () => {
    let request: MirrorSubscribeRequest | undefined;
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    let reseeds = 0;
    const mirror = {
      subscribe: async (candidate: MirrorSubscribeRequest): Promise<MirrorSubscription> => {
        request = candidate;
        queueMicrotask(() => {
          candidate.onLayout?.(layout(8, 4, "top"));
          candidate.onEvent({ type: "reset", cols: 8, rows: 3 });
          candidate.onEvent({ type: "seed", data: new TextEncoder().encode("stable") });
          candidate.onEvent({ type: "cursor", x: 1, y: 0 });
        });
        return {
          ...subscription(candidate),
          reseed: () => {
            reseeds++;
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
    request!.onLayout?.(layout(8, 4, "top"));
    await Promise.resolve();
    expect(updates.map((update) => update.type)).toEqual(["terminal.seed"]);
    expect(reseeds).toBe(0);
    request!.onLayout?.(layout(9, 4, "top"));
    request!.onLayout?.(layout(10, 4, "top"));
    await vi.waitFor(() => expect(reseeds).toBe(1));
    expect(updates).toHaveLength(1);
    request!.onEvent({ type: "reset", cols: 10, rows: 3 });
    request!.onEvent({ type: "seed", data: new TextEncoder().encode("native") });
    request!.onEvent({ type: "cursor", x: 1, y: 0 });
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(updates[1]).toMatchObject({ type: "terminal.seed", cols: 10, rows: 3 });
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
    expect(updates[0]).toMatchObject({ type: "terminal.seed", cols: 8, rows: 3 });
    await owner.dispose();
  });

  it.each([
    ["column mismatch", layout(9, 4, "top"), { cols: 8, rows: 3, x: 1, y: 0 }],
    ["off-row mismatch", layout(8, 4, "off"), { cols: 8, rows: 3, x: 1, y: 0 }],
    ["negative cursor", layout(8, 4, "top"), { cols: 8, rows: 3, x: -1, y: 0 }],
    ["non-integer cursor", layout(8, 4, "top"), { cols: 8, rows: 3, x: 1.5, y: 0 }],
    ["cursor row overflow", layout(8, 4, "top"), { cols: 8, rows: 3, x: 1, y: 3 }],
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
