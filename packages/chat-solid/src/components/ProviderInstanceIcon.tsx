/**
 * Per-instance icon for the model picker rail + list rows. Renders
 * a 16/20px badge centred on a square — glyph when the driver kind
 * is one of the built-ins we have a glyph for, otherwise the first
 * 1-2 letters of the instance's display name (so a user-authored
 * "Codex Personal" reads as "CP", not "C·").
 *
 * Pure render. The optional `statusDot` slot draws an availability
 * dot — green for ready, amber for warning, red for error — at the
 * top-left so the rail user can scan provider health without a
 * tooltip.
 */

import type { JSX } from "solid-js";
import { Show } from "solid-js";

export type ProviderInstanceStatus = "ready" | "warning" | "error" | "disabled" | "starting";

export interface ProviderInstanceIconProps {
  driverKind: string;
  displayName: string;
  accentColor?: string;
  status?: ProviderInstanceStatus;
  showBadge?: boolean;
  class?: string;
  iconClass?: string;
}

const GLYPHS: Record<string, string> = {
  "claude-code": "⌁",
  codex: "◇",
  gemini: "✦",
};

const STATUS_COLOR: Record<ProviderInstanceStatus, string> = {
  ready: "var(--green)",
  warning: "var(--yellow)",
  error: "var(--red)",
  disabled: "var(--dim)",
  starting: "var(--accent)",
};

export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

export function ProviderInstanceIcon(props: ProviderInstanceIconProps): JSX.Element {
  const glyph = (): string | null => GLYPHS[props.driverKind] ?? null;

  return (
    <span
      data-testid="provider-instance-icon"
      data-driver-kind={props.driverKind}
      data-status={props.status ?? "ready"}
      class={`relative inline-flex shrink-0 items-center justify-center ${props.class ?? "size-5"}`}
      style={props.accentColor ? { color: props.accentColor } : undefined}
    >
      <Show
        when={glyph()}
        fallback={
          <span
            class={`text-xs font-semibold leading-none ${props.iconClass ?? ""}`}
            aria-hidden="true"
          >
            {providerInstanceInitials(props.displayName)}
          </span>
        }
      >
        {(g) => (
          <span class={`text-md leading-none ${props.iconClass ?? ""}`} aria-hidden="true">
            {g()}
          </span>
        )}
      </Show>
      <Show when={props.status}>
        {(status) => (
          <span
            data-testid="provider-instance-status-dot"
            class="pointer-events-none absolute -left-0.5 -top-0.5 size-1.5 rounded-full ring-2 ring-bg"
            style={{ background: STATUS_COLOR[status()] }}
            aria-hidden="true"
          />
        )}
      </Show>
      <Show when={props.showBadge}>
        <span
          class="pointer-events-none absolute -bottom-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-bg px-0.5 text-[8px] font-semibold leading-none"
          style={props.accentColor ? { color: props.accentColor } : undefined}
          aria-hidden="true"
        >
          {providerInstanceInitials(props.displayName)}
        </span>
      </Show>
    </span>
  );
}
