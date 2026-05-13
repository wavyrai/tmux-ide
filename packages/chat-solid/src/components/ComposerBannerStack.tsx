/**
 * Vertical stack of dismissible banners rendered BETWEEN the
 * `MessagesTimeline` and the `ChatComposer`. Host supplies an ordered
 * array; the stack renders the first banner with full chrome and
 * compresses the rest into a collapsed cap (count + visual cue) so the
 * viewport stays calm while still surfacing the queued state.
 *
 * Variants drive accent color via the design-token foreground pairs
 * (PR 2): error / info / success / warning.
 *
 * Pure render — every interaction (dismiss, primary/secondary actions)
 * is a callback on the item the host owns.
 */

import { For, Show, type Accessor, type JSX } from "solid-js";

export type BannerVariant = "error" | "info" | "success" | "warning";

export interface ComposerBannerItem {
  /** Stable identity used as the key in `<For>`. */
  id: string;
  variant: BannerVariant;
  /** Short icon node (e.g. lucide-style glyph or text). */
  icon?: JSX.Element;
  /** Single-line headline. */
  title: JSX.Element;
  /** Optional descriptive copy below the title. */
  description?: JSX.Element;
  /** Optional action buttons (Apply / Approve / Decline / …). Host renders. */
  actions?: JSX.Element;
  /** When set, renders a close (×) button that calls this. */
  onDismiss?: () => void;
  /** Accessible label for the × button; defaults to "Dismiss". */
  dismissLabel?: string;
}

interface ComposerBannerStackProps {
  items: Accessor<ReadonlyArray<ComposerBannerItem>>;
  /** Optional class on the outer wrapper for layout polish at the call site. */
  class?: string;
}

const VARIANT_CLASS: Record<BannerVariant, string> = {
  error:
    "border-destructive/40 bg-destructive/10 text-destructive-foreground",
  info: "border-info/40 bg-info/10 text-info-foreground",
  success: "border-success/40 bg-success/10 text-success-foreground",
  warning: "border-warning/40 bg-warning/10 text-warning-foreground",
};

export function ComposerBannerStack(props: ComposerBannerStackProps) {
  return (
    <Show when={props.items().length > 0}>
      <div
        data-testid="composer-banner-stack"
        class={`flex flex-col gap-1.5 px-4 pt-2 pb-1 sm:px-5 ${props.class ?? ""}`}
        role="region"
        aria-label="Composer banners"
      >
        <BannerCard item={props.items()[0]!} />
        <Show when={props.items().length > 1}>
          <CollapsedStackCap count={props.items().length - 1} />
        </Show>
      </div>
    </Show>
  );
}

function BannerCard(props: { item: ComposerBannerItem }) {
  const variant = () => props.item.variant;
  return (
    <article
      data-testid={`composer-banner-${props.item.id}`}
      data-variant={variant()}
      class={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${VARIANT_CLASS[variant()]}`}
    >
      <header class="flex items-start gap-2">
        <Show when={props.item.icon}>
          <span class="mt-0.5 shrink-0" aria-hidden="true">
            {props.item.icon}
          </span>
        </Show>
        <div class="min-w-0 flex-1">
          <div class="font-medium leading-tight">{props.item.title}</div>
          <Show when={props.item.description}>
            <div class="mt-1 text-xs opacity-80">{props.item.description}</div>
          </Show>
        </div>
        <Show when={props.item.onDismiss}>
          <button
            type="button"
            data-testid={`composer-banner-${props.item.id}-dismiss`}
            class="ml-2 shrink-0 rounded-sm px-1 text-xs opacity-60 hover:opacity-100"
            aria-label={props.item.dismissLabel ?? "Dismiss"}
            onClick={() => props.item.onDismiss?.()}
          >
            ×
          </button>
        </Show>
      </header>
      <Show when={props.item.actions}>
        <footer class="mt-2 flex flex-wrap items-center gap-2">
          {props.item.actions}
        </footer>
      </Show>
    </article>
  );
}

function CollapsedStackCap(props: { count: Accessor<number> | number }) {
  const n = () => (typeof props.count === "function" ? props.count() : props.count);
  return (
    <div
      data-testid="composer-banner-stack-cap"
      class="rounded-md border border-border/45 bg-card/25 px-3 py-1 text-[11px] text-muted-foreground"
    >
      +{n()} more banner{n() === 1 ? "" : "s"}
    </div>
  );
}
