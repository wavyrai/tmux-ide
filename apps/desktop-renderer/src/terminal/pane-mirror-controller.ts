import type { DesktopDaemonTransportState } from "@tmux-ide/contracts";

import type {
  PaneMirrorEvent,
  PaneMirrorSeedBatch,
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
 *    settled promise is what releases the cumulative `consumed` ack upstream.
 *
 * Changing the pane set means a NEW lease (the set is enumerated at issue), so
 * `setPanes` retires the current session and reconnects.
 */

export interface MirrorPaneSink {
  /** ONE atomic paint: reset, one capture, held deltas, cursor — never spliced. */
  applySeedBatch(batch: PaneMirrorSeedBatch): void | Promise<void>;
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

interface SinkChannel {
  sink: MirrorPaneSink | null;
  readonly buffer: PaneMirrorEvent[];
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
  #transportState: DesktopDaemonTransportState = { phase: "idle" };
  #fault: PaneStreamTransportError | null = null;
  #session: PaneStreamSessionHandle | null = null;
  #cancelRetry: (() => void) | null = null;
  #attempt = 0;
  #generation = 0;
  #disposed = false;

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
      fault: this.#fault,
    };
  }

  /**
   * Register the mounted node that applies this pane's bytes. Events buffered
   * before registration replay in wire order ahead of anything newer.
   */
  registerPaneSink(pane: string, sink: MirrorPaneSink): () => void {
    const channel = this.#channel(pane);
    channel.sink = sink;
    const buffered = channel.buffer.splice(0, channel.buffer.length);
    for (const event of buffered) {
      channel.tail = channel.tail
        .then(() => (channel.sink === sink ? this.#applyToSink(sink, event) : undefined))
        .catch(() => undefined);
    }
    return () => {
      if (channel.sink === sink) channel.sink = null;
    };
  }

  #channel(pane: string): SinkChannel {
    let channel = this.#channels.get(pane);
    if (!channel) {
      channel = { sink: null, buffer: [], tail: Promise.resolve() };
      this.#channels.set(pane, channel);
    }
    return channel;
  }

  #applyToSink(sink: MirrorPaneSink, event: PaneMirrorEvent): void | Promise<void> {
    if (event.type === "seed-batch") return sink.applySeedBatch(event.batch);
    if (event.type === "output") return sink.applyOutput(event.bytes);
    if (event.type === "cursor") sink.applyCursor(event.x, event.y);
    return undefined;
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
    for (const channel of this.#channels.values()) channel.buffer.length = 0;
    for (const [pane, state] of this.#paneStates) {
      if (state.kind !== "ended") this.#paneStates.set(pane, { kind: "connecting" });
    }
    this.#setTransport({ phase: "connecting" }, this.#fault);
    void this.#transport
      .connect(
        { workspaceName: this.#workspaceName, panes: this.#panes },
        {
          onPaneEvent: (pane, event) => this.#onPaneEvent(generation, pane, event),
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
      this.#setPaneState(pane, { kind: "live", flowPaused: false });
    }
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
