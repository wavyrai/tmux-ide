import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type {
  TerminalFastLane,
  TerminalFastLanePublication,
} from "@tmux-ide/daemon-client/terminal-fast-lane";
import type { TerminalReplicaState } from "@tmux-ide/core";

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

interface PaneRendererInterest {
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
    scrollbackDepth: (paneId) => this.#snapshot(paneId)?.history.length ?? 0,
    cursorState: (paneId) => {
      const cursor = this.#snapshot(paneId)?.cursor;
      return cursor ? ({ ...cursor } satisfies CursorState) : null;
    },
    blitPane: (paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options) =>
      this.#blit(paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options),
    paneCanonicalIdentity: (paneId) => this.paneCanonicalIdentity(paneId),
    cursorPresentationTrace: (paneId) => this.#panes.get(paneId)?.pendingCursorTrace ?? null,
    acknowledgePresentation: (paneId, viewportCols, viewportRows) =>
      this.#acknowledgePresentation(paneId, viewportCols, viewportRows),
  };

  constructor(
    lane: TerminalFastLane,
    sourceEpoch = 1,
    causalCellLedger: CausalCellClientLedger | null = null,
    resourceSampler: OpenTuiTerminalResourceSampler | null = null,
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

  paneSelectionSnapshot(paneId: string): TerminalReplicaSnapshot | null {
    return (
      this.#panes.get(paneId)?.state?.snapshot ?? this.#lane.paneState(paneId)?.snapshot ?? null
    );
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
      interest.release?.();
      this.#panes.delete(paneId);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const interest of this.#panes.values()) interest.release?.();
    this.#panes.clear();
    this.#pendingCanonicalHostFrames = null;
    this.#seenCanonicalHostFrameKeys = null;
    this.#canonicalModeKeys = null;
    this.#presentedCanonicalKeys = null;
    this.#droppedCanonicalHostFrames = 0;
  }

  paneCanonicalIdentity(paneId: string) {
    const state = this.#panes.get(paneId)?.state ?? this.#lane.paneState(paneId);
    const snapshot = state?.snapshot;
    if (!state || !snapshot) return null;
    return {
      generation: state.generation,
      incarnation: state.incarnation,
      revision: state.revision,
      stateHash: state.hash,
      cols: snapshot.cols,
      rows: snapshot.rows,
      sourceEpoch: this.#sourceEpoch,
      historyTrim: this.#panes.get(paneId)?.historyTrim ?? 0,
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
    const next = publication.state.snapshot;
    if (publication.update.type !== "terminal.seed") interest.pendingSeedDiagnostic = null;
    else if (next)
      this.#noteSeedDiagnostic(interest, publication.state, publication.address.semanticPaneId);
    interest.state = publication.state;
    if (publication.update.type === "terminal.seed") interest.historyTrim = 0;
    else if (publication.update.type === "terminal.patch")
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
    if (changed) interest.version += 1;
    else if (presentationOnly) interest.presentationVersion += 1;
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
    if (!changed && !presentationOnly) return;
    for (const listener of [...interest.listeners]) {
      try {
        listener(
          interest.version,
          this.#sourceEpoch,
          interest.presentationVersion,
          changed ? "content" : "presentation",
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
    return this.#panes.get(paneId)?.state?.snapshot ?? null;
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
    const snapshot = interest?.state?.snapshot ?? null;
    const seedPaintDiagnostic = currentTuiPerformanceEventSink()?.terminalCanonicalPaint;
    const forced = options.forceRows ? new Set(options.forceRows) : null;
    const full = options.full || scrollOffset > 0 || snapshot === null;
    let paintedCanonicalChange = false;
    const writtenRows =
      this.#causalCellLedger || (seedPaintDiagnostic && interest?.pendingSeedDiagnostic)
        ? new Set<number>()
        : null;
    for (let row = 0; row < height; row += 1) {
      if (!full && !interest?.dirtyRows.has(row) && !forced?.has(row)) continue;
      writtenRows?.add(row);
      if (interest?.dirtyRows.has(row)) paintedCanonicalChange = true;
      blitSemanticRow(
        visibleTerminalRowAt(snapshot, scrollOffset, row),
        buffers,
        row,
        width,
        defaultFg,
        defaultBg,
        options.graphemes,
        options.palette,
      );
      options.dirtyRows.push(row);
    }
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
    if (!interest || !pendingIdentity) return;
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
