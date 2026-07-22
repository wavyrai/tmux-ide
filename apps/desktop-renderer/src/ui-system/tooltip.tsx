import { createEffect, createSignal, createUniqueId, onCleanup, type JSX } from "solid-js";
import { Portal } from "solid-js/web";

export type TooltipPlacement = "top" | "right" | "bottom" | "left";

export interface TooltipTriggerProps {
  readonly "aria-describedby": string;
}

export interface TooltipProps {
  readonly content: JSX.Element;
  readonly children: (props: TooltipTriggerProps) => JSX.Element;
  readonly placement?: TooltipPlacement;
  readonly class?: string;
}

interface TooltipPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: TooltipPlacement;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 7;

function oppositePlacement(placement: TooltipPlacement): TooltipPlacement {
  return { top: "bottom", right: "left", bottom: "top", left: "right" }[
    placement
  ] as TooltipPlacement;
}

function availableSpace(rect: DOMRect, placement: TooltipPlacement, width: number, height: number) {
  if (placement === "top") return rect.top - VIEWPORT_MARGIN;
  if (placement === "bottom") return height - rect.bottom - VIEWPORT_MARGIN;
  if (placement === "left") return rect.left - VIEWPORT_MARGIN;
  return width - rect.right - VIEWPORT_MARGIN;
}

function requiredSpace(rect: DOMRect, placement: TooltipPlacement) {
  return placement === "top" || placement === "bottom" ? rect.height : rect.width;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function resolveTooltipPosition(
  anchor: DOMRect,
  tooltip: DOMRect,
  preferred: TooltipPlacement,
  viewportWidth: number,
  viewportHeight: number,
): TooltipPosition {
  const candidates: TooltipPlacement[] = [
    preferred,
    oppositePlacement(preferred),
    ...(preferred === "top" || preferred === "bottom"
      ? (["right", "left"] as const)
      : (["bottom", "top"] as const)),
  ];
  const placement =
    candidates.find(
      (candidate) =>
        availableSpace(anchor, candidate, viewportWidth, viewportHeight) >=
        requiredSpace(tooltip, candidate) + ANCHOR_GAP,
    ) ??
    candidates.reduce((best, candidate) =>
      availableSpace(anchor, candidate, viewportWidth, viewportHeight) >
      availableSpace(anchor, best, viewportWidth, viewportHeight)
        ? candidate
        : best,
    );

  let left = anchor.left + (anchor.width - tooltip.width) / 2;
  let top = anchor.top + (anchor.height - tooltip.height) / 2;
  if (placement === "top") top = anchor.top - tooltip.height - ANCHOR_GAP;
  if (placement === "bottom") top = anchor.bottom + ANCHOR_GAP;
  if (placement === "left") left = anchor.left - tooltip.width - ANCHOR_GAP;
  if (placement === "right") left = anchor.right + ANCHOR_GAP;

  return {
    placement,
    left: clamp(left, VIEWPORT_MARGIN, viewportWidth - tooltip.width - VIEWPORT_MARGIN),
    top: clamp(top, VIEWPORT_MARGIN, viewportHeight - tooltip.height - VIEWPORT_MARGIN),
  };
}

export function Tooltip(props: TooltipProps): JSX.Element {
  const id = `tmi-tooltip-${createUniqueId()}`;
  const [pointerOpen, setPointerOpen] = createSignal(false);
  const [focusOpen, setFocusOpen] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(false);
  const [positioned, setPositioned] = createSignal(false);
  const [placement, setPlacement] = createSignal<TooltipPlacement>(props.placement ?? "top");
  const open = () => !dismissed() && (pointerOpen() || focusOpen());
  let anchor: HTMLSpanElement | undefined;
  let tooltip: HTMLSpanElement | undefined;

  const positionTooltip = () => {
    if (!anchor || !tooltip) return;
    const position = resolveTooltipPosition(
      anchor.getBoundingClientRect(),
      tooltip.getBoundingClientRect(),
      props.placement ?? "top",
      window.innerWidth,
      window.innerHeight,
    );
    tooltip.style.setProperty("left", `${position.left}px`);
    tooltip.style.setProperty("top", `${position.top}px`);
    setPlacement(position.placement);
    setPositioned(true);
  };

  const revealForPointer = () => {
    setDismissed(false);
    setPointerOpen(true);
    positionTooltip();
  };

  const revealForFocus = () => {
    setDismissed(false);
    setFocusOpen(true);
    positionTooltip();
  };

  createEffect(() => {
    if (!open()) return;
    positionTooltip();
    const reposition = () => positionTooltip();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    const frame = window.requestAnimationFrame(reposition);
    onCleanup(() => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    });
  });

  const closeAfterFocusLeaves: JSX.EventHandler<HTMLSpanElement, FocusEvent> = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusOpen(false);
      if (!pointerOpen()) setPositioned(false);
    }
  };

  const closeOnEscape: JSX.EventHandler<HTMLSpanElement, KeyboardEvent> = (event) => {
    if (event.key === "Escape") {
      setDismissed(true);
      setPositioned(false);
    }
  };

  return (
    <span
      ref={(element) => (anchor = element)}
      class={`tmi-tooltip-anchor${props.class ? ` ${props.class}` : ""}`}
      onPointerEnter={revealForPointer}
      onPointerLeave={() => {
        setPointerOpen(false);
        if (!focusOpen()) setPositioned(false);
      }}
      onFocusIn={revealForFocus}
      onFocusOut={closeAfterFocusLeaves}
      onKeyDown={closeOnEscape}
    >
      {props.children({ "aria-describedby": id })}
      <Portal mount={anchor?.closest<HTMLElement>(".app, [data-tmi-theme]") ?? document.body}>
        <span
          ref={(element) => (tooltip = element)}
          id={id}
          class="tmi-tooltip"
          role="tooltip"
          data-placement={placement()}
          data-open={String(open())}
          data-positioned={String(positioned())}
          aria-hidden={open() ? undefined : "true"}
        >
          {props.content}
        </span>
      </Portal>
    </span>
  );
}
