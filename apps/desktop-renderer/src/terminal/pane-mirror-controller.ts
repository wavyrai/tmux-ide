import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

import type {
  PaneMirrorEvent,
  PaneMirrorSeedBatch,
  PaneStreamLayoutEvent,
  PaneStreamSessionHandle,
  PaneStreamTransport,
  PaneStreamTransportError,
} from "./pane-stream-transport.ts";

/**
 * Renderer-side lifecycle owner for ONE pane-stream lease (m43 card 3).
 *
 * It owns exactly three things:
 *  - the session lifecycle: connect, bounded supervised reconnect on a
 *    retryable end (the m42 transport-state machine shape, so the existing
 *    connection-health derivation renders the retry position honestly), and a
 *    fatal stop on a non-retryable one;
 *  - per-pane node states (connecting → live → ended), including the
 *    flow-paused indicator;
 *  - fan-out of decoded mirror events to registered pane sinks. The sink's
 *    settled promise is what releases the cumulative `consumed` ack upstream;
 *  - the session's LAYOUT frames, one per window, kept in first-seen order.
 *    They are the geometry the tiled view is a pure function of (m50), and they
 *    arrive on the lease whether or not any pane is being mirrored — which is
 *    why a view that only wants geometry can hold a one-pane lease.
 *
 * Changing the pane set means a NEW lease (the set is enumerated at issue), so
 * `setPanes` retires the current session and reconnects.
 */

export interface MirrorPaneSink {
  /** ONE atomic paint: reset, one capture, held deltas, cursor — never spliced. */
  applySeedBatch(batch: PaneMirrorSeedBatch): void | Promise<void>;
  /**
   * Apply tmux's ordered pane geometry before any output produced at that
   * geometry. Layout frames share the pane-stream socket with output, so this
   * is the compositor's resize authority rather than a DOM measurement.
   */
  applyGeometry(cols: number, rows: number): void;
  applyOutput(bytes: Uint8Array): void | Promise<void>;
  applyCursor(x: number, y: number): void;
}

export type MirrorPaneNodeState =
  | { readonly kind: "connecting" }
  | { readonly kind: "live"; readonly flowPaused: boolean }
  | { readonly kind: "ended" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface PaneMirrorControllerState {
  readonly transport: DesktopDaemonTransportState;
  readonly panes: ReadonlyMap<string, MirrorPaneNodeState>;
  /**
   * The session's windows as tmux last reported them, in first-seen order so a
   * tab strip built from them does not reshuffle on every frame. A window is
   * replaced in place by its newer frame. Nothing here removes a window: the
   * wire carries no "window closed" frame, so a surface prunes against the
   * attachable inventory the daemon already keeps honest rather than against a
   * timeout this controller would have to invent.
   */
  readonly layouts: readonly PaneStreamLayoutEvent[];
  /**
   * The last stream fault with its ORIGINAL code. `transport.error` must be a
   * daemon-capability error (that is the vocabulary `DesktopDaemonTransportState`
   * is typed in), so the code that explains WHY — `interactive-viewer-conflict`,
   * `daemon-degraded`, `pane-not-found` — used to die at that boundary. It is
   * carried here instead, and the surface labels it.
   */
  readonly fault: PaneStreamTransportError | null;
}

export interface PaneMirrorControllerDependencies {
  readonly transport: PaneStreamTransport;
  readonly workspaceName: string;
  readonly panes: readonly string[];
  readonly onStateChanged?: (state: PaneMirrorControllerState) => void;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaximumDelayMs?: number;
  readonly reconnectMaximumAttempts?: number;
}

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 250;
const DEFAULT_RECONNECT_MAXIMUM_DELAY_MS = 4_000;
const DEFAULT_RECONNECT_MAXIMUM_ATTEMPTS = 4;
/**
 * Events that arrive before the pane's node registers its sink are buffered
 * and replayed in order on registration (the mount/connect race). There is no
 * reseed-request verb on the wire, so an overflow cannot be healed in place —
 * the session reconnects for a fresh seed instead of splicing a gap.
 */
const MAX_BUFFERED_EVENTS_PER_PANE = 1_024;

type MirrorSinkEvent =
  | PaneMirrorEvent
  | { readonly type: "geometry"; readonly cols: number; readonly rows: number };

interface SinkChannel {
  sink: MirrorPaneSink | null;
  readonly buffer: MirrorSinkEvent[];
  /** True once this lease's atomic seed has reached (or passed) the channel. */
  seedSeen: boolean;
  /** Serializes buffered replay and live events so paint order is wire order. */
  tail: Promise<void>;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function boundedReason(reason: string): string {
  const trimmed = reason.trim().slice(0, 240);
  return trimmed.length > 0 ? trimmed : "The pane stream is unavailable.";
}

/**
 * The stream fault as the daemon-capability vocabulary the transport state is
 * typed in. The reason survives verbatim; the original code survives too, on
 * `PaneMirrorControllerState.fault`, so no honesty is lost at this narrowing.
 */
function transportFault(error: PaneStreamTransportError): {
  readonly code: "event-unavailable";
  readonly reason: string;
} {
  return { code: "event-unavailable", reason: boundedReason(error.reason) };
}

export class PaneMirrorController {
  readonly #transport: PaneStreamTransport;
  readonly #workspaceName: string;
  readonly #onStateChanged: ((state: PaneMirrorControllerState) => void) | undefined;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #reconnectInitialDelayMs: number;
  readonly #reconnectMaximumDelayMs: number;
  readonly #reconnectMaximumAttempts: number;
  readonly #channels = new Map<string, SinkChannel>();
  #panes: readonly string[];
  #paneStates = new Map<string, MirrorPaneNodeState>();
  #layouts: PaneStreamLayoutEvent[] = [];
  #transportState: DesktopDaemonTransportState = { phase: "idle" };
  #fault: PaneStreamTransportError | null = null;
  #session: PaneStreamSessionHandle | null = null;
  #cancelRetry: (() => void) | null = null;
  #attempt = 0;
  #generation = 0;
  #disposed = false;
  #freshSeedScheduled = false;

  constructor(dependencies: PaneMirrorControllerDependencies) {
    this.#transport = dependencies.transport;
    this.#workspaceName = dependencies.workspaceName;
    this.#onStateChanged = dependencies.onStateChanged;
    this.#now = dependencies.now ?? Date.now;
    this.#schedule = dependencies.schedule ?? defaultSchedule;
    this.#reconnectInitialDelayMs =
      dependencies.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    this.#reconnectMaximumDelayMs =
      dependencies.reconnectMaximumDelayMs ?? DEFAULT_RECONNECT_MAXIMUM_DELAY_MS;
    this.#reconnectMaximumAttempts =
      dependencies.reconnectMaximumAttempts ?? DEFAULT_RECONNECT_MAXIMUM_ATTEMPTS;
    this.#panes = [...dependencies.panes];
    for (const pane of this.#panes) {
      this.#paneStates.set(pane, { kind: "connecting" });
    }
  }

  state(): PaneMirrorControllerState {
    return {
      transport: this.#transportState,
      panes: new Map(this.#paneStates),
      layouts: [...this.#layouts],
      fault: this.#fault,
    };
  }

  /**
   * Record one window's geometry.
   *
   * Keyed by the durable window stamp when there is one, and by the window's
   * own pane set when there is not: an unstamped window still has to hold ONE
   * place in the tab strip rather than appending a new tab per frame.
   */
  #onLayout(generation: number, layout: PaneStreamLayoutEvent): void {
    if (this.#disposed || generation !== this.#generation) return;
    const key = layoutWindowKey(layout);
    const index = this.#layouts.findIndex((known) => layoutWindowKey(known) === key);
    if (index >= 0) this.#layouts[index] = layout;
    else this.#layouts.push(layout);
    if (layout.currentWindow) {
      // tmux has exactly one current window; a stale flag on another frame would
      // make two tabs claim to be the one the user is in.
      this.#layouts = this.#layouts.map((known) =>
        layoutWindowKey(known) === key || !known.currentWindow
          ? known
          : { ...known, currentWindow: false },
      );
    }
    // The pane-stream guarantees that a layout frame is delivered before any
    // bytes tmux produced at that new geometry. Put the corresponding resize on
    // the SAME per-pane tail as seed/output/cursor so a compositor can never
    // paint new-width output into the previous grid.
    for (const pane of layout.panes) {
      if (pane.pane && this.#paneStates.has(pane.pane)) {
        this.#enqueueSinkEvent(pane.pane, {
          type: "geometry",
          cols: pane.width,
          rows: pane.height,
        });
      }
    }
    this.#emit();
  }

  /**
   * Register the mounted node that applies this pane's bytes. Events buffered
   * before registration replay in wire order ahead of anything newer.
   */
  registerPaneSink(pane: string, sink: MirrorPaneSink): () => void {
    const channel = this.#channel(pane);
    const needsFreshSeed =
      channel.seedSeen && !channel.buffer.some((event) => event.type === "seed-batch");
    channel.sink = sink;
    const buffered = channel.buffer.splice(0, channel.buffer.length);
    for (const event of buffered) {
      channel.tail = channel.tail
        .then(() => (channel.sink === sink ? this.#applyToSink(sink, event) : undefined))
        .catch(() => undefined);
    }
    if (needsFreshSeed) this.#scheduleFreshSeed();
    return () => {
      if (channel.sink === sink) channel.sink = null;
    };
  }

  /**
   * A pane node can be remounted after its one-shot seed was consumed (HMR,
   * view reparenting, or a recovered renderer). The protocol intentionally has
   * no per-pane reseed verb, so coalesce all such registrations into one fresh
   * lease. That gives every mounted sink a new atomic seed without retaining an
   * unbounded replay log of terminal output in the renderer process.
   */
  #scheduleFreshSeed(): void {
    if (this.#disposed || this.#freshSeedScheduled) return;
    this.#freshSeedScheduled = true;
    queueMicrotask(() => {
      this.#freshSeedScheduled = false;
      if (!this.#disposed) this.retry();
    });
  }

  #channel(pane: string): SinkChannel {
    let channel = this.#channels.get(pane);
    if (!channel) {
      channel = { sink: null, buffer: [], seedSeen: false, tail: Promise.resolve() };
      this.#channels.set(pane, channel);
    }
    return channel;
  }

  #applyToSink(sink: MirrorPaneSink, event: MirrorSinkEvent): void | Promise<void> {
    if (event.type === "geometry") {
      sink.applyGeometry(event.cols, event.rows);
      return;
    }
    if (event.type === "seed-batch") return sink.applySeedBatch(event.batch);
    if (event.type === "output") return sink.applyOutput(event.bytes);
    if (event.type === "cursor") sink.applyCursor(event.x, event.y);
    return undefined;
  }

  #enqueueSinkEvent(pane: string, event: MirrorSinkEvent): void | Promise<void> {
    const channel = this.#channel(pane);
    if (!channel.sink) {
      if (channel.buffer.length >= MAX_BUFFERED_EVENTS_PER_PANE) {
        this.#scheduleReconnect({
          code: "mirror-sink-missing",
          reason: "No mirror node consumed this pane's stream in time.",
          retryable: true,
        });
        return;
      }
      channel.buffer.push(event);
      return;
    }
    channel.tail = channel.tail
      .then(() => (channel.sink ? this.#applyToSink(channel.sink, event) : undefined))
      .catch(() => undefined);
    return channel.tail;
  }

  start(): void {
    if (this.#disposed || this.#session || this.#transportState.phase === "connecting") return;
    this.#connect();
  }

  /** Explicit user retry: resets the bounded attempt budget and reconnects. */
  retry(): void {
    if (this.#disposed) return;
    this.#attempt = 0;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#retireSession();
    this.#connect();
  }

  /** The pane set is enumerated at issue; changing it means a NEW lease. */
  setPanes(panes: readonly string[]): void {
    if (this.#disposed) return;
    const next = [...panes];
    if (next.length === this.#panes.length && next.every((pane, i) => pane === this.#panes[i])) {
      return;
    }
    this.#panes = next;
    this.#paneStates = new Map(next.map((pane) => [pane, { kind: "connecting" } as const]));
    this.#attempt = 0;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#retireSession();
    this.#connect();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#retireSession();
    this.#channels.clear();
  }

  #retireSession(): void {
    const session = this.#session;
    this.#session = null;
    if (session) {
      try {
        session.dispose();
      } catch {
        // The session is already the retired generation.
      }
    }
  }

  #emit(): void {
    if (!this.#onStateChanged) return;
    try {
      this.#onStateChanged(this.state());
    } catch {
      // A state observer fault cannot destabilize the stream lifecycle.
    }
  }

  #setTransport(state: DesktopDaemonTransportState, fault: PaneStreamTransportError | null): void {
    this.#transportState = state;
    this.#fault = fault;
    this.#emit();
  }

  #setPaneState(pane: string, state: MirrorPaneNodeState): void {
    if (!this.#paneStates.has(pane)) return;
    this.#paneStates.set(pane, state);
    this.#emit();
  }

  #connect(): void {
    if (this.#disposed || this.#panes.length === 0) return;
    const generation = ++this.#generation;
    // A new lease reseeds every pane; bytes buffered for the old one are stale.
    // The layouts are NOT cleared: tmux re-sends a frame per window on
    // subscribe, and blanking the tab strip for the width of a reconnect would
    // make a recoverable stream drop look like the session losing its windows.
    for (const channel of this.#channels.values()) {
      channel.buffer.length = 0;
      channel.seedSeen = false;
    }
    for (const [pane, state] of this.#paneStates) {
      if (state.kind !== "ended") this.#paneStates.set(pane, { kind: "connecting" });
    }
    this.#setTransport({ phase: "connecting" }, this.#fault);
    void this.#transport
      .connect(
        { workspaceName: this.#workspaceName, panes: this.#panes },
        {
          onPaneEvent: (pane, event) => this.#onPaneEvent(generation, pane, event),
          onLayout: (layout) => this.#onLayout(generation, layout),
          onEnd: (error) => this.#onEnd(generation, error),
        },
      )
      .then((result) => {
        if (this.#disposed || generation !== this.#generation) {
          if (result.status === "connected") result.session.dispose();
          return;
        }
        if (result.status === "error") {
          this.#scheduleReconnect(result.error);
          return;
        }
        this.#session = result.session;
        this.#attempt = 0;
        this.#setTransport({ phase: "connected" }, null);
      })
      .catch(() => {
        if (this.#disposed || generation !== this.#generation) return;
        this.#scheduleReconnect({
          code: "attachment-unavailable",
          reason: "The pane stream could not be established.",
          retryable: true,
        });
      });
  }

  #onPaneEvent(generation: number, pane: string, event: PaneMirrorEvent): void | Promise<void> {
    if (this.#disposed || generation !== this.#generation) return;
    const current = this.#paneStates.get(pane);
    if (!current) return;
    if (event.type === "closed") {
      // The pane ended in tmux — an honest terminal state, never an error.
      this.#setPaneState(pane, { kind: "ended" });
      return;
    }
    if (event.type === "flow") {
      if (current.kind === "live" || current.kind === "connecting") {
        this.#setPaneState(pane, { kind: "live", flowPaused: event.state === "paused" });
      }
      return;
    }
    if (event.type === "seed-batch" && current.kind !== "ended") {
      this.#channel(pane).seedSeen = true;
      this.#setPaneState(pane, { kind: "live", flowPaused: false });
    }
    return this.#enqueueSinkEvent(pane, event);
  }

  #onEnd(generation: number, error: PaneStreamTransportError | null): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#session = null;
    if (error === null) {
      // Clean end: every leased pane closed in tmux. Nothing to reconnect to.
      this.#setTransport({ phase: "idle" }, null);
      return;
    }
    this.#scheduleReconnect(error);
  }

  #scheduleReconnect(error: PaneStreamTransportError): void {
    this.#retireSession();
    if (!error.retryable || this.#attempt >= this.#reconnectMaximumAttempts) {
      this.#setTransport({ phase: "stopped", error: transportFault(error) }, error);
      return;
    }
    this.#attempt += 1;
    const delay = Math.min(
      this.#reconnectMaximumDelayMs,
      this.#reconnectInitialDelayMs * 2 ** (this.#attempt - 1),
    );
    const generation = this.#generation;
    this.#setTransport(
      {
        phase: "reconnecting",
        attempt: this.#attempt,
        maximumAttempts: this.#reconnectMaximumAttempts,
        nextRetryAt: this.#now() + delay,
        error: transportFault(error),
      },
      error,
    );
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = null;
      if (this.#disposed || generation !== this.#generation) return;
      this.#connect();
    }, delay);
  }
}

/** The stable identity of one window across frames. */
export function layoutWindowKey(layout: PaneStreamLayoutEvent): string {
  if (layout.semanticWindowId) return layout.semanticWindowId;
  const panes = layout.panes
    .map((pane) => pane.pane)
    .filter((pane): pane is string => pane !== null)
    .sort();
  return `unstamped:${panes.join(",")}`;
}
