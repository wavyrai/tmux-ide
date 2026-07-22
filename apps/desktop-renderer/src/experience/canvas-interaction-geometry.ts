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
): CanvasPoint {
  const normalized = normalizeCanvasTransform(transform);
  return {
    x: point.x * normalized.scale + normalized.x,
    y: point.y * normalized.scale + normalized.y,
  };
}

export function screenToCanvas(
  point: CanvasPoint,
  transform: CanvasViewportTransform,
): CanvasPoint {
  const normalized = normalizeCanvasTransform(transform);
  return {
    x: (point.x - normalized.x) / normalized.scale,
    y: (point.y - normalized.y) / normalized.scale,
  };
}

/** Pan deltas are screen-space so pointer movement remains one-to-one at every zoom. */
export function panCanvasViewport(
  transform: CanvasViewportTransform,
  screenDelta: CanvasPoint,
): CanvasViewportTransform {
  const normalized = normalizeCanvasTransform(transform);
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
  const canvasAnchor = screenToCanvas(screenAnchor, normalized);
  return {
    scale,
    x: screenAnchor.x - canvasAnchor.x * scale,
    y: screenAnchor.y - canvasAnchor.y * scale,
  };
}

export function canvasDeltaFromScreenDelta(
  screenDelta: CanvasPoint,
  transform: CanvasViewportTransform,
): CanvasPoint {
  const scale = normalizeCanvasTransform(transform).scale;
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
