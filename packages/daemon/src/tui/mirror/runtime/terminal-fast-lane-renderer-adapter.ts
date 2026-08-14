import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type {
  TerminalFastLane,
  TerminalFastLanePublication,
} from "@tmux-ide/daemon-client/terminal-fast-lane";
import type { TerminalReplicaState } from "@tmux-ide/core";

import type { CellArrays } from "../blit.ts";
import type { BlitOptions, CursorState } from "../pane-mirror.ts";
import type {
  TerminalPaintTrace,
  TerminalPaneRenderSource,
} from "../pane-surface.tsx";
import {
  blitSemanticRow,
  changedTerminalRows,
  visibleTerminalRowAt,
} from "../semantic-pane-render-source.ts";
import type { PaneScopedTerminalAdapter } from "./pane-scoped-terminal-surface.tsx";

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
  #disposed = false;

  readonly renderSource: TerminalPaneRenderSource = {
    scrollbackDepth: (paneId) => this.#snapshot(paneId)?.history.length ?? 0,
    cursorState: (paneId) => {
      const cursor = this.#snapshot(paneId)?.cursor;
      return cursor ? ({ ...cursor } satisfies CursorState) : null;
    },
    blitPane: (paneId, buffers, width, height, scrollOffset, defaultFg, defaultBg, options) =>
      this.#blit(
        paneId,
        buffers,
        width,
        height,
        scrollOffset,
        defaultFg,
        defaultBg,
        options,
      ),
  };

  constructor(lane: TerminalFastLane, sourceEpoch = 1) {
    this.#lane = lane;
    this.#sourceEpoch = sourceEpoch;
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
    const interest: PaneRendererInterest = {
      paneId,
      listeners: new Set(),
      dirtyRows: new Set(),
      release: null,
      state: null,
      version: 0,
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
    interest.pendingTrace = publication.paintTrace ?? null;
    if (next) {
      for (const row of changedTerminalRows(
        previous,
        next,
        publication.update.type === "terminal.seed",
      )) {
        interest.dirtyRows.add(row);
      }
    } else {
      const rows = previous?.rows ?? 0;
      for (let row = 0; row < rows; row += 1) interest.dirtyRows.add(row);
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
    for (let row = 0; row < height; row += 1) {
      if (!full && !interest?.dirtyRows.has(row) && !forced?.has(row)) continue;
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
    const trace = interest?.pendingTrace ?? null;
    if (interest) interest.pendingTrace = null;
    return trace;
  }
}
