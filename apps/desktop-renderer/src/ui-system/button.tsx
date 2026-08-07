import { Show, mergeProps, splitProps, type JSX } from "solid-js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

export function Button(props: ButtonProps): JSX.Element {
  const merged = mergeProps(
    { variant: "secondary" as const, size: "medium" as const, type: "button" as const },
    props,
  );
  const [local, rest] = splitProps(merged, [
    "variant",
    "size",
    "loading",
    "disabled",
    "class",
    "children",
    "type",
  ]);
  const unavailable = () => Boolean(local.disabled || local.loading);

  return (
    <button
      {...rest}
      type={local.type}
      class={`tmi-button${local.class ? ` ${local.class}` : ""}`}
      data-variant={local.variant}
      data-size={local.size}
      data-loading={local.loading ? "true" : undefined}
      disabled={unavailable()}
      aria-busy={local.loading || undefined}
    >
      <Show when={local.loading}>
        <span class="tmi-button__spinner" aria-hidden="true" />
      </Show>
      <span class="tmi-button__label">{local.children}</span>
    </button>
  );
}
