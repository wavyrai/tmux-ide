export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasRect extends CanvasPoint {
  readonly width: number;
  readonly height: number;
}

export interface CanvasViewportTransform {
  /** Screen-space translation of the canvas origin. */
  readonly x: number;
  readonly y: number;
  /** Screen pixels per canvas unit. */
  readonly scale: number;
}

export interface CanvasScaleRange {
  readonly min: number;
  readonly max: number;
}

export interface CanvasGrid {
  readonly size: number;
  readonly origin?: CanvasPoint;
}

export interface CanvasRectConstraints {
  readonly minWidth: number;
  readonly minHeight: number;
  /** Optional finite canvas-space bounds. Omit for an infinite canvas. */
  readonly bounds?: CanvasRect;
  readonly grid?: CanvasGrid;
}

export type CanvasResizeEdge =
  | "north"
  | "north-east"
  | "east"
  | "south-east"
  | "south"
  | "south-west"
  | "west"
  | "north-west";

const DEFAULT_SCALE_RANGE: CanvasScaleRange = { min: 0.25, max: 4 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeRange(range: CanvasScaleRange): CanvasScaleRange {
  const min = positive(range.min, DEFAULT_SCALE_RANGE.min);
  const max = Math.max(min, positive(range.max, DEFAULT_SCALE_RANGE.max));
  return { min, max };
}

export function normalizeCanvasTransform(
  transform: CanvasViewportTransform,
  range: CanvasScaleRange = DEFAULT_SCALE_RANGE,
): CanvasViewportTransform {
  const normalizedRange = normalizeRange(range);
  return {
    x: finite(transform.x, 0),
    y: finite(transform.y, 0),
    scale: clamp(positive(transform.scale, 1), normalizedRange.min, normalizedRange.max),
  };
}

export function canvasToScreen(
  point: CanvasPoint,
  transform: CanvasViewportTransform,
  range: CanvasScaleRange = DEFAULT_SCALE_RANGE,
): CanvasPoint {
  const normalized = normalizeCanvasTransform(transform, range);
  return {
    x: point.x * normalized.scale + normalized.x,
    y: point.y * normalized.scale + normalized.y,
  };
}

export function screenToCanvas(
  point: CanvasPoint,
  transform: CanvasViewportTransform,
  range: CanvasScaleRange = DEFAULT_SCALE_RANGE,
): CanvasPoint {
  const normalized = normalizeCanvasTransform(transform, range);
  return {
    x: (point.x - normalized.x) / normalized.scale,
    y: (point.y - normalized.y) / normalized.scale,
  };
}

/** Pan deltas are screen-space so pointer movement remains one-to-one at every zoom. */
export function panCanvasViewport(
  transform: CanvasViewportTransform,
  screenDelta: CanvasPoint,
  range: CanvasScaleRange = DEFAULT_SCALE_RANGE,
): CanvasViewportTransform {
  const normalized = normalizeCanvasTransform(transform, range);
  return {
    ...normalized,
    x: normalized.x + finite(screenDelta.x, 0),
    y: normalized.y + finite(screenDelta.y, 0),
  };
}

/** Zoom while keeping the canvas coordinate beneath `screenAnchor` fixed. */
export function zoomCanvasViewportAt(
  transform: CanvasViewportTransform,
  requestedScale: number,
  screenAnchor: CanvasPoint,
  range: CanvasScaleRange = DEFAULT_SCALE_RANGE,
): CanvasViewportTransform {
  const normalized = normalizeCanvasTransform(transform, range);
  const normalizedRange = normalizeRange(range);
  const scale = clamp(
    positive(requestedScale, normalized.scale),
    normalizedRange.min,
    normalizedRange.max,
  );
  const canvasAnchor = screenToCanvas(screenAnchor, normalized, normalizedRange);
  return {
    scale,
    x: screenAnchor.x - canvasAnchor.x * scale,
    y: screenAnchor.y - canvasAnchor.y * scale,
  };
}

export function canvasDeltaFromScreenDelta(
  screenDelta: CanvasPoint,
  transform: CanvasViewportTransform,
  range: CanvasScaleRange = DEFAULT_SCALE_RANGE,
): CanvasPoint {
  const scale = normalizeCanvasTransform(transform, range).scale;
  return { x: finite(screenDelta.x, 0) / scale, y: finite(screenDelta.y, 0) / scale };
}

function snap(value: number, grid: CanvasGrid | undefined, axis: "x" | "y"): number {
  if (!grid || !Number.isFinite(grid.size) || grid.size <= 0) return value;
  const origin = finite(grid.origin?.[axis] ?? 0, 0);
  return origin + Math.round((value - origin) / grid.size) * grid.size;
}

function normalizedConstraints(constraints: CanvasRectConstraints): CanvasRectConstraints {
  return {
    minWidth: positive(constraints.minWidth, 1),
    minHeight: positive(constraints.minHeight, 1),
    bounds: constraints.bounds,
    grid: constraints.grid,
  };
}

function clampPosition(position: number, extent: number, start: number, available: number): number {
  if (extent >= available) return start;
  return clamp(position, start, start + available - extent);
}

/** Snap and clamp a translated rect without changing its size. */
export function moveCanvasRect(
  rect: CanvasRect,
  delta: CanvasPoint,
  requestedConstraints: CanvasRectConstraints,
): CanvasRect {
  const constraints = normalizedConstraints(requestedConstraints);
  let x = snap(rect.x + finite(delta.x, 0), constraints.grid, "x");
  let y = snap(rect.y + finite(delta.y, 0), constraints.grid, "y");
  if (constraints.bounds) {
    x = clampPosition(x, rect.width, constraints.bounds.x, constraints.bounds.width);
    y = clampPosition(y, rect.height, constraints.bounds.y, constraints.bounds.height);
  }
  return { ...rect, x, y };
}

function edgeDirections(edge: CanvasResizeEdge): {
  readonly north: boolean;
  readonly east: boolean;
  readonly south: boolean;
  readonly west: boolean;
} {
  return {
    north: edge.startsWith("north"),
    east: edge.endsWith("east"),
    south: edge.startsWith("south"),
    west: edge.endsWith("west"),
  };
}

/** Resize from one edge/corner while keeping the opposite edges anchored. */
export function resizeCanvasRect(
  rect: CanvasRect,
  edge: CanvasResizeEdge,
  delta: CanvasPoint,
  requestedConstraints: CanvasRectConstraints,
): CanvasRect {
  const constraints = normalizedConstraints(requestedConstraints);
  const directions = edgeDirections(edge);
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (directions.west) left = snap(left + finite(delta.x, 0), constraints.grid, "x");
  if (directions.east) right = snap(right + finite(delta.x, 0), constraints.grid, "x");
  if (directions.north) top = snap(top + finite(delta.y, 0), constraints.grid, "y");
  if (directions.south) bottom = snap(bottom + finite(delta.y, 0), constraints.grid, "y");

  const minWidth = constraints.bounds
    ? Math.min(constraints.minWidth, constraints.bounds.width)
    : constraints.minWidth;
  const minHeight = constraints.bounds
    ? Math.min(constraints.minHeight, constraints.bounds.height)
    : constraints.minHeight;

  if (directions.west) left = Math.min(left, right - minWidth);
  if (directions.east) right = Math.max(right, left + minWidth);
  if (directions.north) top = Math.min(top, bottom - minHeight);
  if (directions.south) bottom = Math.max(bottom, top + minHeight);

  if (constraints.bounds) {
    const boundsRight = constraints.bounds.x + constraints.bounds.width;
    const boundsBottom = constraints.bounds.y + constraints.bounds.height;
    if (directions.west) left = clamp(left, constraints.bounds.x, right - minWidth);
    if (directions.east) right = clamp(right, left + minWidth, boundsRight);
    if (directions.north) top = clamp(top, constraints.bounds.y, bottom - minHeight);
    if (directions.south) bottom = clamp(bottom, top + minHeight, boundsBottom);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function canvasRectsEqual(left: CanvasRect, right: CanvasRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Smallest canvas-space rectangle containing every supplied rectangle. */
export function canvasRectBounds(rects: readonly CanvasRect[]): CanvasRect | null {
  if (rects.length === 0) return null;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    const x = finite(rect.x, 0);
    const y = finite(rect.y, 0);
    const width = Math.max(0, finite(rect.width, 0));
    const height = Math.max(0, finite(rect.height, 0));
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Fit canvas content into a screen-space viewport while preserving its center. */
export function fitCanvasViewport(
  rects: readonly CanvasRect[],
  viewport: { readonly width: number; readonly height: number },
  options: {
    readonly padding?: number;
    readonly scaleRange?: CanvasScaleRange;
  } = {},
): CanvasViewportTransform {
  const bounds = canvasRectBounds(rects);
  if (!bounds) return normalizeCanvasTransform({ x: 0, y: 0, scale: 1 }, options.scaleRange);
  const width = Math.max(0, finite(viewport.width, 0));
  const height = Math.max(0, finite(viewport.height, 0));
  const padding = Math.max(0, finite(options.padding ?? 48, 48));
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const requestedScale = Math.min(
    bounds.width > 0 ? availableWidth / bounds.width : 1,
    bounds.height > 0 ? availableHeight / bounds.height : 1,
  );
  const normalized = normalizeCanvasTransform(
    { x: 0, y: 0, scale: requestedScale },
    options.scaleRange,
  );
  return {
    scale: normalized.scale,
    x: width / 2 - (bounds.x + bounds.width / 2) * normalized.scale,
    y: height / 2 - (bounds.y + bounds.height / 2) * normalized.scale,
  };
}
