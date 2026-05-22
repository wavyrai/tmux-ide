/**
 * Horizontal preview strip for staged composer attachments. Replaces
 * the existing flat `AttachmentChip` row when the composer has more
 * than a couple of items staged — wraps quickly become a wall of
 * pills, the carousel gives each item a 56px card with a real
 * preview (thumbnail for images, glyph + truncated path for files /
 * terminals).
 *
 *   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 *   │              │  │  📄          │  │  ▤           │
 *   │   <thumb>    │  │ src/foo.ts   │  │ Terminal 1   │
 *   │              │  │  12 KB       │  │ 124 lines    │
 *   │  hero.png   ×│  │           × │  │           × │
 *   └──────────────┘  └──────────────┘  └──────────────┘
 *
 * Reorder + remove are pure callbacks; the host owns the underlying
 * attachment list. Reorder is exposed via `data-attachment-index`
 * + small arrow buttons; a full drag-reorder interaction is out of
 * scope (and rarely needed for a 1-5 item composer queue).
 *
 * Pure render — no Solid state inside; reactivity flows through
 * `attachments` and the imperative callbacks.
 */

import { For, Show, type Accessor, type JSX } from "solid-js";
import type { ComposerAttachment } from "../types";

export interface AttachmentCarouselProps {
  attachments: Accessor<ReadonlyArray<ComposerAttachment>>;
  onRemove: (index: number) => void;
  /**
   * Optional reorder hook. When set, each card gets a pair of "‹ ›"
   * micro-buttons that bubble (fromIndex, toIndex) so the host can
   * reorder its underlying list. Omit to hide the reorder
   * affordance entirely.
   */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  class?: string;
}

const CARD_CLASS =
  "group/attachment relative flex h-16 w-32 shrink-0 flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--fg-secondary)]";

const THUMB_CLASS = "h-10 w-full overflow-hidden bg-[var(--bg)]";

const FOOTER_CLASS = "flex items-center gap-1 px-1.5 py-0.5 text-xs text-[var(--fg-secondary)]";

const REMOVE_CLASS =
  "absolute right-1 top-1 inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm bg-black/40 text-xs leading-none text-white opacity-0 transition-opacity hover:opacity-100 group-hover/attachment:opacity-100";

const REORDER_BUTTON_CLASS =
  "inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm bg-transparent text-xs text-[var(--fg-secondary)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-30";

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function attachmentLabel(attachment: ComposerAttachment): string {
  switch (attachment.kind) {
    case "terminal":
      return attachment.paneTitle;
    case "file":
      return attachment.label;
    case "image":
      return attachment.label;
  }
}

function attachmentKindGlyph(attachment: ComposerAttachment): string {
  switch (attachment.kind) {
    case "terminal":
      return "▤";
    case "file":
      return "📄";
    case "image":
      return "🖼";
  }
}

function attachmentSize(attachment: ComposerAttachment): string {
  if (attachment.kind !== "image") return "";
  return attachment.sizeBytes !== undefined ? formatAttachmentSize(attachment.sizeBytes) : "";
}

export function AttachmentCarousel(props: AttachmentCarouselProps): JSX.Element {
  return (
    <Show when={props.attachments().length > 0}>
      <div
        data-testid="attachment-carousel"
        data-count={props.attachments().length}
        class={`flex max-w-full gap-1.5 overflow-x-auto scroll-smooth ${props.class ?? ""}`}
        role="list"
        aria-label="Staged attachments"
      >
        <For each={props.attachments()}>
          {(attachment, index) => (
            <article
              data-testid="attachment-carousel-card"
              data-kind={attachment.kind}
              data-attachment-index={index()}
              class={CARD_CLASS}
              role="listitem"
            >
              <div class={THUMB_CLASS} aria-hidden="true">
                <Show
                  when={attachment.kind === "image"}
                  fallback={
                    <div class="flex h-full w-full items-center justify-center text-[18px]">
                      {attachmentKindGlyph(attachment)}
                    </div>
                  }
                >
                  <img
                    data-testid="attachment-carousel-thumbnail"
                    src={(attachment as Extract<ComposerAttachment, { kind: "image" }>).dataUrl}
                    alt=""
                    class="h-full w-full object-cover"
                    loading="lazy"
                  />
                </Show>
              </div>
              <button
                type="button"
                data-testid="attachment-carousel-remove"
                aria-label={`Remove ${attachmentLabel(attachment)} attachment`}
                class={REMOVE_CLASS}
                onClick={() => props.onRemove(index())}
              >
                ×
              </button>
              <footer class={FOOTER_CLASS}>
                <span class="min-w-0 flex-1 truncate" title={attachmentLabel(attachment)}>
                  {attachmentLabel(attachment)}
                </span>
                <Show when={attachmentSize(attachment)}>
                  {(size) => (
                    <span data-testid="attachment-carousel-size" class="shrink-0 text-[var(--dim)]">
                      {size()}
                    </span>
                  )}
                </Show>
              </footer>
              <Show when={props.onReorder}>
                {(onReorder) => (
                  <div
                    data-testid="attachment-carousel-reorder"
                    class="absolute left-1 top-1 inline-flex gap-0.5 opacity-0 transition-opacity group-hover/attachment:opacity-100"
                  >
                    <button
                      type="button"
                      data-testid="attachment-carousel-reorder-left"
                      class={REORDER_BUTTON_CLASS}
                      aria-label="Move attachment left"
                      disabled={index() === 0}
                      onClick={() => onReorder()(index(), index() - 1)}
                    >
                      ‹
                    </button>
                    <button
                      type="button"
                      data-testid="attachment-carousel-reorder-right"
                      class={REORDER_BUTTON_CLASS}
                      aria-label="Move attachment right"
                      disabled={index() === props.attachments().length - 1}
                      onClick={() => onReorder()(index(), index() + 1)}
                    >
                      ›
                    </button>
                  </div>
                )}
              </Show>
            </article>
          )}
        </For>
      </div>
    </Show>
  );
}
