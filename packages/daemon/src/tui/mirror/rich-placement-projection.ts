import type {
  TerminalReplicaPlacement,
  TerminalReplicaSnapshot,
  WidgetMarker,
} from "@tmux-ide/contracts";

/** A rectangle in canonical terminal-cell coordinates. */
export interface TerminalCellRect {
  readonly row: number;
  readonly column: number;
  readonly rows: number;
  readonly columns: number;
}

/**
 * The visible portion of a terminal replica. The origin permits future
 * scroll/crop hosts without changing placement identity or projection rules.
 */
export type RichPlacementViewport = TerminalCellRect;

/** Geometry suitable for an absolutely positioned host renderable. */
export interface RichPlacementHostRect {
  readonly top: number;
  readonly left: number;
  readonly height: number;
  readonly width: number;
}

export interface RichPlacementClipping {
  readonly top: boolean;
  readonly right: boolean;
  readonly bottom: boolean;
  readonly left: boolean;
}

/**
 * Semantic delivery currently authenticates placement identity and geometry,
 * but does not carry the widget payload itself. Keep that limitation typed so
 * hosts can render a capability-honest fallback instead of inventing content.
 */
export interface RichPlacementFallbackMetadata {
  readonly kind: "authenticated-content-unavailable";
  readonly widgetId: string;
  readonly placementKind: string;
  readonly contentDigest: string;
}

export interface RichPlacementProjection {
  /** Stable across content, geometry and viewport changes. */
  readonly renderableId: string;
  readonly paneId: string;
  readonly placementId: string;
  readonly placement: TerminalReplicaPlacement;
  /** Canonical clipped rectangle, or null when wholly outside the viewport. */
  readonly clipped: TerminalCellRect | null;
  /** Viewport-local OpenTUI coordinates, or null when not visible. */
  readonly hostRect: RichPlacementHostRect | null;
  readonly clipping: RichPlacementClipping;
  readonly visible: boolean;
  /** Adapter for the existing typed widget-fallback resolver. */
  readonly marker: WidgetMarker;
  readonly fallback: RichPlacementFallbackMetadata;
}

/**
 * Project every canonical rich placement into a bounded host viewport.
 *
 * The array retains canonical order. `renderableId` deliberately excludes the
 * digest and rectangle, allowing OpenTUI to retain the same renderable when
 * content updates or tmux resizes it. Duplicate protocol ids are disambiguated
 * by their stable occurrence within that id group.
 */
export function projectRichPlacements(
  paneId: string,
  placements: readonly TerminalReplicaPlacement[],
  viewport: RichPlacementViewport,
): readonly RichPlacementProjection[] {
  const occurrenceById = new Map<string, number>();
  return placements.map((placement) => {
    const occurrence = occurrenceById.get(placement.id) ?? 0;
    occurrenceById.set(placement.id, occurrence + 1);
    return projectRichPlacement(paneId, placement, viewport, occurrence);
  });
}

/** Convenience projection for the full current terminal grid. */
export function projectSnapshotRichPlacements(
  paneId: string,
  snapshot: Pick<TerminalReplicaSnapshot, "cols" | "rows" | "placements">,
  viewport: RichPlacementViewport = {
    row: 0,
    column: 0,
    rows: snapshot.rows,
    columns: snapshot.cols,
  },
): readonly RichPlacementProjection[] {
  return projectRichPlacements(paneId, snapshot.placements, viewport);
}

function projectRichPlacement(
  paneId: string,
  placement: TerminalReplicaPlacement,
  viewport: RichPlacementViewport,
  occurrence: number,
): RichPlacementProjection {
  const clipped = intersection(placement, viewport);
  const marker: WidgetMarker = Object.freeze({
    id: placement.id,
    args: Object.freeze({ semanticPlacement: Object.freeze({ ...placement }) }),
    lineIndex: placement.row,
  });
  const fallback: RichPlacementFallbackMetadata = Object.freeze({
    kind: "authenticated-content-unavailable",
    widgetId: placement.id,
    placementKind: placement.kind,
    contentDigest: placement.contentDigest,
  });

  return Object.freeze({
    renderableId: placementRenderableId(paneId, placement.id, occurrence),
    paneId,
    placementId: placement.id,
    placement,
    clipped,
    hostRect:
      clipped === null
        ? null
        : Object.freeze({
            top: clipped.row - viewport.row,
            left: clipped.column - viewport.column,
            height: clipped.rows,
            width: clipped.columns,
          }),
    clipping: Object.freeze({
      top: placement.row < viewport.row,
      right:
        rectEnd(placement.column, placement.columns) > rectEnd(viewport.column, viewport.columns),
      bottom: rectEnd(placement.row, placement.rows) > rectEnd(viewport.row, viewport.rows),
      left: placement.column < viewport.column,
    }),
    visible: clipped !== null,
    marker,
    fallback,
  });
}

function placementRenderableId(paneId: string, placementId: string, occurrence: number): string {
  // Length prefixes make this collision-free even when ids contain separators.
  return `rich-placement:${paneId.length}:${paneId}:${placementId.length}:${placementId}:${occurrence}`;
}

function intersection(
  placement: TerminalReplicaPlacement,
  viewport: RichPlacementViewport,
): TerminalCellRect | null {
  const row = Math.max(placement.row, viewport.row);
  const column = Math.max(placement.column, viewport.column);
  const endRow = Math.min(
    rectEnd(placement.row, placement.rows),
    rectEnd(viewport.row, viewport.rows),
  );
  const endColumn = Math.min(
    rectEnd(placement.column, placement.columns),
    rectEnd(viewport.column, viewport.columns),
  );
  if (endRow <= row || endColumn <= column) return null;
  return Object.freeze({ row, column, rows: endRow - row, columns: endColumn - column });
}

function rectEnd(origin: number, length: number): number {
  const end = origin + length;
  return Number.isSafeInteger(end) ? end : Number.MAX_SAFE_INTEGER;
}
