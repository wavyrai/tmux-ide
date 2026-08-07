import {
  panCanvasViewport,
  zoomCanvasViewportAt,
  type CanvasPoint,
  type CanvasScaleRange,
  type CanvasViewportTransform,
} from "./canvas-interaction-geometry.ts";

export type CanvasViewportKeyboardCommand =
  | "zoom-in"
  | "zoom-out"
  | "fit"
  | "reset"
  | "pan-left"
  | "pan-right"
  | "pan-up"
  | "pan-down";

export function canvasViewportKeyboardCommand(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}): CanvasViewportKeyboardCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "+" || event.key === "=") return "zoom-in";
  if (event.key === "-") return "zoom-out";
  if (event.key === "0") return "reset";
  if (event.key.toLocaleLowerCase() === "f") return "fit";
  if (event.key === "ArrowLeft") return "pan-left";
  if (event.key === "ArrowRight") return "pan-right";
  if (event.key === "ArrowUp") return "pan-up";
  if (event.key === "ArrowDown") return "pan-down";
  return null;
}

export function canvasWheelTransform(input: {
  readonly transform: CanvasViewportTransform;
  readonly anchor: CanvasPoint;
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly scaleRange?: CanvasScaleRange;
}): CanvasViewportTransform {
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? 240 : 1;
  const deltaX = Number.isFinite(input.deltaX) ? input.deltaX * unit : 0;
  const deltaY = Number.isFinite(input.deltaY) ? input.deltaY * unit : 0;
  if (input.ctrlKey || input.metaKey) {
    const factor = Math.exp(-deltaY * 0.01);
    return zoomCanvasViewportAt(
      input.transform,
      input.transform.scale * factor,
      input.anchor,
      input.scaleRange,
    );
  }
  return panCanvasViewport(
    input.transform,
    input.shiftKey && deltaX === 0 ? { x: -deltaY, y: 0 } : { x: -deltaX, y: -deltaY },
    input.scaleRange,
  );
}

export function keyboardCanvasViewportTransform(input: {
  readonly transform: CanvasViewportTransform;
  readonly command: Exclude<CanvasViewportKeyboardCommand, "fit" | "reset">;
  readonly center: CanvasPoint;
  readonly scaleRange?: CanvasScaleRange;
}): CanvasViewportTransform {
  switch (input.command) {
    case "zoom-in":
      return zoomCanvasViewportAt(
        input.transform,
        input.transform.scale * 1.2,
        input.center,
        input.scaleRange,
      );
    case "zoom-out":
      return zoomCanvasViewportAt(
        input.transform,
        input.transform.scale / 1.2,
        input.center,
        input.scaleRange,
      );
    case "pan-left":
      return panCanvasViewport(input.transform, { x: 48, y: 0 }, input.scaleRange);
    case "pan-right":
      return panCanvasViewport(input.transform, { x: -48, y: 0 }, input.scaleRange);
    case "pan-up":
      return panCanvasViewport(input.transform, { x: 0, y: 48 }, input.scaleRange);
    case "pan-down":
      return panCanvasViewport(input.transform, { x: 0, y: -48 }, input.scaleRange);
  }
}
