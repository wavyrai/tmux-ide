import type { ReadNativeBacking } from "../../../terminal/protocol/native-backing-client.ts";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type {
  TerminalFastLane,
  TerminalFastLanePublication,
} from "@tmux-ide/daemon-client/terminal-fast-lane";
import { terminalReplicaRowsEqual, type TerminalReplicaState } from "@tmux-ide/core";

import {
  reflowTerminalPosition,
  reflowRetainedTerminalSnapshot,
  retainNativeTerminalBacking,
} from "../terminal-viewport.ts";
import type { CellArrays } from "../blit.ts";
import type { BlitOptions, CursorState } from "../pane-mirror.ts";
import type { TerminalPaintTrace, TerminalPaneRenderSource } from "../pane-surface.tsx";
import {
  blitSemanticRow,
  changedTerminalRows,
  visibleTerminalRowAt,
} from "../semantic-pane-render-source.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";
import { currentTuiPerformanceEventSink } from "../performance-events.ts";
import type { TuiTerminalCanonicalPublicationEvent } from "../performance-events.ts";
import type { TuiTerminalCanonicalPaintIdentity } from "../performance-events.ts";
import type { CausalCellClientLedger } from "./causal-cell-client-ledger.ts";
import type { OpenTuiTerminalResourceSampler } from "./workspace-terminal-fast-lane.ts";

import { TerminalRowProjectionCache } from "./terminal-row-projection-cache.ts";

interface PaneRendererInterest {
  rowProjectionCache?: TerminalRowProjectionCache;
  projectionViewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
    consumer: object | undefined;
  };
  readonly paneId: string;
  readonly listeners: Set<
    (
      version: number,
      sourceEpoch: number,
      presentationVersion: number,
      kind: "content" | "presentation",
    ) => void
  >;
  readonly dirtyRows: Set<number>;
  release: (() => void) | null;
  state: TerminalReplicaState | null;
  retainedView?: {
    state: TerminalReplicaState;
    snapshot: TerminalReplicaSnapshot;
    historyTrim: number;
    rejectedResize?: { cols: number; rows: number };
    capture?: AbortController;
    backingStatus: "pending" | "native" | "compatible";
    pendingSizes: { cols: number; rows: number }[];
    backingRevision: number;
  };
  version: number;
  presentationVersion: number;
  pendingHostFrame: Readonly<{
    generation: string;
    incarnation: string;
    revision: number;
    stateHash: string;
    cols: number;
    rows: number;
    acceptedUpdateType: "terminal.seed" | "terminal.patch";
    acceptedRevision: number;
  }> | null;
  pendingTrace: TerminalPaintTrace | null;
  pendingCursorTrace: TerminalPaintTrace | null;
  pendingSeedDiagnostic: TuiTerminalCanonicalPublicationEvent | null;
  lastAcceptedUpdateType: "terminal.seed" | "terminal.patch" | null;
  historyTrim: number;
  paintedRows?: (TerminalReplicaSnapshot["grid"][number] | undefined)[];
}

/**
 * OpenTUI-only paint adapter over the shared terminal fast lane.
 *
 * It never admits or applies a terminal replica update. The lane remains the
 * sole canonical state owner; this class retains only references to published
 * state plus renderer dirtiness/version metadata. That separation lets one
 * pane repaint without waking the application shell or a sibling pane.
 */
export class TerminalFastLaneRendererAdapter implements PaneScopedTerminalAdapter {
  readonly #lane: TerminalFastLane;
  readonly #panes = new Map<string, PaneRendererInterest>();
  #nativePaneGeometries = new Map<string, { cols: number; rows: number }>();
  readonly #sourceEpoch: number;
  readonly #causalCellLedger: CausalCellClientLedger | null;
  readonly #resourceSampler: OpenTuiTerminalResourceSampler | null;
  #disposed = false;
  #paintedCanonicalSnapshot = false;
  #pendingCanonicalHostFrames: Map<string, TuiTerminalCanonicalPaintIdentity> | null = null;
  #seenCanonicalHostFrameKeys: Set<string> | null = null;
  #canonicalModeKeys: Map<string, string> | null = null;
  #presentedCanonicalKeys: Map<string, string> | null = null;
  #droppedCanonicalHostFrames = 0;

  readonly renderSource: TerminalPaneRenderSource = {
    supportsViewportOrigin: true,
    captureReadPosition: (paneId, origin) => {
      const previous = this.#snapshot(paneId);
      const identity = this.paneCanonicalIdentity(paneId);
      if (!previous || !identity) return null;
      return () => {
        const next = this.#snapshot(paneId);
        const current = this.paneCanonicalIdentity(paneId);
        if (
          this.#disposed ||
          !next ||
          current?.generation !== identity.generation ||
          current?.incarnation !== identity.incarnation
        )
          return null;
        return reflowTerminalPosition(
          previous,
          next,
          origin,
          Boolean(this.#panes.get(paneId)?.retainedView),
        );
      };
    },
    scrollbackDepth: (paneId) => this.#snapshot(paneId)?.history.length ?? 0,
    cursorState: (paneId) => {
      const cursor = this.#snapshot(paneId)?.cursor;
      return cursor ? ({ ...cursor } satisfies CursorState) : null;
    },
    blitPane: (paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options) =>
      this.#blit(paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options),
    paneCanonicalIdentity: (paneId) => this.paneCanonicalIdentity(paneId),
    cursorPresentationTrace: (paneId) =>
      this.#panes.get(paneId)?.retainedView
        ? null
        : (this.#panes.get(paneId)?.pendingCursorTrace ?? null),
    acknowledgePresentation: (paneId, viewportCols, viewportRows) =>
      this.#acknowledgePresentation(paneId, viewportCols, viewportRows),
  };

  constructor(
    lane: TerminalFastLane,
    sourceEpoch = 1,
    causalCellLedger: CausalCellClientLedger | null = null,
    resourceSampler: OpenTuiTerminalResourceSampler | null = null,
    private readonly readNativeBacking: ReadNativeBacking | null = null,
  ) {
    this.#lane = lane;
    this.#sourceEpoch = sourceEpoch;
    this.#causalCellLedger = causalCellLedger;
    this.#resourceSampler = resourceSampler;
  }

  paneVersion(paneId: string): number {
    return this.#panes.get(paneId)?.version ?? 0;
  }

  panePresentationVersion(paneId: string): number {
    return this.#panes.get(paneId)?.presentationVersion ?? 0;
  }

  paneSourceEpoch(): number {
    return this.#sourceEpoch;
  }

  requestPaneReseed(paneId: string): boolean {
    if (this.#lane.paneLastAcceptedUpdateType(paneId) === "terminal.tombstone") return false;
    return this.#lane.requestRepair(paneId, "missing-state");
  }

  setNativePaneGeometries(
    panes: readonly { readonly paneId: string; readonly cols: number; readonly rows: number }[],
  ): void {
    if (this.#disposed) return;
    this.#nativePaneGeometries = new Map(
      panes
        .filter(
          ({ cols, rows }) =>
            Number.isSafeInteger(cols) && cols > 0 && Number.isSafeInteger(rows) && rows > 0,
        )
        .map(({ paneId, cols, rows }) => [paneId, { cols, rows }]),
    );
    for (const interest of this.#panes.values()) {
      if (!this.#resizeRetainedView(interest)) continue;
      interest.paintedRows = [];
      interest.rowProjectionCache?.clear();
      interest.projectionViewport = undefined;
      interest.version++;
      for (const listener of [...interest.listeners]) {
        try {
          listener(interest.version, this.#sourceEpoch, interest.presentationVersion, "content");
        } catch {
          // A renderer observer cannot prevent sibling invalidation.
        }
      }
    }
  }

  #resizeRetainedView(
    interest: PaneRendererInterest,
    fallback = interest.state?.snapshot,
  ): boolean {
    const retained = interest.retainedView;
    const geometry = this.#nativePaneGeometries.get(interest.paneId) ?? fallback;
    if (!retained || !geometry) return false;
    const { cols, rows } = geometry;
    if (
      (retained.snapshot.cols === cols && retained.snapshot.rows === rows) ||
      (retained.rejectedResize?.cols === cols && retained.rejectedResize.rows === rows)
    )
      return false;
    if (retained.backingStatus === "pending") {
      if (retained.pendingSizes.length >= 128) {
        retained.capture?.abort();
        retained.backingStatus = "compatible";
      } else retained.pendingSizes.push({ cols, rows });
    }
    const resized = reflowRetainedTerminalSnapshot(retained.snapshot, cols, rows);
    if (!resized) {
      retained.rejectedResize = { cols, rows };
      return false;
    }
    retained.snapshot = resized;
    delete retained.rejectedResize;
    return true;
  }

  /** Hold this client's presentation; canonical delivery continues in the lane. */
  retainPaneView(paneId: string): (() => void) | null {
    const interest = this.#panes.get(paneId);
    if (this.#disposed || !interest?.state?.snapshot || interest.retainedView) return null;
    const retained: NonNullable<PaneRendererInterest["retainedView"]> = {
      backingStatus: this.readNativeBacking ? "pending" : "compatible",
      pendingSizes: [],
      backingRevision: 0,
      state: interest.state,
      snapshot: interest.state.snapshot,
      historyTrim: interest.historyTrim,
    };
    interest.retainedView = retained;
    const original = retained.snapshot;
    if (this.readNativeBacking) {
      const capture = new AbortController();
      retained.capture = capture;
      void this.readNativeBacking(
        paneId,
        {
          generation: retained.state.generation,
          incarnation: retained.state.incarnation,
          revision: retained.state.revision,
          stateHash: retained.state.hash,
        },
        capture.signal,
      )
        .then((backing) => {
          if (
            capture.signal.aborted ||
            this.#disposed ||
            this.#panes.get(paneId) !== interest ||
            interest.retainedView !== retained
          )
            return;
          retained.backingStatus = "compatible";
          if (!backing || !retainNativeTerminalBacking(original, backing)) return;
          let snapshot = original;
          for (const size of retained.pendingSizes) {
            const next = reflowRetainedTerminalSnapshot(snapshot, size.cols, size.rows);
            if (!next) return;
            snapshot = next;
          }
          retained.snapshot = snapshot;
          retained.backingStatus = "native";
          retained.backingRevision++;
          retained.pendingSizes = [];
          delete retained.rejectedResize;
          interest.paintedRows = [];
          interest.rowProjectionCache?.clear();
          interest.projectionViewport = undefined;
          interest.version++;
          for (const listener of [...interest.listeners]) {
            try {
              listener(
                interest.version,
                this.#sourceEpoch,
                interest.presentationVersion,
                "content",
              );
            } catch {
              /* Isolate observers. */
            }
          }
        })
        .catch(() => {
          if (interest.retainedView === retained) retained.backingStatus = "compatible";
        });
    }
    this.#resizeRetainedView(interest);
    return () => {
      if (
        this.#disposed ||
        this.#panes.get(paneId) !== interest ||
        interest.retainedView !== retained
      )
        return;
      interest.retainedView?.capture?.abort();
      delete interest.retainedView;
      // A held screen cannot satisfy pending live paint diagnostics. The next
      // full repaint owns those live cells and the latest host-frame fence.
      for (let row = 0; row < (interest.state?.snapshot?.rows ?? 0); row++)
        interest.dirtyRows.add(row);
      interest.paintedRows = [];
      interest.rowProjectionCache?.clear();
      interest.projectionViewport = undefined;
      interest.version++;
      for (const listener of [...interest.listeners]) {
        try {
          listener(interest.version, this.#sourceEpoch, interest.presentationVersion, "content");
        } catch {
          /* Observers cannot prevent release. */
        }
      }
    };
  }

  paneRetainedBackingStatus(paneId: string): "pending" | "native" | "compatible" | null {
    return this.#panes.get(paneId)?.retainedView?.backingStatus ?? null;
  }

  paneSelectionSnapshot(paneId: string): TerminalReplicaSnapshot | null {
    return this.#snapshot(paneId) ?? this.#lane.paneState(paneId)?.snapshot ?? null;
  }

  /** True only after the shared reducer has published a canonical framebuffer. */
  hasCanonicalSnapshot(): boolean {
    for (const interest of this.#panes.values()) {
      if (interest.state?.snapshot) return true;
    }
    return false;
  }

  /** True only after a PaneSurface consumed canonical dirty rows. */
  hasPaintedCanonicalSnapshot(): boolean {
    return this.#paintedCanonicalSnapshot;
  }

  /** True only while detailed identities await the renderer's next frame. */
  hasPendingCanonicalHostFrameDiagnostics(): boolean {
    return Boolean(
      (this.#pendingCanonicalHostFrames && this.#pendingCanonicalHostFrames.size > 0) ||
      this.#droppedCanonicalHostFrames > 0,
    );
  }

  /** Detailed-only identities consumed by the next renderer frame. */
  drainCanonicalHostFrameIdentities(): Readonly<{
    identities: readonly TuiTerminalCanonicalPaintIdentity[];
    dropped: number;
  }> {
    const pending = this.#pendingCanonicalHostFrames;
    this.#pendingCanonicalHostFrames = null;
    const identities: TuiTerminalCanonicalPaintIdentity[] = [];
    const seen = (this.#seenCanonicalHostFrameKeys ??= new Set());
    for (const identity of pending?.values() ?? []) {
      const key = JSON.stringify([
        identity.generation,
        identity.incarnation,
        identity.semanticPaneId,
        identity.revision,
        identity.stateHash,
        identity.cols,
        identity.rows,
        identity.sourceEpoch,
        identity.viewportCols,
        identity.viewportRows,
        identity.acceptedUpdateType,
        identity.acceptedRevision,
      ]);
      if (seen.has(key)) continue;
      if (seen.size >= 256) this.#droppedCanonicalHostFrames += 1;
      else {
        seen.add(key);
        identities.push(identity);
      }
    }
    const dropped = this.#droppedCanonicalHostFrames;
    this.#droppedCanonicalHostFrames = 0;
    return Object.freeze({ identities, dropped });
  }

  /** Emit one detailed, one-shot resource sample only after this exact fence is published. */
  sampleResourceAfterFence(
    identity: TuiTerminalCanonicalPaintIdentity & { readonly rendererEpoch: number },
  ): void {
    this.#resourceSampler?.afterFence(identity);
  }

  subscribePaneVersion(
    paneId: string,
    listener: (
      version: number,
      sourceEpoch: number,
      presentationVersion: number,
      kind: "content" | "presentation",
    ) => void,
  ): () => void {
    if (this.#disposed) return () => undefined;
    const interest = this.#interest(paneId);
    interest.listeners.add(listener);
    if (!interest.release) {
      interest.release = this.#lane.subscribePane(paneId, (publication) => {
        this.#publish(interest, publication);
      });
    }
    // The lane owns a generation-scoped canonical replica even while a pane is
    // off-screen. A newly mounted surface must be invalidated synchronously
    // from that retained state; waiting for another terminal publication would
    // leave a quiet pane blank after switching back to its window.
    if (interest.state && interest.version === 1) {
      listener(interest.version, this.#sourceEpoch, interest.presentationVersion, "content");
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      interest.listeners.delete(listener);
      if (interest.listeners.size !== 0) return;
      interest.retainedView?.capture?.abort();
      interest.release?.();
      interest.rowProjectionCache?.clear();
      interest.projectionViewport = undefined;
      this.#panes.delete(paneId);
    };
  }

  rowProjectionDiagnostics(paneId: string) {
    return this.#panes.get(paneId)?.rowProjectionCache?.diagnostics() ?? null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const interest of this.#panes.values()) {
      interest.retainedView?.capture?.abort();
      interest.release?.();
      interest.rowProjectionCache?.clear();
      interest.projectionViewport = undefined;
    }
    this.#panes.clear();
    this.#nativePaneGeometries.clear();
    this.#pendingCanonicalHostFrames = null;
    this.#seenCanonicalHostFrameKeys = null;
    this.#canonicalModeKeys = null;
    this.#presentedCanonicalKeys = null;
    this.#droppedCanonicalHostFrames = 0;
  }

  paneCanonicalIdentity(paneId: string) {
    const interest = this.#panes.get(paneId);
    const state = interest?.retainedView?.state ?? interest?.state ?? this.#lane.paneState(paneId);
    const snapshot = state?.snapshot;
    if (!state || !snapshot) return null;
    return {
      generation: state.generation,
      incarnation: state.incarnation,
      revision: state.revision,
      stateHash: state.hash,
      cols: snapshot.cols,
      rows: snapshot.rows,
      ...(interest?.retainedView
        ? {
            viewBackingRevision: interest.retainedView.backingRevision,
            viewCols: interest.retainedView.snapshot.cols,
            viewRows: interest.retainedView.snapshot.rows,
          }
        : {}),
      sourceEpoch: this.#sourceEpoch,
      historyTrim: interest?.retainedView?.historyTrim ?? interest?.historyTrim ?? 0,
    } as const;
  }

  #interest(paneId: string): PaneRendererInterest {
    const retained = this.#panes.get(paneId);
    if (retained) return retained;
    const state = this.#lane.paneState(paneId);
    const lastAcceptedUpdateType = this.#lane.paneLastAcceptedUpdateType(paneId);
    const dirtyRows = new Set<number>();
    for (let row = 0; row < (state?.snapshot?.rows ?? 0); row += 1) dirtyRows.add(row);
    const interest: PaneRendererInterest = {
      paneId,
      listeners: new Set(),
      dirtyRows,
      release: null,
      state,
      version: state ? 1 : 0,
      presentationVersion: 0,
      pendingHostFrame: null,
      pendingTrace: null,
      pendingCursorTrace: null,
      pendingSeedDiagnostic: null,
      lastAcceptedUpdateType:
        lastAcceptedUpdateType === "terminal.seed" || lastAcceptedUpdateType === "terminal.patch"
          ? lastAcceptedUpdateType
          : null,
      historyTrim: 0,
    };
    if (lastAcceptedUpdateType === "terminal.seed" && state?.snapshot) {
      this.#noteSeedDiagnostic(interest, state, paneId);
    }
    const frameSink = currentTuiPerformanceEventSink();
    const retainedPresentationKey = state
      ? [state.generation, state.incarnation, state.revision, state.hash, this.#sourceEpoch].join(
          ":",
        )
      : null;
    if (
      state?.snapshot &&
      frameSink?.terminalCanonicalHostFrame &&
      frameSink.terminalFrameFence &&
      (lastAcceptedUpdateType === "terminal.seed" || lastAcceptedUpdateType === "terminal.patch") &&
      this.#presentedCanonicalKeys?.get(paneId) !== retainedPresentationKey
    ) {
      interest.pendingHostFrame = Object.freeze({
        generation: state.generation,
        incarnation: state.incarnation,
        revision: state.revision,
        stateHash: state.hash,
        cols: state.snapshot.cols,
        rows: state.snapshot.rows,
        acceptedUpdateType: lastAcceptedUpdateType,
        acceptedRevision: state.revision,
      });
    }
    this.#panes.set(paneId, interest);
    if (state?.snapshot) this.#reportCanonicalMode(paneId, state);
    return interest;
  }

  #publish(interest: PaneRendererInterest, publication: TerminalFastLanePublication): void {
    if (this.#disposed || publication.address.semanticPaneId !== interest.paneId) return;
    const previous = interest.state?.snapshot ?? null;
    const previousRetained = interest.retainedView?.snapshot;
    const next = publication.state.snapshot;
    if (publication.update.type !== "terminal.seed") interest.pendingSeedDiagnostic = null;
    else if (next)
      this.#noteSeedDiagnostic(interest, publication.state, publication.address.semanticPaneId);
    const replacesHistory =
      publication.update.type === "terminal.seed" ||
      (publication.update.type === "terminal.patch" &&
        publication.update.patch.history !== undefined);
    const comparableCapture =
      replacesHistory &&
      previous !== null &&
      next !== null &&
      interest.state?.generation === publication.state.generation &&
      interest.state?.incarnation === publication.state.incarnation &&
      previous.cols === next.cols;
    const retainedHistoryCoordinates =
      comparableCapture &&
      previous.history.length <= next.history.length &&
      (previous.history === next.history ||
        previous.history.every((row, index) => terminalReplicaRowsEqual(next.history[index], row)));
    const removedRows = comparableCapture ? previous.history.length - next.history.length : 0;
    const retainedSuffix =
      comparableCapture &&
      removedRows > 0 &&
      next.history.length > 0 &&
      previous.rows === next.rows &&
      previous.modes.alternateScreen === next.modes.alternateScreen &&
      next.grid.every((row, index) => terminalReplicaRowsEqual(previous.grid[index], row)) &&
      next.history.every((row, index) =>
        terminalReplicaRowsEqual(previous.history[index + removedRows], row),
      );
    if (
      interest.retainedView &&
      (!next ||
        interest.retainedView.state.generation !== publication.state.generation ||
        interest.retainedView.state.incarnation !== publication.state.incarnation)
    ) {
      interest.retainedView.capture?.abort();
      delete interest.retainedView;
    }
    // Layout owns native geometry. Parser dimensions may differ (for example,
    // xterm clamps a one-column pane to two). A held copy is independent of
    // live parsing and must keep following the native pane's actual size.
    if (interest.retainedView && next) this.#resizeRetainedView(interest, next);
    interest.state = publication.state;
    // Preserve coordinates for an unchanged prefix or an exact retained suffix.
    // The suffix offset is fixed by the length difference; never search repeated
    // log lines for a guessed overlap. Changed grids/reflow need a separate map.
    if (replacesHistory) {
      if (retainedSuffix) interest.historyTrim += removedRows;
      else if (!retainedHistoryCoordinates) interest.historyTrim = 0;
    } else if (publication.update.type === "terminal.patch")
      interest.historyTrim += publication.update.patch.historyDelta?.trim ?? 0;
    if (publication.update.type !== "terminal.tombstone")
      interest.lastAcceptedUpdateType = publication.update.type;
    const canonicalUpdateSink = currentTuiPerformanceEventSink()?.terminalCanonicalUpdate;
    if (canonicalUpdateSink && publication.update.type === "terminal.patch" && next) {
      try {
        canonicalUpdateSink({
          processId: `opentui:${process.pid}`,
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          atMicros: Math.floor(performance.now() * 1_000),
          updateType: "terminal.patch",
          semanticPaneId: publication.address.semanticPaneId,
          generation: publication.state.generation,
          incarnation: publication.state.incarnation,
          revision: publication.state.revision,
          stateHash: publication.state.hash,
          cols: next.cols,
          rows: next.rows,
          sourceEpoch: this.#sourceEpoch,
        });
      } catch {
        // Opt-in diagnostics never own canonical publication.
      }
    }
    const cursorChanged =
      previous !== null &&
      next !== null &&
      (previous.cursor.x !== next.cursor.x ||
        previous.cursor.y !== next.cursor.y ||
        previous.cursor.hidden !== next.cursor.hidden ||
        previous.cursor.style !== next.cursor.style ||
        previous.cursor.blink !== next.cursor.blink);
    const presentationModeChanged =
      previous !== null &&
      next !== null &&
      (previous.modes.alternateScreen !== next.modes.alternateScreen || cursorChanged);
    if (
      next &&
      (publication.update.type === "terminal.seed" ||
        presentationModeChanged ||
        previous?.modes.wraparound !== next.modes.wraparound ||
        previous?.modes.mouseProtocol !== next.modes.mouseProtocol ||
        previous?.modes.mouseEncoding !== next.modes.mouseEncoding)
    )
      this.#reportCanonicalMode(publication.address.semanticPaneId, publication.state);
    if (this.#causalCellLedger && publication.state.snapshot) {
      try {
        this.#causalCellLedger.noteDelivery({
          semanticPaneId: publication.address.semanticPaneId,
          generation: publication.state.generation,
          incarnation: publication.state.incarnation,
          revision: publication.state.revision,
          stateHash: publication.state.hash,
          snapshot: publication.state.snapshot,
          atMicros: Math.floor(performance.now() * 1_000),
        });
      } catch {
        // Opt-in causal diagnostics never own canonical delivery.
      }
    }
    let changed = false;
    if (next) {
      for (const row of changedTerminalRows(
        previous,
        next,
        publication.update.type === "terminal.seed",
      )) {
        changed = true;
        interest.dirtyRows.add(row);
      }
    } else {
      const rows = previous?.rows ?? 0;
      for (let row = 0; row < rows; row += 1) {
        changed = true;
        interest.dirtyRows.add(row);
      }
    }
    // A trace qualifies only when its controlled next output changes canonical
    // terminal cells. Duplicate/stale/no-op output must never be mistaken for
    // input-to-paint latency merely because some unrelated cursor/chrome row
    // happens to render afterward.
    // Coalesced publications use leading-edge latency semantics: the earliest
    // traced cell change owns the next paint. A later untraced/no-op update
    // cannot erase it; a later traced change coalesced into the same frame is
    // intentionally unmeasured rather than biasing the distribution downward.
    if (changed && publication.paintTrace && interest.pendingTrace === null) {
      interest.pendingTrace = Object.freeze({
        ...publication.paintTrace,
        semanticPaneId: publication.address.semanticPaneId,
        revision: publication.state.revision,
        stateHash: publication.state.hash,
      });
      try {
        currentTuiPerformanceEventSink()?.terminalTraceStage?.({
          traceId: publication.paintTrace.traceId,
          scenario: "terminal-input-to-paint",
          stage: "client",
          operation: "render-invalidated",
          processId: `opentui:${process.pid}`,
          clockId: "opentui-performance-now",
          clockKind: "performance-now",
          atMicros: Math.floor(performance.now() * 1_000),
        });
      } catch {
        // Diagnostics cannot interrupt renderer invalidation.
      }
    }
    const presentationOnly = !changed && presentationModeChanged;
    if (changed) interest.pendingCursorTrace = null;
    else if (presentationOnly && publication.paintTrace) {
      interest.pendingCursorTrace = Object.freeze({
        traceId: interest.pendingCursorTrace?.traceId ?? publication.paintTrace.traceId,
        generation: publication.state.generation,
        incarnation: publication.state.incarnation,
        semanticPaneId: publication.address.semanticPaneId,
        revision: publication.state.revision,
        stateHash: publication.state.hash,
      });
    } else if (interest.pendingCursorTrace) {
      interest.pendingCursorTrace = Object.freeze({
        ...interest.pendingCursorTrace,
        generation: publication.state.generation,
        incarnation: publication.state.incarnation,
        revision: publication.state.revision,
        stateHash: publication.state.hash,
      });
    }
    // Accept and track live canonical delivery above, but only wake a reader
    // when its displayed buffer changes. Release explicitly repaints live state.
    const visibleContentChanged =
      changed && (!interest.retainedView || interest.retainedView.snapshot !== previousRetained);
    const visiblePresentationChanged = presentationOnly && !interest.retainedView;
    if (visibleContentChanged) interest.version += 1;
    else if (visiblePresentationChanged) interest.presentationVersion += 1;
    const frameSink = currentTuiPerformanceEventSink();
    if (
      (changed || presentationOnly || interest.pendingHostFrame) &&
      frameSink?.terminalCanonicalHostFrame &&
      frameSink.terminalFrameFence &&
      next
    ) {
      interest.pendingHostFrame = Object.freeze({
        generation: publication.state.generation,
        incarnation: publication.state.incarnation,
        revision: publication.state.revision,
        stateHash: publication.state.hash,
        cols: next.cols,
        rows: next.rows,
        acceptedUpdateType: interest.lastAcceptedUpdateType ?? "terminal.seed",
        acceptedRevision: publication.state.revision,
      });
    }
    if (!visibleContentChanged && !visiblePresentationChanged) return;
    for (const listener of [...interest.listeners]) {
      try {
        listener(
          interest.version,
          this.#sourceEpoch,
          interest.presentationVersion,
          visibleContentChanged ? "content" : "presentation",
        );
      } catch {
        // A renderer observer cannot prevent sibling invalidation.
      }
    }
  }

  #reportCanonicalMode(paneId: string, state: TerminalFastLanePublication["state"]): void {
    const sink = currentTuiPerformanceEventSink()?.terminalCanonicalMode;
    const snapshot = state.snapshot;
    if (!sink || !snapshot) return;
    const key = [
      state.generation,
      state.incarnation,
      state.revision,
      state.hash,
      snapshot.modes.wraparound,
      snapshot.modes.alternateScreen,
      snapshot.cursor.x,
      snapshot.cursor.y,
      snapshot.cursor.hidden,
      snapshot.cursor.style,
      snapshot.cursor.blink,
      snapshot.modes.mouseProtocol ?? "none",
      snapshot.modes.mouseEncoding ?? "default",
    ].join(":");
    const keys = (this.#canonicalModeKeys ??= new Map());
    if (keys.get(paneId) === key) return;
    keys.set(paneId, key);
    try {
      sink({
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: Math.floor(performance.now() * 1_000),
        semanticPaneId: paneId,
        generation: state.generation,
        incarnation: state.incarnation,
        revision: state.revision,
        stateHash: state.hash,
        alternateScreen: snapshot.modes.alternateScreen,
        cursor: Object.freeze({ ...snapshot.cursor }),
        wraparound: snapshot.modes.wraparound,
        mouseProtocol: snapshot.modes.mouseProtocol ?? "none",
        mouseEncoding: snapshot.modes.mouseEncoding ?? "default",
      });
    } catch {
      // Detailed mode diagnostics never own canonical publication or paint.
    }
  }

  #noteSeedDiagnostic(
    interest: PaneRendererInterest,
    state: TerminalReplicaState,
    semanticPaneId: string,
  ): void {
    const sink = currentTuiPerformanceEventSink()?.terminalCanonicalPublication;
    const snapshot = state.snapshot;
    if (!sink || !snapshot) return;
    const event = Object.freeze({
      processId: `opentui:${process.pid}`,
      clockId: "opentui-performance-now" as const,
      clockKind: "performance-now" as const,
      atMicros: Math.floor(performance.now() * 1_000),
      updateType: "terminal.seed" as const,
      semanticPaneId,
      generation: state.generation,
      incarnation: state.incarnation,
      revision: state.revision,
      stateHash: state.hash,
      cols: snapshot.cols,
      rows: snapshot.rows,
      sourceEpoch: this.#sourceEpoch,
    });
    interest.pendingSeedDiagnostic = event;
    try {
      sink(event);
    } catch {
      // Opt-in diagnostics never own canonical publication.
    }
  }

  #snapshot(paneId: string): TerminalReplicaSnapshot | null {
    const interest = this.#panes.get(paneId);
    return interest?.retainedView?.snapshot ?? interest?.state?.snapshot ?? null;
  }

  #blit(
    paneId: string,
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    options: BlitOptions,
  ): TerminalPaintTrace | null {
    const interest = this.#panes.get(paneId);
    const snapshot = interest?.retainedView?.snapshot ?? interest?.state?.snapshot ?? null;
    if (snapshot === null) {
      // Never replace a formerly coherent framebuffer with semantic blanks
      // merely because retained canonical state is temporarily unavailable.
      // PaneScopedTerminalSurface requests one bounded generation repair; the
      // next seed will mark its exact rows dirty and repaint them normally.
      interest?.dirtyRows.clear();
      return null;
    }
    const seedPaintDiagnostic = currentTuiPerformanceEventSink()?.terminalCanonicalPaint;
    const forced = options.forceRows ? new Set(options.forceRows) : null;
    const full = options.full || scrollOffset > 0 || Boolean(interest?.retainedView);
    let paintedCanonicalChange = false;
    const writtenRows =
      this.#causalCellLedger || (seedPaintDiagnostic && interest?.pendingSeedDiagnostic)
        ? new Set<number>()
        : null;
    const paintedRows = interest ? (interest.paintedRows ??= []) : [];
    const reading = scrollOffset > 0 || Boolean(interest?.retainedView);
    const previousViewport = interest?.projectionViewport;
    const viewport = reading
      ? {
          x: options.viewportOrigin?.x ?? 0,
          y: snapshot.history.length + (options.viewportOrigin?.y ?? -scrollOffset),
          width,
          height,
          consumer: options.consumerId,
        }
      : undefined;
    // A whole-page jump has no overlapping rows. Avoid caching a guaranteed
    // miss-only frame; nearby movement can warm the bounded cache again.
    const jumped =
      previousViewport &&
      viewport &&
      previousViewport.width === width &&
      previousViewport.height === height &&
      previousViewport.consumer === options.consumerId &&
      previousViewport.x === viewport.x &&
      Math.abs(previousViewport.y - viewport.y) >= height;
    if (interest) interest.projectionViewport = viewport;
    const cache =
      interest && reading && !jumped
        ? (interest.rowProjectionCache ??= new TerminalRowProjectionCache())
        : null;
    if (cache)
      cache.configure(width, height, [
        options.consumerId,
        options.viewportOrigin?.x ?? 0,
        defaultFg,
        defaultBg,
        options.palette,
        interest?.state?.generation,
        interest?.state?.incarnation,
        interest?.retainedView?.backingRevision,
      ]);
    else interest?.rowProjectionCache?.clear();
    const blit = cache ? cache.blit.bind(cache) : blitSemanticRow;
    for (let row = 0; row < height; row += 1) {
      const canonicalRow = options.viewportOrigin ? options.viewportOrigin.y + row : row;
      const absoluteRow = snapshot.history.length + canonicalRow;
      const sourceRow = options.viewportOrigin
        ? absoluteRow < snapshot.history.length
          ? snapshot.history[absoluteRow]
          : snapshot.grid[canonicalRow]
        : visibleTerminalRowAt(snapshot, scrollOffset, row);
      // While reading history, live output can invalidate the pane without
      // changing a single visible row. Keep those framebuffer cells untouched.
      if (
        scrollOffset > 0 &&
        !options.full &&
        !forced?.has(row) &&
        row < paintedRows.length &&
        paintedRows[row] === sourceRow
      )
        continue;
      if (!full && !interest?.dirtyRows.has(canonicalRow) && !forced?.has(row)) continue;
      writtenRows?.add(row);
      if (interest?.dirtyRows.has(canonicalRow)) paintedCanonicalChange = true;
      blit(
        sourceRow,
        buffers,
        row,
        width,
        defaultFg,
        defaultBg,
        options.graphemes,
        options.palette,
        options.viewportOrigin?.x ?? 0,
      );
      options.dirtyRows.push(row);
      paintedRows[row] = sourceRow;
    }
    paintedRows.length = height;
    if (interest?.retainedView) return null;
    interest?.dirtyRows.clear();
    const trace =
      paintedCanonicalChange && interest?.pendingTrace && interest.state
        ? Object.freeze({
            // The earliest causal input owns timing; the remaining fields name
            // the exact latest canonical state coalesced into this blit.
            traceId: interest.pendingTrace.traceId,
            generation: interest.state.generation,
            incarnation: interest.state.incarnation,
            semanticPaneId: interest.paneId,
            revision: interest.state.revision,
            stateHash: interest.state.hash,
          })
        : null;
    if (interest && paintedCanonicalChange) {
      this.#paintedCanonicalSnapshot = true;
      interest.pendingTrace = null;
      const seed = interest.pendingSeedDiagnostic;
      interest.pendingSeedDiagnostic = null;
      if (
        seedPaintDiagnostic &&
        seed &&
        writtenRows &&
        seed.generation === interest.state?.generation &&
        seed.incarnation === interest.state.incarnation &&
        seed.revision === interest.state.revision &&
        seed.stateHash === interest.state.hash
      ) {
        try {
          seedPaintDiagnostic({
            processId: seed.processId,
            clockId: seed.clockId,
            clockKind: seed.clockKind,
            atMicros: Math.floor(performance.now() * 1_000),
            semanticPaneId: seed.semanticPaneId,
            generation: seed.generation,
            incarnation: seed.incarnation,
            revision: seed.revision,
            stateHash: seed.stateHash,
            cols: seed.cols,
            rows: seed.rows,
            sourceEpoch: seed.sourceEpoch,
            viewportCols: width,
            viewportRows: height,
            writtenRows: Object.freeze([...writtenRows]),
          });
        } catch {
          // Opt-in diagnostics never own canonical paint.
        }
      }
      if (this.#causalCellLedger && snapshot && writtenRows) {
        try {
          this.#causalCellLedger.notePaint({
            semanticPaneId: paneId,
            generation: interest.state!.generation,
            incarnation: interest.state!.incarnation,
            revision: interest.state!.revision,
            stateHash: interest.state!.hash,
            snapshot,
            viewport: { cols: width, rows: height },
            viewportOrigin: options.viewportOrigin,
            activePaneRect: { x: 0, y: 0, width, height },
            writtenRows,
            scrollOffset,
            atMicros: Math.floor(performance.now() * 1_000),
          });
        } catch {
          // Opt-in causal diagnostics never own canonical paint.
        }
      }
    }
    return trace;
  }

  #acknowledgePresentation(paneId: string, viewportCols: number, viewportRows: number): void {
    const interest = this.#panes.get(paneId);
    const pendingIdentity = interest?.pendingHostFrame;
    if (!interest || interest.retainedView || !pendingIdentity) return;
    interest.pendingHostFrame = null;
    interest.pendingCursorTrace = null;
    (this.#presentedCanonicalKeys ??= new Map()).set(
      paneId,
      [
        pendingIdentity.generation,
        pendingIdentity.incarnation,
        pendingIdentity.revision,
        pendingIdentity.stateHash,
        this.#sourceEpoch,
      ].join(":"),
    );
    const frameSink = currentTuiPerformanceEventSink();
    if (!frameSink?.terminalCanonicalHostFrame || !frameSink.terminalFrameFence) return;
    const identity = Object.freeze({
      processId: `opentui:${process.pid}`,
      clockId: "opentui-performance-now" as const,
      clockKind: "performance-now" as const,
      semanticPaneId: interest.paneId,
      generation: pendingIdentity.generation,
      incarnation: pendingIdentity.incarnation,
      revision: pendingIdentity.revision,
      stateHash: pendingIdentity.stateHash,
      cols: pendingIdentity.cols,
      rows: pendingIdentity.rows,
      sourceEpoch: this.#sourceEpoch,
      viewportCols,
      viewportRows,
      acceptedUpdateType: pendingIdentity.acceptedUpdateType,
      acceptedRevision: pendingIdentity.acceptedRevision,
    });
    const pending = (this.#pendingCanonicalHostFrames ??= new Map());
    if (pending.has(identity.semanticPaneId) || pending.size < 256)
      pending.set(identity.semanticPaneId, identity);
    else this.#droppedCanonicalHostFrames += 1;
  }
}
