import { createSignal, mergeProps, type JSX } from "solid-js";

export interface ResizeHandleProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onValueChange: (value: number) => void;
  readonly orientation?: "horizontal" | "vertical";
  readonly step?: number;
  readonly largeStep?: number;
  readonly label?: string;
  readonly disabled?: boolean;
  readonly class?: string;
}

export function ResizeHandle(props: ResizeHandleProps): JSX.Element {
  const merged = mergeProps(
    {
      orientation: "vertical" as const,
      step: 8,
      largeStep: 32,
      label: "Resize panels",
    },
    props,
  );
  let activePointer: number | undefined;
  let pointerPosition = 0;
  let dragValue = merged.value;
  const [dragging, setDragging] = createSignal(false);

  const clamp = (value: number) => Math.min(merged.max, Math.max(merged.min, value));
  const update = (value: number) => {
    if (!merged.disabled) merged.onValueChange(clamp(value));
  };
  const pointerAxis = (event: PointerEvent) =>
    merged.orientation === "vertical" ? event.clientX : event.clientY;

  const onPointerDown: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (merged.disabled || event.button !== 0) return;
    activePointer = event.pointerId;
    pointerPosition = pointerAxis(event);
    dragValue = merged.value;
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (activePointer !== event.pointerId) return;
    const position = pointerAxis(event);
    dragValue = clamp(dragValue + position - pointerPosition);
    pointerPosition = position;
    update(dragValue);
  };
  const endPointer: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (activePointer !== event.pointerId) return;
    activePointer = undefined;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const onLostPointerCapture: JSX.EventHandler<HTMLDivElement, PointerEvent> = (event) => {
    if (activePointer !== event.pointerId) return;
    activePointer = undefined;
    setDragging(false);
  };
  const onKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (merged.disabled) return;
    const decrease = merged.orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
    const increase = merged.orientation === "vertical" ? "ArrowRight" : "ArrowDown";
    let next: number | undefined;
    const step = event.shiftKey ? merged.largeStep : merged.step;
    if (event.key === decrease) next = merged.value - step;
    if (event.key === increase) next = merged.value + step;
    if (event.key === "Home") next = merged.min;
    if (event.key === "End") next = merged.max;
    if (next === undefined) return;
    event.preventDefault();
    update(next);
  };

  return (
    <div
      class={`tmi-resize-handle${merged.class ? ` ${merged.class}` : ""}`}
      role="separator"
      aria-label={merged.label}
      aria-orientation={merged.orientation}
      aria-valuemin={merged.min}
      aria-valuemax={merged.max}
      aria-valuenow={clamp(merged.value)}
      aria-disabled={merged.disabled || undefined}
      tabIndex={merged.disabled ? -1 : 0}
      data-orientation={merged.orientation}
      data-dragging={dragging() ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
    />
  );
}
