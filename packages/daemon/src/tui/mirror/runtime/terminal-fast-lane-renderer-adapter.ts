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
import type { CausalCellClientLedger } from "./causal-cell-client-ledger.ts";

interface PaneRendererInterest {
  readonly paneId: string;
  readonly listeners: Set<(version: number, sourceEpoch: number) => void>;
  readonly dirtyRows: Set<number>;
  release: (() => void) | null;
  state: TerminalReplicaState | null;
  version: number;
  pendingTrace: TerminalPaintTrace | null;
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
  #disposed = false;
  #paintedCanonicalSnapshot = false;

  readonly renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: (paneId) => this.#snapshot(paneId)?.history.length ?? 0,
    cursorState: (paneId) => {
      const cursor = this.#snapshot(paneId)?.cursor;
      return cursor ? ({ ...cursor } satisfies CursorState) : null;
    },
    blitPane: (paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options) =>
      this.#blit(paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options),
  };

  constructor(
    lane: TerminalFastLane,
    sourceEpoch = 1,
    causalCellLedger: CausalCellClientLedger | null = null,
  ) {
    this.#lane = lane;
    this.#sourceEpoch = sourceEpoch;
    this.#causalCellLedger = causalCellLedger;
  }

  paneVersion(paneId: string): number {
    return this.#panes.get(paneId)?.version ?? 0;
  }

  paneSourceEpoch(): number {
    return this.#sourceEpoch;
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

  subscribePaneVersion(
    paneId: string,
    listener: (version: number, sourceEpoch: number) => void,
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
      listener(interest.version, this.#sourceEpoch);
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
  }

  #interest(paneId: string): PaneRendererInterest {
    const retained = this.#panes.get(paneId);
    if (retained) return retained;
    const state = this.#lane.paneState(paneId);
    const dirtyRows = new Set<number>();
    for (let row = 0; row < (state?.snapshot?.rows ?? 0); row += 1) dirtyRows.add(row);
    const interest: PaneRendererInterest = {
      paneId,
      listeners: new Set(),
      dirtyRows,
      release: null,
      state,
      version: state ? 1 : 0,
      pendingTrace: null,
    };
    this.#panes.set(paneId, interest);
    return interest;
  }

  #publish(interest: PaneRendererInterest, publication: TerminalFastLanePublication): void {
    if (this.#disposed || publication.address.semanticPaneId !== interest.paneId) return;
    const previous = interest.state?.snapshot ?? null;
    const next = publication.state.snapshot;
    interest.state = publication.state;
    const canonicalModeSink = currentTuiPerformanceEventSink()?.terminalCanonicalMode;
    if (canonicalModeSink && next && previous?.modes.wraparound !== next.modes.wraparound) {
      canonicalModeSink({
        processId: `opentui:${process.pid}`,
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: Math.floor(performance.now() * 1_000),
        semanticPaneId: publication.address.semanticPaneId,
        generation: publication.state.generation,
        incarnation: publication.state.incarnation,
        revision: publication.state.revision,
        stateHash: publication.state.hash,
        wraparound: next.modes.wraparound,
      });
    }
    if (this.#causalCellLedger && publication.state.snapshot) {
      this.#causalCellLedger.noteDelivery({
        semanticPaneId: publication.address.semanticPaneId,
        generation: publication.state.generation,
        incarnation: publication.state.incarnation,
        revision: publication.state.revision,
        stateHash: publication.state.hash,
        snapshot: publication.state.snapshot,
        atMicros: Math.floor(performance.now() * 1_000),
      });
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
    }
    interest.version += 1;
    for (const listener of [...interest.listeners]) {
      try {
        listener(interest.version, this.#sourceEpoch);
      } catch {
        // A renderer observer cannot prevent sibling invalidation.
      }
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
    const forced = options.forceRows ? new Set(options.forceRows) : null;
    const full = options.full || scrollOffset > 0 || snapshot === null;
    let paintedCanonicalChange = false;
    const writtenRows = this.#causalCellLedger ? new Set<number>() : null;
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
      if (this.#causalCellLedger && snapshot && writtenRows) {
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
      }
    }
    return trace;
  }
}
