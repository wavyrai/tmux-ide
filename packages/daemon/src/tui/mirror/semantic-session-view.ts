import type { ApplicationShellTerminalInventory, PaneStreamServerFrame } from "@tmux-ide/contracts";
import type { SessionPaneDescriptor } from "../../terminal/protocol/session-descriptor-discovery.ts";

import type { MirrorSnapshot } from "./pane-mirror.ts";
import type { TerminalPaletteProjection } from "./theme.ts";
import type {
  SemanticPaneCanonicalSnapshot,
  SemanticTerminalRenderSource,
  TerminalCellSearchMatch,
  TerminalCellTextRow,
} from "./semantic-pane-render-source.ts";
import {
  projectSnapshotRichPlacements,
  type RichPlacementProjection,
  type RichPlacementViewport,
} from "./rich-placement-projection.ts";

export interface LivePane {
  readonly id: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly active: boolean;
  readonly appMouse: boolean;
  readonly zoomed: boolean;
  readonly snapshot: MirrorSnapshot;
  readonly scrollbackDepth: number;
  readonly version: number;
}

interface WindowTab {
  index: number;
  name: string;
  active: boolean;
  sync: boolean;
}

export interface SemanticSessionViewOptions {
  readonly target: string;
  readonly onDirty?: () => void;
  readonly onFocusChanged?: (paneId: string, source: "local" | "tmux") => void;
  readonly onStatus?: (message: string) => void;
  readonly onExit?: () => void;
}

/**
 * Renderer-local projection of daemon-owned SessionRuntime state.
 *
 * It owns no tmux process, commands, input, focus mutation, or geometry. The
 * semantic lane supplies canonical terminal replicas and session layouts; this
 * class only adapts them to the existing retained OpenTUI view model while the
 * remaining legacy UI helpers are deleted.
 */
export class SemanticSessionView {
  readonly #options: SemanticSessionViewOptions;
  #source: SemanticTerminalRenderSource | null = null;
  #inventoryDescriptors: SessionPaneDescriptor[] = [];
  #runtimeDescriptors: SessionPaneDescriptor[] = [];
  #runtimeAuthorityGeneration: string | null = null;
  #layouts = new Map<string, Extract<PaneStreamServerFrame, { type: "layout" }>>();
  #focused = "";
  #richPlacementCache = new Map<
    string,
    { key: string; placements: readonly RichPlacementProjection[] }
  >();

  constructor(options: SemanticSessionViewOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    this.#options.onStatus?.("semantic runtime ready");
  }

  setSource(source: SemanticTerminalRenderSource): void {
    this.#source = source;
    this.#options.onDirty?.();
  }

  setInventory(inventory: ApplicationShellTerminalInventory): void {
    this.#inventoryDescriptors = inventory.resources
      .filter((resource) => resource.attachability.status === "available")
      .map((resource) => ({
        runtimePaneId: resource.id,
        semanticPaneId:
          resource.attachability.status === "available"
            ? resource.attachability.semanticPaneId
            : null,
        role: resource.kind === "agent" ? "agent" : null,
        type: resource.kind,
        currentCommand: null,
        cwd: null,
        title: resource.title,
        windowIndex: null,
        windowName: null,
        windowId: resource.windowResourceId ?? null,
      }));
    if (this.#inventoryDescriptors.length === 0) {
      this.#runtimeAuthorityGeneration = null;
      this.#runtimeDescriptors = [];
    }
    const active = inventory.activeResourceId ?? "";
    this.#focused = active;
    this.#options.onDirty?.();
  }

  /** Begin one physical semantic-lane authority generation, retiring every old raw join. */
  setRuntimeAuthorityGeneration(generation: string): void {
    if (generation === this.#runtimeAuthorityGeneration) return;
    this.#runtimeAuthorityGeneration = generation;
    this.#runtimeDescriptors = [];
    this.#options.onDirty?.();
  }

  /** Retire local raw identity before an empty inventory, disconnect, or reconnect. */
  retireRuntimeAuthority(): void {
    if (this.#runtimeAuthorityGeneration === null && this.#runtimeDescriptors.length === 0) return;
    this.#runtimeAuthorityGeneration = null;
    this.#runtimeDescriptors = [];
    this.#options.onDirty?.();
  }

  /** Accept process-local tmux identity proof only for the live physical authority. */
  setRuntimeDescriptors(
    authorityGeneration: string,
    descriptors: readonly SessionPaneDescriptor[],
  ): boolean {
    if (authorityGeneration !== this.#runtimeAuthorityGeneration) return false;
    this.#runtimeDescriptors = descriptors
      .filter(
        (descriptor) =>
          /^%[0-9]+$/u.test(descriptor.runtimePaneId) && descriptor.semanticPaneId !== null,
      )
      .map((descriptor) => ({ ...descriptor }));
    this.#options.onDirty?.();
    return true;
  }

  acceptLayout(frame: Extract<PaneStreamServerFrame, { type: "layout" }>): void {
    const key = frame.semanticWindowId ?? `unverified:${frame.windowName ?? "window"}`;
    this.#layouts.set(key, frame);
    const activePane = frame.panes.find((pane) => pane.active)?.pane;
    if (frame.currentWindow && activePane) {
      this.#focused = activePane;
      this.#options.onFocusChanged?.(activePane, "tmux");
    }
    this.#options.onDirty?.();
  }

  paneDescriptors(): SessionPaneDescriptor[] {
    const runtimeBySemantic = new Map<string, SessionPaneDescriptor[]>();
    for (const descriptor of this.#runtimeDescriptors) {
      const semanticPaneId = descriptor.semanticPaneId!;
      runtimeBySemantic.set(semanticPaneId, [
        ...(runtimeBySemantic.get(semanticPaneId) ?? []),
        descriptor,
      ]);
    }
    return this.#inventoryDescriptors.map((descriptor) => ({
      ...(descriptor.semanticPaneId
        ? runtimeBySemantic.get(descriptor.semanticPaneId)?.length === 1
          ? runtimeBySemantic.get(descriptor.semanticPaneId)![0]!
          : descriptor
        : descriptor),
    }));
  }

  panes(
    scrollOffsets: ReadonlyMap<string, number>,
    _styledRows: boolean,
    _palette: TerminalPaletteProjection,
  ): LivePane[] {
    const layout = [...this.#layouts.values()].find((candidate) => candidate.currentWindow);
    if (!layout) return [];
    return layout.panes.flatMap((pane) => {
      if (!pane.pane) return [];
      const replica = this.#source?.replica(pane.pane) ?? null;
      const cursor = replica?.cursorState() ?? {
        x: 0,
        y: 0,
        hidden: true,
        style: "block" as const,
        blink: false,
      };
      const scrollbackDepth = replica?.scrollbackDepth() ?? 0;
      const scrollOffset = Math.min(scrollOffsets.get(pane.pane) ?? 0, scrollbackDepth);
      return [
        {
          id: pane.pane,
          left: pane.left,
          top: pane.top,
          width: pane.width,
          height: pane.height,
          active: pane.active,
          appMouse: replica?.snapshot?.modes.mouseTracking ?? false,
          zoomed: layout.zoomed,
          snapshot: {
            rows: _styledRows
              ? (replica?.visibleRowTexts(scrollOffset) ?? []).map((text) => [
                  { text, fg: null, bg: null, attributes: 0 },
                ])
              : [],
            cursorX: cursor.x,
            cursorY: cursor.y,
            scrollOffset,
          },
          scrollbackDepth,
          version: replica?.version ?? 0,
        },
      ];
    });
  }

  focus(paneId: string): void {
    this.#focused = paneId;
    this.#options.onFocusChanged?.(paneId, "local");
  }

  focusedPane(): string {
    return this.#focused;
  }

  scrollbackDepth(paneId: string): number {
    return this.#source?.replica(paneId)?.scrollbackDepth() ?? 0;
  }

  lineTrim(paneId: string): number {
    return this.#source?.replica(paneId)?.lineTrim() ?? 0;
  }

  bufferLines(paneId: string): string[] {
    return this.#source?.replica(paneId)?.bufferLines() ?? [];
  }

  bufferTextRows(paneId: string): TerminalCellTextRow[] {
    return this.#source?.replica(paneId)?.bufferTextRows() ?? [];
  }

  visibleRowTexts(paneId: string, scrollOffset = 0): string[] {
    return this.#source?.replica(paneId)?.visibleRowTexts(scrollOffset) ?? [];
  }

  visibleTextRows(paneId: string, scrollOffset = 0): TerminalCellTextRow[] {
    return this.#source?.replica(paneId)?.visibleTextRows(scrollOffset) ?? [];
  }

  findTextMatches(paneId: string, query: string): TerminalCellSearchMatch[] {
    return this.#source?.replica(paneId)?.findTextMatches(query) ?? [];
  }

  extractText(
    paneId: string,
    start: { row: number; col: number },
    end: { row: number; col: number },
    maxBytes: number,
  ): string {
    return this.#source?.replica(paneId)?.extractText(start, end, maxBytes) ?? "";
  }

  richPlacements(
    paneId: string,
    viewport: RichPlacementViewport,
  ): readonly RichPlacementProjection[] {
    const snapshot = this.#source?.replica(paneId)?.snapshot;
    if (!snapshot || snapshot.placements.length === 0) {
      this.#richPlacementCache.delete(paneId);
      return [];
    }
    const key = JSON.stringify([
      viewport,
      snapshot.placements.map((placement) => [
        placement.id,
        placement.kind,
        placement.row,
        placement.column,
        placement.rows,
        placement.columns,
        placement.contentDigest,
      ]),
    ]);
    const cached = this.#richPlacementCache.get(paneId);
    if (cached?.key === key) return cached.placements;
    const placements = projectSnapshotRichPlacements(paneId, snapshot, viewport);
    this.#richPlacementCache.set(paneId, { key, placements });
    return placements;
  }

  /** Retained canonical input for the deferred rich-preview feature. */
  canonicalSnapshot(paneId: string): SemanticPaneCanonicalSnapshot | null {
    return this.#source?.canonicalSnapshot(paneId) ?? null;
  }

  windowSize(): { cols: number; rows: number } | null {
    const layout = [...this.#layouts.values()].find((candidate) => candidate.currentWindow);
    return layout ? { cols: layout.cols, rows: layout.rows } : null;
  }

  async windows(): Promise<WindowTab[]> {
    return [...this.#layouts.values()].map((layout, index) => ({
      index,
      name: layout.windowName ?? `Window ${index + 1}`,
      active: layout.currentWindow,
      sync: false,
    }));
  }

  dispose(): void {
    this.#layouts.clear();
    this.#source = null;
    this.#inventoryDescriptors = [];
    this.#runtimeDescriptors = [];
    this.#runtimeAuthorityGeneration = null;
    this.#richPlacementCache.clear();
  }
}
