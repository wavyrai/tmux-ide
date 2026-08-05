import { describe, expect, it, vi } from "vitest";

import { PaneMirrorController, type MirrorPaneSink } from "./pane-mirror-controller.ts";
import type {
  PaneMirrorSeedBatch,
  PaneStreamConnectResult,
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
} {
  const seeds: PaneMirrorSeedBatch[] = [];
  const outputs: string[] = [];
  const cursors: { x: number; y: number }[] = [];
  return {
    seeds,
    outputs,
    cursors,
    applySeedBatch: (batch) => {
      seeds.push(batch);
    },
    applyOutput: (bytes) => {
      outputs.push(new TextDecoder().decode(bytes));
    },
    applyCursor: (x, y) => {
      cursors.push({ x, y });
    },
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
    expect(sink.outputs).toEqual(["early"]);
    // A live event after registration lands after the replayed backlog.
    await session.listeners.onPaneEvent(PANE_A, {
      type: "output",
      bytes: new TextEncoder().encode("late"),
    });
    await flush();
    expect(sink.outputs).toEqual(["early", "late"]);
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

  it("re-issues a new lease when the pane set changes", async () => {
    const h = controllerHarness([PANE_A]);
    h.controller.start();
    await flush();
    const first = h.transport.latest();
    h.controller.setPanes([PANE_A, PANE_B]);
    await flush();
    expect(first.dispose).toHaveBeenCalled();
    expect(h.transport.sessions).toHaveLength(2);
    expect(h.transport.latest().request.panes).toEqual([PANE_A, PANE_B]);
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
