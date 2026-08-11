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
const CANDIDATE_READY_TIMEOUT_MS = 5_000;
/**
 * Events that arrive before the pane's node registers its sink are buffered
 * and replayed in order on registration (the mount/connect race). There is no
 * reseed-request verb on the wire, so an overflow cannot be healed in place —
 * the session reconnects for a fresh seed instead of splicing a gap.
 */
const MAX_BUFFERED_EVENTS_PER_PANE = 1_024;
const MAX_STAGED_CANDIDATE_EVENTS = 1_024;

type MirrorSinkEvent =
  | PaneMirrorEvent
  | { readonly type: "geometry"; readonly cols: number; readonly rows: number };

interface SinkChannel {
  sink: MirrorPaneSink | null;
  sinkEpoch: number;
  readonly buffer: MirrorSinkEvent[];
  /** Latest complete terminal representation, bounded to one atomic repaint. */
  replay: PaneMirrorSeedBatch | (() => PaneMirrorSeedBatch) | null;
  /** Latest authoritative pane geometry. */
  geometry: { readonly cols: number; readonly rows: number } | null;
  /** Serializes buffered replay and live events so paint order is wire order. */
  tail: Promise<void>;
}

type StagedCandidateEvent =
  | { readonly kind: "layout"; readonly layout: PaneStreamLayoutEvent }
  | { readonly kind: "pane"; readonly pane: string; readonly event: PaneMirrorEvent };

interface CandidateSession {
  readonly generation: number;
  readonly panes: readonly string[];
  readonly staged: StagedCandidateEvent[];
  readonly seeded: Set<string>;
  readonly laidOut: Set<string>;
  session: PaneStreamSessionHandle | null;
  cancelDeadline: (() => void) | null;
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
  #activeGeneration = 0;
  #candidate: CandidateSession | null = null;
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
    if (this.#disposed || generation !== this.#activeGeneration) return;
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
    const sinkEpoch = ++channel.sinkEpoch;
    channel.sink = sink;
    const buffered = channel.buffer.splice(0, channel.buffer.length);
    if (channel.replay) {
      const replay = typeof channel.replay === "function" ? channel.replay() : channel.replay;
      channel.tail = channel.tail
        .then(() =>
          channel.sink === sink && channel.sinkEpoch === sinkEpoch
            ? sink.applySeedBatch(replay)
            : undefined,
        )
        .catch(() => undefined);
    } else if (channel.geometry) {
      const geometry = channel.geometry;
      channel.tail = channel.tail
        .then(() =>
          channel.sink === sink && channel.sinkEpoch === sinkEpoch
            ? sink.applyGeometry(geometry.cols, geometry.rows)
            : undefined,
        )
        .catch(() => undefined);
    }
    for (const event of buffered) {
      channel.tail = channel.tail
        .then(() =>
          channel.sink === sink && channel.sinkEpoch === sinkEpoch
            ? this.#applyToSink(sink, event)
            : undefined,
        )
        .catch(() => undefined);
    }
    return () => {
      if (channel.sink === sink) channel.sink = null;
    };
  }

  #channel(pane: string): SinkChannel {
    let channel = this.#channels.get(pane);
    if (!channel) {
      channel = {
        sink: null,
        sinkEpoch: 0,
        buffer: [],
        replay: null,
        geometry: null,
        tail: Promise.resolve(),
      };
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
    if (event.type === "geometry") {
      channel.geometry = { cols: event.cols, rows: event.rows };
      if (channel.replay && typeof channel.replay !== "function") {
        channel.replay = { ...channel.replay, reset: channel.geometry };
      }
    } else if (event.type === "seed-batch") {
      channel.replay = event.batch;
    } else if (event.type === "output" && event.replay) {
      channel.replay = event.replay;
    } else if (event.type === "output" && channel.replay && typeof channel.replay !== "function") {
      if (channel.replay.held.length >= MAX_BUFFERED_EVENTS_PER_PANE) {
        this.#scheduleReconnect({
          code: "mirror-replay-overflow",
          reason: "The retained terminal replay exceeded its bounded legacy tail.",
          retryable: true,
        });
      } else {
        channel.replay = { ...channel.replay, held: [...channel.replay.held, event.bytes] };
      }
    } else if (event.type === "cursor" && channel.replay && typeof channel.replay !== "function") {
      channel.replay = { ...channel.replay, cursor: { x: event.x, y: event.y } };
    }
    if (!channel.sink) {
      if (event.type === "geometry") return;
      if (
        channel.replay &&
        (event.type === "seed-batch" || event.type === "output" || event.type === "cursor")
      ) {
        return;
      }
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
    const sink = channel.sink;
    const sinkEpoch = channel.sinkEpoch;
    channel.tail = channel.tail
      .then(() =>
        channel.sink === sink && channel.sinkEpoch === sinkEpoch
          ? this.#applyToSink(sink, event)
          : undefined,
      )
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
    this.#retireCandidate();
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
    this.#attempt = 0;
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    if (!this.#session) {
      this.#paneStates = new Map(next.map((pane) => [pane, { kind: "connecting" } as const]));
      this.#connect();
      return;
    }
    this.#connectCandidate(next);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#activeGeneration = 0;
    this.#retireCandidate();
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

  #retireCandidate(): void {
    const candidate = this.#candidate;
    this.#candidate = null;
    candidate?.cancelDeadline?.();
    if (!candidate?.session) return;
    try {
      candidate.session.dispose();
    } catch {
      // The candidate never became authoritative; teardown is best-effort.
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

  /**
   * Establish a changed pane-set beside the live lease. The old session keeps
   * painting (and its layouts remain authoritative) until redemption of the
   * candidate succeeds. A newer candidate fences every callback/result from an
   * older one, so a slow issue call can never roll the surface backwards.
   */
  #connectCandidate(panes: readonly string[]): void {
    this.#retireCandidate();
    const generation = ++this.#generation;
    const candidate: CandidateSession = {
      generation,
      panes: [...panes],
      staged: [],
      seeded: new Set(),
      laidOut: new Set(),
      session: null,
      cancelDeadline: null,
    };
    this.#candidate = candidate;
    candidate.cancelDeadline = this.#schedule(() => {
      if (
        this.#disposed ||
        this.#candidate !== candidate ||
        candidate.generation !== this.#generation
      )
        return;
      this.#retireCandidate();
      this.#fault = {
        code: "candidate-ready-timeout",
        reason: "The replacement pane stream did not provide a complete initial layout and seed.",
        retryable: true,
      };
      this.#emit();
    }, CANDIDATE_READY_TIMEOUT_MS);
    void this.#transport
      .connect(
        { workspaceName: this.#workspaceName, panes: candidate.panes },
        {
          onPaneEvent: (pane, event) => {
            if (generation === this.#activeGeneration) {
              return this.#onPaneEvent(generation, pane, event);
            }
            if (
              this.#disposed ||
              generation !== this.#generation ||
              this.#candidate?.generation !== generation
            )
              return;
            if (!this.#stageCandidate(candidate, { kind: "pane", pane, event })) return;
            if (event.type === "seed-batch" || event.type === "closed") {
              candidate.seeded.add(pane);
            }
            if (event.type === "closed") candidate.laidOut.add(pane);
            this.#commitCandidateIfReady(candidate);
          },
          onLayout: (layout) => {
            if (generation === this.#activeGeneration) {
              this.#onLayout(generation, layout);
              return;
            }
            if (
              this.#disposed ||
              generation !== this.#generation ||
              this.#candidate?.generation !== generation
            )
              return;
            if (!this.#stageCandidate(candidate, { kind: "layout", layout })) return;
            for (const pane of layout.panes) {
              if (pane.pane) candidate.laidOut.add(pane.pane);
            }
            this.#commitCandidateIfReady(candidate);
          },
          onEnd: (error) => {
            if (generation === this.#activeGeneration) {
              this.#onEnd(generation, error);
              return;
            }
            if (generation !== this.#generation || this.#candidate?.generation !== generation)
              return;
            this.#retireCandidate();
            if (error && !this.#session) this.#scheduleReconnect(error);
            else {
              if (error) this.#fault = error;
              this.#emit();
            }
          },
        },
      )
      .then((result) => {
        if (
          this.#disposed ||
          generation !== this.#generation ||
          this.#candidate?.generation !== generation
        ) {
          if (result.status === "connected") result.session.dispose();
          return;
        }
        if (result.status === "error") {
          this.#retireCandidate();
          if (!this.#session) this.#scheduleReconnect(result.error);
          else {
            this.#fault = result.error;
            this.#emit();
          }
          return;
        }

        candidate.session = result.session;
        this.#commitCandidateIfReady(candidate);
      })
      .catch(() => {
        if (
          this.#disposed ||
          generation !== this.#generation ||
          this.#candidate?.generation !== generation
        )
          return;
        this.#retireCandidate();
        const error: PaneStreamTransportError = {
          code: "attachment-unavailable",
          reason: "The pane stream candidate could not be established.",
          retryable: true,
        };
        if (!this.#session) this.#scheduleReconnect(error);
        else {
          this.#fault = error;
          this.#emit();
        }
      });
  }

  #stageCandidate(candidate: CandidateSession, event: StagedCandidateEvent): boolean {
    if (candidate.staged.length >= MAX_STAGED_CANDIDATE_EVENTS) {
      this.#retireCandidate();
      this.#fault = {
        code: "candidate-staging-overflow",
        reason:
          "The replacement pane stream did not become paint-ready within its bounded staging window.",
        retryable: true,
      };
      this.#emit();
      return false;
    }
    candidate.staged.push(event);
    return true;
  }

  #commitCandidateIfReady(candidate: CandidateSession): void {
    if (
      this.#disposed ||
      this.#candidate !== candidate ||
      candidate.generation !== this.#generation ||
      !candidate.session ||
      candidate.panes.some((pane) => !candidate.seeded.has(pane) || !candidate.laidOut.has(pane))
    ) {
      return;
    }
    const previous = this.#session;
    this.#session = candidate.session;
    this.#activeGeneration = candidate.generation;
    candidate.cancelDeadline?.();
    this.#candidate = null;
    this.#paneStates = new Map(
      candidate.panes.map((pane) => [pane, { kind: "connecting" } as const]),
    );
    const retainedPanes = new Set(candidate.panes);
    for (const [pane, channel] of this.#channels) {
      if (!retainedPanes.has(pane)) this.#channels.delete(pane);
      else channel.buffer.length = 0;
    }
    this.#setTransport({ phase: "connected" }, null);
    for (const staged of candidate.staged) {
      if (staged.kind === "layout") this.#onLayout(candidate.generation, staged.layout);
      else void this.#onPaneEvent(candidate.generation, staged.pane, staged.event);
    }
    try {
      previous?.dispose();
    } catch {
      // The candidate is already active; an old-handle teardown fault must not
      // invalidate the successful handoff.
    }
  }

  #connect(): void {
    if (this.#disposed || this.#panes.length === 0) return;
    const generation = ++this.#generation;
    this.#activeGeneration = generation;
    // A new lease reseeds every pane; bytes buffered for the old one are stale.
    // The layouts are NOT cleared: tmux re-sends a frame per window on
    // subscribe, and blanking the tab strip for the width of a reconnect would
    // make a recoverable stream drop look like the session losing its windows.
    for (const channel of this.#channels.values()) {
      channel.buffer.length = 0;
      channel.replay = null;
      channel.geometry = null;
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
        this.#activeGeneration = generation;
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
    if (this.#disposed || generation !== this.#activeGeneration) return;
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
    return this.#enqueueSinkEvent(pane, event);
  }

  #onEnd(generation: number, error: PaneStreamTransportError | null): void {
    if (this.#disposed || generation !== this.#activeGeneration) return;
    this.#session = null;
    if (this.#candidate) {
      this.#setTransport({ phase: "connecting" }, error);
      return;
    }
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
      if (this.#disposed || generation !== this.#generation || this.#session || this.#candidate)
        return;
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
