import {
  canvasDeltaFromScreenDelta,
  canvasRectsEqual,
  moveCanvasRect,
  resizeCanvasRect,
  type CanvasPoint,
  type CanvasRect,
  type CanvasRectConstraints,
  type CanvasResizeEdge,
  type CanvasScaleRange,
  type CanvasViewportTransform,
} from "./canvas-interaction-geometry.ts";
import {
  rectCommitIntent,
  type AppWindowInteractionCommandIntent,
} from "./canvas-interaction-intents.ts";

export interface CanvasPointerSample extends CanvasPoint {
  readonly pointerId: number;
}

interface CanvasPointerTransactionBase {
  readonly pointerId: number;
  readonly windowId: string;
  readonly origin: CanvasPointerSample;
  readonly originalRect: CanvasRect;
  readonly currentRect: CanvasRect;
  readonly transform: CanvasViewportTransform;
  readonly scaleRange?: CanvasScaleRange;
  readonly constraints: CanvasRectConstraints;
}

export type CanvasPointerTransaction =
  | (CanvasPointerTransactionBase & { readonly kind: "move" })
  | (CanvasPointerTransactionBase & {
      readonly kind: "resize";
      readonly edge: CanvasResizeEdge;
    });

export interface CanvasPointerTransactionInput {
  readonly pointer: CanvasPointerSample;
  readonly windowId: string;
  readonly rect: CanvasRect;
  readonly transform: CanvasViewportTransform;
  /** Must match the range used to normalize the viewport transform. */
  readonly scaleRange?: CanvasScaleRange;
  readonly constraints: CanvasRectConstraints;
  /** Presentation preference is intentionally irrelevant to transaction semantics. */
  readonly presentation?: { readonly reducedMotion: boolean };
}

export interface CanvasTransientFrame {
  readonly phase: "transient";
  readonly rect: CanvasRect;
  readonly persist: false;
  readonly commands: readonly [];
}

export interface CanvasPointerCompletion {
  readonly phase: "committed" | "cancelled";
  readonly rect: CanvasRect;
  readonly persist: boolean;
  /** Geometry completion persists through zero or one atomic full-rect command. */
  readonly commands: readonly [] | readonly [AppWindowInteractionCommandIntent];
}

export function beginCanvasMove(input: CanvasPointerTransactionInput): CanvasPointerTransaction {
  return {
    kind: "move",
    pointerId: input.pointer.pointerId,
    windowId: input.windowId,
    origin: input.pointer,
    originalRect: input.rect,
    currentRect: input.rect,
    transform: input.transform,
    scaleRange: input.scaleRange,
    constraints: input.constraints,
  };
}

export function beginCanvasResize(
  input: CanvasPointerTransactionInput & { readonly edge: CanvasResizeEdge },
): CanvasPointerTransaction {
  return {
    kind: "resize",
    edge: input.edge,
    pointerId: input.pointer.pointerId,
    windowId: input.windowId,
    origin: input.pointer,
    originalRect: input.rect,
    currentRect: input.rect,
    transform: input.transform,
    scaleRange: input.scaleRange,
    constraints: input.constraints,
  };
}

export function updateCanvasPointerTransaction(
  transaction: CanvasPointerTransaction,
  pointer: CanvasPointerSample,
): { readonly transaction: CanvasPointerTransaction; readonly frame: CanvasTransientFrame } {
  if (pointer.pointerId !== transaction.pointerId) {
    return {
      transaction,
      frame: { phase: "transient", rect: transaction.currentRect, persist: false, commands: [] },
    };
  }
  const delta = canvasDeltaFromScreenDelta(
    { x: pointer.x - transaction.origin.x, y: pointer.y - transaction.origin.y },
    transaction.transform,
    transaction.scaleRange,
  );
  const currentRect =
    transaction.kind === "move"
      ? moveCanvasRect(transaction.originalRect, delta, transaction.constraints)
      : resizeCanvasRect(
          transaction.originalRect,
          transaction.edge,
          delta,
          transaction.constraints,
        );
  const next = { ...transaction, currentRect } as CanvasPointerTransaction;
  return {
    transaction: next,
    frame: { phase: "transient", rect: currentRect, persist: false, commands: [] },
  };
}

export function commitCanvasPointerTransaction(
  transaction: CanvasPointerTransaction,
): CanvasPointerCompletion {
  const changed = !canvasRectsEqual(transaction.originalRect, transaction.currentRect);
  return {
    phase: "committed",
    rect: transaction.currentRect,
    persist: changed,
    commands: changed
      ? [rectCommitIntent(transaction.windowId, transaction.currentRect, "mouse")]
      : [],
  };
}

export function cancelCanvasPointerTransaction(
  transaction: CanvasPointerTransaction,
): CanvasPointerCompletion {
  return {
    phase: "cancelled",
    rect: transaction.originalRect,
    persist: false,
    commands: [],
  };
}
