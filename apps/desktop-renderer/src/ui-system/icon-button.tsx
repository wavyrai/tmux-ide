import { Show, mergeProps, splitProps, type JSX } from "solid-js";

import { Tooltip, type TooltipPlacement } from "./tooltip.tsx";

export type IconButtonVariant = "secondary" | "ghost" | "danger";
export type IconButtonSize = "small" | "medium";

export type IconButtonProps = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children"
> & {
  readonly label: string;
  readonly children: JSX.Element;
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly pressed?: boolean;
  readonly tooltip?: string | false;
  readonly tooltipPlacement?: TooltipPlacement;
};

export function IconButton(props: IconButtonProps): JSX.Element {
  const merged = mergeProps(
    { variant: "ghost" as const, size: "medium" as const, type: "button" as const },
    props,
  );
  const [local, rest] = splitProps(merged, [
    "label",
    "children",
    "variant",
    "size",
    "pressed",
    "tooltip",
    "tooltipPlacement",
    "class",
    "type",
  ]);

  const control = (describedBy?: string) => (
    <button
      {...rest}
      type={local.type}
      class={`tmi-icon-button${local.class ? ` ${local.class}` : ""}`}
      data-variant={local.variant}
      data-size={local.size}
      aria-label={local.label}
      aria-describedby={describedBy}
      aria-pressed={local.pressed}
    >
      {local.children}
    </button>
  );

  return (
    <Show when={local.tooltip !== false} fallback={control()}>
      <Tooltip
        content={typeof local.tooltip === "string" ? local.tooltip : local.label}
        placement={local.tooltipPlacement}
      >
        {(trigger) => control(trigger["aria-describedby"])}
      </Tooltip>
    </Show>
  );
}
