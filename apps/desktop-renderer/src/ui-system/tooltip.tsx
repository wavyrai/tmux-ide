import { createSignal, createUniqueId, type JSX } from "solid-js";

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

export function Tooltip(props: TooltipProps): JSX.Element {
  const id = `tmi-tooltip-${createUniqueId()}`;
  const [pointerOpen, setPointerOpen] = createSignal(false);
  const [focusOpen, setFocusOpen] = createSignal(false);
  const [dismissed, setDismissed] = createSignal(false);
  const open = () => !dismissed() && (pointerOpen() || focusOpen());

  const closeAfterFocusLeaves: JSX.EventHandler<HTMLSpanElement, FocusEvent> = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusOpen(false);
  };

  const closeOnEscape: JSX.EventHandler<HTMLSpanElement, KeyboardEvent> = (event) => {
    if (event.key === "Escape") setDismissed(true);
  };

  return (
    <span
      class={`tmi-tooltip-anchor${props.class ? ` ${props.class}` : ""}`}
      onPointerEnter={() => {
        setDismissed(false);
        setPointerOpen(true);
      }}
      onPointerLeave={() => setPointerOpen(false)}
      onFocusIn={() => {
        setDismissed(false);
        setFocusOpen(true);
      }}
      onFocusOut={closeAfterFocusLeaves}
      onKeyDown={closeOnEscape}
    >
      {props.children({ "aria-describedby": id })}
      <span
        id={id}
        class="tmi-tooltip"
        role="tooltip"
        data-placement={props.placement ?? "top"}
        data-open={String(open())}
        aria-hidden={open() ? undefined : "true"}
      >
        {props.content}
      </span>
    </span>
  );
}
