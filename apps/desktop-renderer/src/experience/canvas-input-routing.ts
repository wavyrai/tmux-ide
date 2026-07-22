import type { CanvasRect, CanvasResizeEdge } from "./canvas-interaction-geometry.ts";

export interface CanvasResizeHitTarget {
  readonly edge: CanvasResizeEdge;
  readonly cursor: "ns-resize" | "nesw-resize" | "ew-resize" | "nwse-resize";
  /** Transparent pointer target. */
  readonly hitRect: CanvasRect;
  /** Visible border segment, intentionally much thinner than hitRect. */
  readonly edgeRect: CanvasRect;
}

export interface CanvasResizeHitTargetOptions {
  readonly hitSlop?: number;
  readonly edgeThickness?: number;
  readonly cornerSpan?: number;
}

/** Model eight wide, transparent resize targets independently from painted borders. */
export function canvasResizeHitTargets(
  rect: CanvasRect,
  options: CanvasResizeHitTargetOptions = {},
): readonly CanvasResizeHitTarget[] {
  const hitSlop = Math.max(1, options.hitSlop ?? 8);
  const edgeThickness = Math.max(1, options.edgeThickness ?? 1);
  const cornerSpan = Math.max(hitSlop * 2, options.cornerSpan ?? 24);
  const horizontalSpan = Math.max(0, rect.width - cornerSpan * 2);
  const verticalSpan = Math.max(0, rect.height - cornerSpan * 2);
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const fullHit = hitSlop * 2;

  return [
    {
      edge: "north-west",
      cursor: "nwse-resize",
      hitRect: {
        x: left - hitSlop,
        y: top - hitSlop,
        width: cornerSpan + hitSlop,
        height: cornerSpan + hitSlop,
      },
      edgeRect: { x: left, y: top, width: edgeThickness, height: edgeThickness },
    },
    {
      edge: "north",
      cursor: "ns-resize",
      hitRect: { x: left + cornerSpan, y: top - hitSlop, width: horizontalSpan, height: fullHit },
      edgeRect: { x: left + cornerSpan, y: top, width: horizontalSpan, height: edgeThickness },
    },
    {
      edge: "north-east",
      cursor: "nesw-resize",
      hitRect: {
        x: right - cornerSpan,
        y: top - hitSlop,
        width: cornerSpan + hitSlop,
        height: cornerSpan + hitSlop,
      },
      edgeRect: { x: right - edgeThickness, y: top, width: edgeThickness, height: edgeThickness },
    },
    {
      edge: "east",
      cursor: "ew-resize",
      hitRect: { x: right - hitSlop, y: top + cornerSpan, width: fullHit, height: verticalSpan },
      edgeRect: {
        x: right - edgeThickness,
        y: top + cornerSpan,
        width: edgeThickness,
        height: verticalSpan,
      },
    },
    {
      edge: "south-east",
      cursor: "nwse-resize",
      hitRect: {
        x: right - cornerSpan,
        y: bottom - cornerSpan,
        width: cornerSpan + hitSlop,
        height: cornerSpan + hitSlop,
      },
      edgeRect: {
        x: right - edgeThickness,
        y: bottom - edgeThickness,
        width: edgeThickness,
        height: edgeThickness,
      },
    },
    {
      edge: "south",
      cursor: "ns-resize",
      hitRect: {
        x: left + cornerSpan,
        y: bottom - hitSlop,
        width: horizontalSpan,
        height: fullHit,
      },
      edgeRect: {
        x: left + cornerSpan,
        y: bottom - edgeThickness,
        width: horizontalSpan,
        height: edgeThickness,
      },
    },
    {
      edge: "south-west",
      cursor: "nesw-resize",
      hitRect: {
        x: left - hitSlop,
        y: bottom - cornerSpan,
        width: cornerSpan + hitSlop,
        height: cornerSpan + hitSlop,
      },
      edgeRect: { x: left, y: bottom - edgeThickness, width: edgeThickness, height: edgeThickness },
    },
    {
      edge: "west",
      cursor: "ew-resize",
      hitRect: { x: left - hitSlop, y: top + cornerSpan, width: fullHit, height: verticalSpan },
      edgeRect: { x: left, y: top + cornerSpan, width: edgeThickness, height: verticalSpan },
    },
  ];
}

export type CanvasPointerRegion =
  | { readonly kind: "canvas" }
  | { readonly kind: "terminal"; readonly windowId: string }
  | { readonly kind: "window-content"; readonly windowId: string }
  | {
      readonly kind: "window-header";
      readonly windowId: string;
      readonly interactiveControl: boolean;
    }
  | { readonly kind: "resize-handle"; readonly windowId: string; readonly edge: CanvasResizeEdge };

export interface CanvasPointerRoutingInput {
  readonly region: CanvasPointerRegion;
  readonly button: number;
  readonly spaceKey: boolean;
}

export type CanvasPointerRoute =
  | { readonly action: "ignore"; readonly claimPointer: false; readonly focusWindowId: null }
  | { readonly action: "clear-focus"; readonly claimPointer: false; readonly focusWindowId: null }
  | {
      readonly action: "terminal-input";
      readonly claimPointer: false;
      readonly focusWindowId: string;
    }
  | { readonly action: "focus"; readonly claimPointer: false; readonly focusWindowId: string }
  | { readonly action: "pan"; readonly claimPointer: true; readonly focusWindowId: null }
  | { readonly action: "move"; readonly claimPointer: true; readonly focusWindowId: string }
  | {
      readonly action: "resize";
      readonly edge: CanvasResizeEdge;
      readonly claimPointer: true;
      readonly focusWindowId: string;
    };

/**
 * Canvas gestures only claim explicit chrome/background input. Terminal input
 * remains owned by the terminal surface, including ordinary primary clicks.
 */
export function routeCanvasPointer(input: CanvasPointerRoutingInput): CanvasPointerRoute {
  const { region } = input;
  if (input.button === 1 && region.kind === "canvas") {
    return { action: "pan", claimPointer: true, focusWindowId: null };
  }
  if (input.button !== 0) {
    return { action: "ignore", claimPointer: false, focusWindowId: null };
  }
  if (region.kind === "resize-handle") {
    return {
      action: "resize",
      edge: region.edge,
      claimPointer: true,
      focusWindowId: region.windowId,
    };
  }
  if (region.kind === "window-header") {
    if (region.interactiveControl) {
      return { action: "focus", claimPointer: false, focusWindowId: region.windowId };
    }
    return { action: "move", claimPointer: true, focusWindowId: region.windowId };
  }
  if (region.kind === "terminal") {
    return { action: "terminal-input", claimPointer: false, focusWindowId: region.windowId };
  }
  if (region.kind === "window-content") {
    return { action: "focus", claimPointer: false, focusWindowId: region.windowId };
  }
  if (input.spaceKey) return { action: "pan", claimPointer: true, focusWindowId: null };
  return { action: "clear-focus", claimPointer: false, focusWindowId: null };
}

export function canvasOwnsWheel(region: CanvasPointerRegion): boolean {
  return region.kind === "canvas";
}
