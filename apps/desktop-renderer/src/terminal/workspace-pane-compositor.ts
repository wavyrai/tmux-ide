import { PANE_STREAM_MAX_PANES, type DesktopDaemonTransportState } from "@tmux-ide/contracts";

import type {
  PaneMirrorEvent,
  PaneMirrorSeedBatch,
  PaneStreamLayoutEvent,
  PaneStreamLayoutSnapshotEvent,
  PaneStreamSessionHandle,
  PaneStreamTransport,
  PaneStreamTransportError,
} from "./pane-stream-transport.ts";

export interface MirrorPaneSink {
  applySeedBatch(batch: PaneMirrorSeedBatch): void | Promise<void>;
  applyGeometry(cols: number, rows: number): void;
  applyOutput(bytes: Uint8Array): void | Promise<void>;
  applyCursor(x: number, y: number): void;
}

export type MirrorPaneNodeState =
  | { readonly kind: "connecting" }
  | { readonly kind: "live"; readonly flowPaused: boolean }
  | { readonly kind: "ended" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface WorkspacePaneCompositorState {
  readonly transport: DesktopDaemonTransportState;
  readonly panes: ReadonlyMap<string, MirrorPaneNodeState>;
  readonly layouts: readonly PaneStreamLayoutEvent[];
  readonly fault: PaneStreamTransportError | null;
}

interface SinkChannel {
  sink: MirrorPaneSink | null;
  sinkEpoch: number;
  replay: PaneMirrorSeedBatch | (() => PaneMirrorSeedBatch) | null;
  geometry: { readonly cols: number; readonly rows: number } | null;
  tail: Promise<void>;
  pendingGeometryBatch: { value: { readonly cols: number; readonly rows: number } } | null;
}

function boundedReason(reason: string): string {
  const value = reason.trim().slice(0, 240);
  return value || "The pane stream is unavailable.";
}

function layoutKey(layout: PaneStreamLayoutEvent): string {
  return (
    layout.semanticWindowId ??
    layout.panes
      .map((pane) => pane.pane ?? "")
      .sort()
      .join("\u0000")
  );
}

/**
 * Presentation-only fanout over the WorkspaceClient-owned pane-stream bridge.
 * It neither issues capabilities nor reconnects a transport; target/rebind
 * authority remains exclusively in WorkspaceClient.
 */
export class WorkspacePaneCompositor {
  readonly #transport: PaneStreamTransport;
  readonly #workspaceName: string;
  readonly #onStateChanged: ((state: WorkspacePaneCompositorState) => void) | undefined;
  readonly #channels = new Map<string, SinkChannel>();
  #panes: readonly string[];
  #paneStates = new Map<string, MirrorPaneNodeState>();
  #layouts: PaneStreamLayoutEvent[] = [];
  #transportState: DesktopDaemonTransportState = { phase: "idle" };
  #fault: PaneStreamTransportError | null = null;
  #session: PaneStreamSessionHandle | null = null;
  #generation = 0;
  #disposed = false;

  constructor(input: {
    readonly transport: PaneStreamTransport;
    readonly workspaceName: string;
    readonly panes: readonly string[];
    readonly onStateChanged?: (state: WorkspacePaneCompositorState) => void;
  }) {
    this.#transport = input.transport;
    this.#workspaceName = input.workspaceName;
    this.#panes = [...input.panes];
    this.#onStateChanged = input.onStateChanged;
    this.#paneStates = new Map(this.#panes.map((pane) => [pane, { kind: "connecting" }]));
  }

  state(): WorkspacePaneCompositorState {
    return {
      transport: this.#transportState,
      panes: new Map(this.#paneStates),
      layouts: [...this.#layouts],
      fault: this.#fault,
    };
  }

  start(): void {
    if (this.#disposed || this.#session || this.#transportState.phase === "connecting") return;
    const generation = ++this.#generation;
    this.#transportState = { phase: "connecting" };
    this.#emit();
    void this.#transport
      .connect(
        { workspaceName: this.#workspaceName, panes: this.#panes },
        {
          onPaneEvent: (pane, event) => this.#onPaneEvent(generation, pane, event),
          onLayout: (layout) => this.#onLayout(generation, layout),
          onLayoutSnapshot: (snapshot) => this.#onLayoutSnapshot(generation, snapshot),
          onEnd: (error) => this.#onEnd(generation, error),
        },
      )
      .then((result) => {
        if (this.#disposed || generation !== this.#generation) {
          if (result.status === "connected") result.session.dispose();
          return;
        }
        if (result.status === "error") {
          this.#fault = result.error;
          this.#transportState = {
            phase: "degraded",
            error: { code: "event-unavailable", reason: boundedReason(result.error.reason) },
          };
          this.#paneStates = new Map(
            this.#panes.map((pane) => [
              pane,
              { kind: "unavailable", reason: boundedReason(result.error.reason) },
            ]),
          );
        } else {
          this.#session = result.session;
          this.#transportState = { phase: "connected" };
          for (const pane of this.#panes)
            if (this.#paneStates.get(pane)?.kind === "connecting")
              this.#paneStates.set(pane, { kind: "live", flowPaused: false });
        }
        this.#emit();
      });
  }

  setPanes(panes: readonly string[]): void {
    if (this.#disposed) return;
    const next = [...panes];
    if (
      next.length === this.#panes.length &&
      next.every((pane, index) => pane === this.#panes[index])
    )
      return;
    this.#session?.dispose();
    this.#session = null;
    this.#generation += 1;
    this.#panes = next;
    this.#paneStates = new Map(next.map((pane) => [pane, { kind: "connecting" }]));
    const nextPaneSet = new Set(next);
    this.#layouts = this.#layouts.filter((layout) =>
      layout.panes.some(({ pane }) => pane !== null && nextPaneSet.has(pane)),
    );
    for (const [pane, channel] of this.#channels) {
      channel.sinkEpoch += 1;
      if (next.includes(pane)) {
        // Keep the serialization tail: the epoch makes already-queued work a
        // no-op, while the still-running sink call must settle before work for
        // the replacement lease can begin.
        channel.pendingGeometryBatch = null;
      } else {
        channel.sink = null;
        this.#channels.delete(pane);
      }
    }
    this.#transportState = { phase: "idle" };
    this.start();
  }

  registerPaneSink(pane: string, sink: MirrorPaneSink): () => void {
    const channel = this.#channel(pane);
    const epoch = ++channel.sinkEpoch;
    channel.sink = sink;
    const replay = channel.replay;
    const geometry = channel.geometry;
    channel.tail = channel.tail
      .then(async () => {
        if (channel.sink !== sink || channel.sinkEpoch !== epoch) return;
        if (replay) await sink.applySeedBatch(typeof replay === "function" ? replay() : replay);
        else if (geometry) sink.applyGeometry(geometry.cols, geometry.rows);
      })
      .catch(() => undefined);
    return () => {
      if (channel.sink === sink) channel.sink = null;
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation += 1;
    this.#session?.dispose();
    this.#session = null;
    for (const channel of this.#channels.values()) {
      channel.sink = null;
      channel.sinkEpoch += 1;
      channel.pendingGeometryBatch = null;
    }
    this.#channels.clear();
  }

  #channel(pane: string): SinkChannel {
    let channel = this.#channels.get(pane);
    if (!channel) {
      channel = {
        sink: null,
        sinkEpoch: 0,
        replay: null,
        geometry: null,
        tail: Promise.resolve(),
        pendingGeometryBatch: null,
      };
      this.#channels.set(pane, channel);
    }
    return channel;
  }

  #onPaneEvent(generation: number, pane: string, event: PaneMirrorEvent): void | Promise<void> {
    if (this.#disposed || generation !== this.#generation || !this.#paneStates.has(pane)) return;
    const state = this.#paneStates.get(pane);
    if (event.type === "closed") this.#paneStates.set(pane, { kind: "ended" });
    else if (event.type === "flow")
      this.#paneStates.set(pane, { kind: "live", flowPaused: event.state === "paused" });
    else if (state?.kind !== "live")
      this.#paneStates.set(pane, { kind: "live", flowPaused: false });
    this.#emit();
    const channel = this.#channel(pane);
    channel.pendingGeometryBatch = null;
    if (event.type === "seed-batch") channel.replay = event.batch;
    else if (event.type === "output" && event.replay) channel.replay = event.replay;
    else if (event.type === "cursor" && channel.replay && typeof channel.replay !== "function")
      channel.replay = { ...channel.replay, cursor: { x: event.x, y: event.y } };
    if (!channel.sink) return;
    const sink = channel.sink;
    const epoch = channel.sinkEpoch;
    channel.tail = channel.tail
      .then(async () => {
        if (channel.sink !== sink || channel.sinkEpoch !== epoch) return;
        if (event.type === "seed-batch") await sink.applySeedBatch(event.batch);
        else if (event.type === "output") await sink.applyOutput(event.bytes);
        else if (event.type === "cursor") sink.applyCursor(event.x, event.y);
      })
      .catch(() => undefined);
    return channel.tail;
  }

  #onLayout(generation: number, layout: PaneStreamLayoutEvent): void {
    if (this.#disposed || generation !== this.#generation) return;
    const key = layoutKey(layout);
    const index = this.#layouts.findIndex((known) => layoutKey(known) === key);
    if (index < 0) {
      // One live tmux window must contain at least one leased pane, so the pane
      // contract also bounds the number of useful layout authorities. A
      // malformed/stale producer that restamps the same pane through unlimited
      // window identities cannot make renderer state grow without bound.
      if (this.#layouts.length >= PANE_STREAM_MAX_PANES) this.#layouts.shift();
      this.#layouts.push(layout);
    } else this.#layouts[index] = layout;
    if (layout.currentWindow)
      this.#layouts = this.#layouts.map((known) =>
        layoutKey(known) === key || !known.currentWindow
          ? known
          : { ...known, currentWindow: false },
      );
    this.#applyLayoutGeometry(layout);
    this.#emit();
  }

  #applyLayoutGeometry(layout: PaneStreamLayoutEvent): void {
    for (const pane of layout.panes) {
      if (!pane.pane || !this.#paneStates.has(pane.pane)) continue;
      const channel = this.#channel(pane.pane);
      channel.geometry = { cols: pane.width, rows: pane.height };
      if (!channel.sink) continue;
      const sink = channel.sink;
      const epoch = channel.sinkEpoch;
      if (channel.pendingGeometryBatch) {
        channel.pendingGeometryBatch.value = channel.geometry;
        continue;
      }
      const batch = { value: channel.geometry };
      channel.pendingGeometryBatch = batch;
      channel.tail = channel.tail
        .then(() => {
          if (channel.sink === sink && channel.sinkEpoch === epoch)
            sink.applyGeometry(batch.value.cols, batch.value.rows);
          if (channel.pendingGeometryBatch === batch) channel.pendingGeometryBatch = null;
        })
        .catch(() => {
          if (channel.pendingGeometryBatch === batch) channel.pendingGeometryBatch = null;
        });
    }
  }

  #onLayoutSnapshot(generation: number, snapshot: PaneStreamLayoutSnapshotEvent): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#layouts = [...snapshot.layouts];
    for (const layout of snapshot.layouts) this.#applyLayoutGeometry(layout);
    this.#emit();
  }

  #onEnd(generation: number, error: PaneStreamTransportError | null): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#session = null;
    this.#fault = error;
    this.#transportState = error
      ? {
          phase: error.retryable ? "degraded" : "stopped",
          error: { code: "event-unavailable", reason: boundedReason(error.reason) },
        }
      : { phase: "idle" };
    this.#paneStates = new Map(
      this.#panes.map((pane) => [
        pane,
        error ? { kind: "unavailable", reason: boundedReason(error.reason) } : { kind: "ended" },
      ]),
    );
    this.#emit();
  }

  #emit(): void {
    try {
      this.#onStateChanged?.(this.state());
    } catch {
      // Presentation observers cannot own stream lifecycle.
    }
  }
}
