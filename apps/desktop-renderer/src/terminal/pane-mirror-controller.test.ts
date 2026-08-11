import { describe, expect, it, vi } from "vitest";

import { PaneMirrorController, type MirrorPaneSink } from "./pane-mirror-controller.ts";
import type {
  PaneMirrorSeedBatch,
  PaneStreamConnectResult,
  PaneStreamLayoutEvent,
  PaneStreamRequest,
  PaneStreamSessionListeners,
  PaneStreamTransport,
} from "./pane-stream-transport.ts";

const PANE_A = "pane.workspace.a1";
const PANE_B = "pane.workspace.b2";

function seedBatch(text: string): PaneMirrorSeedBatch {
  return {
    reset: { cols: 80, rows: 24 },
    seed: new TextEncoder().encode(text),
    held: [],
    cursor: { x: 0, y: 0 },
  };
}

interface Scheduled {
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class Clock {
  #now = 5_000_000;
  readonly #scheduled: Scheduled[] = [];

  now = (): number => this.#now;

  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const entry: Scheduled = { at: this.#now + delayMs, callback, cancelled: false };
    this.#scheduled.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  async advance(byMs: number): Promise<void> {
    const target = this.#now + byMs;
    while (true) {
      const due = this.#scheduled
        .filter((entry) => !entry.cancelled && entry.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.#scheduled.splice(this.#scheduled.indexOf(due), 1);
      this.#now = due.at;
      due.callback();
      await flush();
    }
    this.#now = target;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface FakeSessionHandle {
  readonly request: PaneStreamRequest;
  readonly listeners: PaneStreamSessionListeners;
  readonly dispose: ReturnType<typeof vi.fn>;
}

class FakeTransport implements PaneStreamTransport {
  readonly sessions: FakeSessionHandle[] = [];
  failNextWith: PaneStreamConnectResult | null = null;
  failAllWith: PaneStreamConnectResult | null = null;

  connect(
    request: PaneStreamRequest,
    listeners: PaneStreamSessionListeners,
  ): Promise<PaneStreamConnectResult> {
    if (this.failAllWith) return Promise.resolve(this.failAllWith);
    if (this.failNextWith) {
      const failure = this.failNextWith;
      this.failNextWith = null;
      return Promise.resolve(failure);
    }
    const dispose = vi.fn();
    this.sessions.push({ request, listeners, dispose });
    return Promise.resolve({ status: "connected", session: { dispose } });
  }

  latest(): FakeSessionHandle {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("no session connected");
    return session;
  }
}

function recordingSink(): MirrorPaneSink & {
  readonly seeds: PaneMirrorSeedBatch[];
  readonly outputs: string[];
  readonly cursors: { x: number; y: number }[];
  readonly geometries: { cols: number; rows: number }[];
  readonly calls: string[];
} {
  const seeds: PaneMirrorSeedBatch[] = [];
  const outputs: string[] = [];
  const cursors: { x: number; y: number }[] = [];
  const geometries: { cols: number; rows: number }[] = [];
  const calls: string[] = [];
  return {
    seeds,
    outputs,
    cursors,
    geometries,
    calls,
    applySeedBatch: (batch) => {
      seeds.push(batch);
      calls.push("seed");
    },
    applyGeometry: (cols, rows) => {
      geometries.push({ cols, rows });
      calls.push(`geometry:${cols}x${rows}`);
    },
    applyOutput: (bytes) => {
      outputs.push(new TextDecoder().decode(bytes));
      calls.push("output");
    },
    applyCursor: (x, y) => {
      cursors.push({ x, y });
      calls.push("cursor");
    },
  };
}

function layout(cols = 160, rows = 40): PaneStreamLayoutEvent {
  return {
    semanticWindowId: "window-a",
    windowName: "main",
    currentWindow: true,
    cols,
    rows,
    zoomed: false,
    paneBorderStatus: "top",
    panes: [
      { pane: PANE_A, left: 0, top: 0, width: 100, height: rows, active: true },
      { pane: PANE_B, left: 101, top: 0, width: cols - 101, height: rows, active: false },
    ],
  };
}

function controllerHarness(panes: readonly string[] = [PANE_A, PANE_B]) {
  const clock = new Clock();
  const transport = new FakeTransport();
  const states: string[] = [];
  const controller = new PaneMirrorController({
    transport,
    workspaceName: "workspace-a",
    panes,
    now: clock.now,
    schedule: clock.schedule,
    onStateChanged: (state) => states.push(state.transport.phase),
  });
  return { clock, transport, controller, states };
}

describe("pane mirror controller lifecycle", () => {
  it("connects once and reports the connected transport phase", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    expect(h.transport.sessions).toHaveLength(1);
    expect(h.transport.latest().request).toEqual({
      workspaceName: "workspace-a",
      panes: [PANE_A, PANE_B],
    });
    expect(h.controller.state().transport).toEqual({ phase: "connected" });
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "connecting" });
  });

  it("marks a pane live on its first seed and ended on closed", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    await session.listeners.onPaneEvent(PANE_A, { type: "seed-batch", batch: seedBatch("s") });
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "live", flowPaused: false });
    session.listeners.onPaneEvent(PANE_A, { type: "closed" });
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "ended" });
  });

  it("tracks the flow-paused indicator per pane", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    await session.listeners.onPaneEvent(PANE_A, { type: "seed-batch", batch: seedBatch("s") });
    session.listeners.onPaneEvent(PANE_A, {
      type: "flow",
      state: "paused",
      reason: "backpressure",
    });
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "live", flowPaused: true });
    session.listeners.onPaneEvent(PANE_A, {
      type: "flow",
      state: "resumed",
      reason: "backpressure",
    });
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "live", flowPaused: false });
  });

  it("fans events out to the registered sink and returns its apply promise", async () => {
    const h = controllerHarness();
    const sink = recordingSink();
    h.controller.registerPaneSink(PANE_A, sink);
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    await session.listeners.onPaneEvent(PANE_A, { type: "seed-batch", batch: seedBatch("seed") });
    await session.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("delta"),
    });
    session.listeners.onPaneEvent(PANE_A, { type: "cursor", x: 2, y: 3 });
    await flush();
    expect(sink.seeds).toHaveLength(1);
    expect(sink.outputs).toEqual(["delta"]);
    expect(sink.cursors).toEqual([{ x: 2, y: 3 }]);
  });

  it("applies authoritative layout geometry before output at the new size", async () => {
    const h = controllerHarness();
    const sink = recordingSink();
    h.controller.registerPaneSink(PANE_A, sink);
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    session.listeners.onLayout?.(layout());
    await session.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("after-resize"),
    });
    await flush();
    expect(sink.geometries).toEqual([{ cols: 100, rows: 40 }]);
    expect(sink.calls).toEqual(["geometry:100x40", "output"]);
  });

  it("buffers layout geometry for a pane whose renderer has not mounted yet", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    h.transport.latest().listeners.onLayout?.(layout(180, 50));
    const sink = recordingSink();
    h.controller.registerPaneSink(PANE_A, sink);
    await flush();
    expect(sink.geometries).toEqual([{ cols: 100, rows: 50 }]);
  });

  it("buffers events until the sink registers and replays them in order", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    await session.listeners.onPaneEvent(PANE_A, { type: "seed-batch", batch: seedBatch("seed") });
    await session.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("early"),
    });
    const sink = recordingSink();
    h.controller.registerPaneSink(PANE_A, sink);
    await flush();
    expect(sink.seeds).toHaveLength(1);
    expect(sink.outputs).toEqual([]);
    expect(sink.seeds[0]!.held.map((bytes) => new TextDecoder().decode(bytes))).toEqual(["early"]);
    // A live event after registration lands after the replayed backlog.
    await session.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("late"),
    });
    await flush();
    expect(sink.outputs).toEqual(["late"]);
  });

  it("replays one retained canonical batch when a painted pane renderer remounts", async () => {
    const h = controllerHarness([PANE_A]);
    const firstSink = recordingSink();
    const unregister = h.controller.registerPaneSink(PANE_A, firstSink);
    h.controller.start();
    await flush();
    const first = h.transport.latest();
    await first.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("first"),
    });
    await flush();
    expect(firstSink.seeds).toHaveLength(1);

    unregister();
    const replacementSink = recordingSink();
    h.controller.registerPaneSink(PANE_A, replacementSink);
    await flush();

    expect(first.dispose).not.toHaveBeenCalled();
    expect(h.transport.sessions).toHaveLength(1);
    expect(replacementSink.seeds.map((batch) => new TextDecoder().decode(batch.seed))).toEqual([
      "first",
    ]);
  });

  it("never applies an old sink's queued delta to its replacement before replay", async () => {
    const h = controllerHarness([PANE_A]);
    const blocked = deferred<void>();
    const first = recordingSink();
    first.applyOutput = vi.fn(() => blocked.promise);
    const unregister = h.controller.registerPaneSink(PANE_A, first);
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    await session.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("base"),
    });
    const pending = session.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("queued"),
    });
    unregister();
    const replacement = recordingSink();
    h.controller.registerPaneSink(PANE_A, replacement);
    blocked.resolve(undefined);
    await pending;
    await flush();
    expect(replacement.calls).toEqual(["seed"]);
    expect(replacement.seeds[0]!.held.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
      "queued",
    ]);
  });

  it("supervises a retryable end with bounded backoff and reseeds on reconnect", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const first = h.transport.latest();
    first.listeners.onEnd({ code: "stream-closed", reason: "socket dropped", retryable: true });
    const reconnecting = h.controller.state().transport;
    expect(reconnecting).toMatchObject({
      phase: "reconnecting",
      attempt: 1,
      maximumAttempts: 4,
      error: { code: "event-unavailable", reason: "socket dropped" },
    });
    await h.clock.advance(250);
    await flush();
    expect(h.transport.sessions).toHaveLength(2);
    expect(h.controller.state().transport).toEqual({ phase: "connected" });
    // The reconnected lease reseeds; pane states honestly read connecting again.
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "connecting" });
  });

  it("stops at the bounded attempt ceiling and restarts on explicit retry", async () => {
    const h = controllerHarness();
    const failure = {
      status: "error",
      error: { code: "attachment-unavailable", reason: "daemon busy", retryable: true },
    } as const;
    h.transport.failAllWith = failure;
    h.controller.start();
    await flush();
    expect(h.controller.state().transport).toMatchObject({
      phase: "reconnecting",
      attempt: 1,
      maximumAttempts: 4,
    });
    // Every scheduled attempt fails too: the budget must exhaust at 4.
    await h.clock.advance(30_000);
    await flush();
    expect(h.controller.state().transport).toMatchObject({
      phase: "stopped",
      error: { code: "event-unavailable", reason: "daemon busy" },
    });
    h.transport.failAllWith = null;
    h.controller.retry();
    await flush();
    expect(h.controller.state().transport).toEqual({ phase: "connected" });
  });

  it("stops immediately on a non-retryable end", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    h.transport.latest().listeners.onEnd({
      code: "protocol-error",
      reason: "protocol violated",
      retryable: false,
    });
    expect(h.controller.state().transport).toMatchObject({
      phase: "stopped",
      error: { code: "event-unavailable", reason: "protocol violated" },
    });
  });

  it("keeps the fault's own code, which the transport state cannot carry", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    h.transport.latest().listeners.onEnd({
      code: "interactive-viewer-conflict",
      reason: "A requested pane already has an interactive viewer.",
      retryable: false,
    });
    const state = h.controller.state();
    // The transport state is typed in the capability vocabulary and narrows...
    expect(state.transport).toMatchObject({
      phase: "stopped",
      error: { code: "event-unavailable" },
    });
    // ...so the issue-vocabulary code rides alongside it instead of dying here.
    expect(state.fault).toMatchObject({
      code: "interactive-viewer-conflict",
      reason: "A requested pane already has an interactive viewer.",
    });

    h.transport.failAllWith = null;
    h.controller.retry();
    await flush();
    expect(h.controller.state().fault).toBeNull();
  });

  it("reads a clean end (every pane closed) as idle, not a fault", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    session.listeners.onPaneEvent(PANE_A, { type: "closed" });
    session.listeners.onEnd(null);
    expect(h.controller.state().transport).toEqual({ phase: "idle" });
    expect(h.controller.state().panes.get(PANE_A)).toEqual({ kind: "ended" });
  });

  it("keeps the active lease until the changed pane set has layouts and seeds", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const first = h.transport.latest();
    first.listeners.onLayout?.(layout(100, 30));
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(h.controller.state().layouts[0]?.rows).toBe(30);
    expect(h.transport.sessions).toHaveLength(2);
    const candidate = h.transport.latest();
    expect(candidate.request.panes).toEqual([PANE_A, PANE_B]);
    candidate.listeners.onLayout?.(layout(180, 50));
    await candidate.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("a"),
    });
    expect(first.dispose).not.toHaveBeenCalled();
    await candidate.listeners.onPaneEvent(PANE_B, {
      type: "seed-batch",
      batch: seedBatch("b"),
    });
    await flush();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(h.controller.state().layouts[0]?.rows).toBe(50);
    expect(h.controller.state().panes.get(PANE_B)).toEqual({ kind: "live", flowPaused: false });
    await h.clock.advance(5_000);
    expect(candidate.dispose).not.toHaveBeenCalled();
  });

  it("treats a pane closed before its first layout as candidate-ready", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const candidate = h.transport.latest();
    candidate.listeners.onLayout?.({
      ...layout(),
      panes: [{ pane: PANE_A, left: 0, top: 0, width: 160, height: 40, active: true }],
    });
    await candidate.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("a"),
    });
    candidate.listeners.onPaneEvent(PANE_B, { type: "closed" });
    await flush();
    expect(active.dispose).toHaveBeenCalledOnce();
    expect(h.controller.state().panes.get(PANE_B)).toEqual({ kind: "ended" });
  });

  it("retires an incomplete candidate at its bounded readiness deadline", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const candidate = h.transport.latest();
    await h.clock.advance(5_000);
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(active.dispose).not.toHaveBeenCalled();
    expect(h.controller.state().fault?.code).toBe("candidate-ready-timeout");
  });

  it("never lets a stale pane-set candidate commit over the newest request", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    h.controller.setPanes([PANE_B]);
    await flush();
    const stale = h.transport.sessions[1]!;
    const newest = h.transport.sessions[2]!;
    expect(stale.dispose).toHaveBeenCalledOnce();
    stale.listeners.onLayout?.(layout(170, 41));
    await stale.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("stale"),
    });
    expect(active.dispose).not.toHaveBeenCalled();
    newest.listeners.onLayout?.({
      ...layout(190, 55),
      panes: [{ pane: PANE_B, left: 0, top: 0, width: 190, height: 55, active: true }],
    });
    await newest.listeners.onPaneEvent(PANE_B, {
      type: "seed-batch",
      batch: seedBatch("newest"),
    });
    await flush();
    expect(active.dispose).toHaveBeenCalledOnce();
    expect(h.controller.state().panes.has(PANE_A)).toBe(false);
    expect(h.controller.state().panes.get(PANE_B)).toEqual({ kind: "live", flowPaused: false });
  });

  it("retires a connected candidate that is superseded before its first complete paint", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const waiting = h.transport.latest();
    expect(waiting.dispose).not.toHaveBeenCalled();
    h.controller.setPanes([PANE_B]);
    expect(waiting.dispose).toHaveBeenCalledOnce();
  });

  it("retires a connected candidate when the controller is disposed", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const waiting = h.transport.latest();
    h.controller.dispose();
    expect(active.dispose).toHaveBeenCalledOnce();
    expect(waiting.dispose).toHaveBeenCalledOnce();
    await h.clock.advance(5_000);
    expect(waiting.dispose).toHaveBeenCalledOnce();
  });

  it("lets a ready candidate take over when the active lease ends during handoff", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const candidate = h.transport.latest();
    active.listeners.onEnd({ code: "stream-closed", reason: "old ended", retryable: true });
    expect(h.controller.state().transport.phase).toBe("connecting");
    candidate.listeners.onLayout?.(layout());
    await candidate.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("a"),
    });
    await candidate.listeners.onPaneEvent(PANE_B, {
      type: "seed-batch",
      batch: seedBatch("b"),
    });
    await flush();
    expect(h.controller.state().transport.phase).toBe("connected");
    await h.clock.advance(5_000);
    expect(h.transport.sessions).toHaveLength(2);
    // A late close callback from the retired active generation is inert.
    active.listeners.onEnd({ code: "stream-closed", reason: "late", retryable: true });
    expect(h.controller.state().transport.phase).toBe("connected");
  });

  it("explicit retry fences and retires an in-flight connected candidate", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const candidate = h.transport.latest();
    h.controller.retry();
    await flush();
    expect(active.dispose).toHaveBeenCalledOnce();
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(h.transport.sessions).toHaveLength(3);
    expect(h.controller.state().transport.phase).toBe("connected");
  });

  it("prunes retained replay for panes removed by a committed candidate", async () => {
    const h = controllerHarness([PANE_A]);
    const firstSink = recordingSink();
    h.controller.registerPaneSink(PANE_A, firstSink);
    h.controller.start();
    await flush();
    await h.transport.latest().listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("removed"),
    });
    h.controller.setPanes([PANE_B]);
    await flush();
    const candidate = h.transport.latest();
    candidate.listeners.onLayout?.({
      ...layout(),
      panes: [{ pane: PANE_B, left: 0, top: 0, width: 160, height: 40, active: true }],
    });
    await candidate.listeners.onPaneEvent(PANE_B, {
      type: "seed-batch",
      batch: seedBatch("kept"),
    });
    await flush();
    const removedSink = recordingSink();
    h.controller.registerPaneSink(PANE_A, removedSink);
    await flush();
    expect(removedSink.seeds).toEqual([]);
  });

  it("bounds a noisy candidate while a sibling never becomes seed-ready", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const active = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    const candidate = h.transport.latest();
    for (let index = 0; index < 1_025; index += 1) {
      candidate.listeners.onPaneEvent(PANE_A, {
        type: "output",
        bytes: new Uint8Array([index % 255]),
      });
    }
    expect(candidate.dispose).toHaveBeenCalledOnce();
    expect(active.dispose).not.toHaveBeenCalled();
    expect(h.controller.state().fault?.code).toBe("candidate-staging-overflow");
  });

  it("discards stale buffered bytes across a reconnect", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const first = h.transport.latest();
    await first.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("stale"),
    });
    first.listeners.onEnd({ code: "stream-closed", reason: "socket dropped", retryable: true });
    await h.clock.advance(250);
    await flush();
    const second = h.transport.latest();
    await second.listeners.onPaneEvent(PANE_A, {
      type: "seed-batch",
      batch: seedBatch("fresh"),
    });
    const sink = recordingSink();
    h.controller.registerPaneSink(PANE_A, sink);
    await flush();
    expect(sink.outputs).toEqual([]);
    expect(sink.seeds).toHaveLength(1);
  });

  it("dispose retires the live session and ignores later events", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const session = h.transport.latest();
    h.controller.dispose();
    expect(session.dispose).toHaveBeenCalled();
    session.listeners.onEnd({ code: "stream-closed", reason: "late", retryable: true });
    expect(h.controller.state().transport).toEqual({ phase: "connected" });
    expect(h.transport.sessions).toHaveLength(1);
  });
});

describe("layout frames", () => {
  const layout = (
    overrides: Partial<PaneStreamLayoutEvent> & { semanticWindowId: string | null },
  ): PaneStreamLayoutEvent => ({
    windowName: "editor",
    currentWindow: false,
    cols: 200,
    rows: 50,
    zoomed: false,
    paneBorderStatus: "off",
    panes: [{ pane: PANE_A, left: 0, top: 0, width: 200, height: 50, active: true }],
    ...overrides,
  });

  it("keeps one entry per window, in first-seen order, replaced in place", async () => {
    // Bug this catches: each frame appends, so a tab strip built from these
    // grows a new tab every time tmux repaints a layout.
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const { onLayout } = h.transport.sessions[0]!.listeners;
    onLayout!(layout({ semanticWindowId: "win.one" }));
    onLayout!(layout({ semanticWindowId: "win.two", windowName: "shell" }));
    onLayout!(layout({ semanticWindowId: "win.one", windowName: "renamed" }));
    expect(h.controller.state().layouts.map((frame) => frame.windowName)).toEqual([
      "renamed",
      "shell",
    ]);
  });

  it("lets exactly one window claim to be the current one", async () => {
    // Bug this catches: the previous window's stale `currentWindow: true` frame
    // survives, so two tabs are painted as the one the user is in.
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const { onLayout } = h.transport.sessions[0]!.listeners;
    onLayout!(layout({ semanticWindowId: "win.one", currentWindow: true }));
    onLayout!(layout({ semanticWindowId: "win.two", currentWindow: true }));
    expect(h.controller.state().layouts.map((frame) => frame.currentWindow)).toEqual([false, true]);
  });

  it("keeps the known windows across a reconnect", async () => {
    /*
     * Bug this catches: a recoverable stream drop blanks the tab strip, so the
     * session momentarily reads as having lost every window it has.
     */
    const h = controllerHarness();
    h.controller.start();
    await flush();
    h.transport.sessions[0]!.listeners.onLayout!(layout({ semanticWindowId: "win.one" }));
    h.transport.sessions[0]!.listeners.onEnd({
      code: "stream-closed",
      reason: "dropped",
      retryable: true,
    });
    await h.clock.advance(1_000);
    expect(h.controller.state().layouts).toHaveLength(1);
  });

  it("keys an unstamped window by its pane set rather than appending forever", async () => {
    const h = controllerHarness();
    h.controller.start();
    await flush();
    const { onLayout } = h.transport.sessions[0]!.listeners;
    onLayout!(layout({ semanticWindowId: null }));
    onLayout!(layout({ semanticWindowId: null, windowName: "later" }));
    expect(h.controller.state().layouts).toHaveLength(1);
    expect(h.controller.state().layouts[0]!.windowName).toBe("later");
  });
});
