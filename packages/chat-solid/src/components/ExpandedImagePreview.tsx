/**
 * Inline image preview rendered inside chat message bodies (and the
 * composer's staged-attachment row). Two parts:
 *
 *   1. The pure data shape that downstream consumers — the message
 *      renderer, the composer attachment row, the fullscreen modal —
 *      all agree on: `ExpandedImageItem`, `ExpandedImagePreview`, and
 *      the `buildExpandedImagePreview` helper that turns a message's
 *      attachment array into a preview cursor anchored at the
 *      clicked image.
 *
 *   2. A Solid `<InlineImagePreview>` component that:
 *        - Renders a width-capped thumbnail (`max-h-[220px]`) with a
 *          clear "click to expand" affordance (zoom cursor + ring on
 *          hover).
 *        - Lazy-loads via IntersectionObserver — the <img> doesn't
 *          decode until the thumbnail scrolls within `rootMargin:
 *          200px` of the viewport. Long transcripts with dozens of
 *          screenshots no longer pay a full network tax up front.
 *        - Falls back to native `loading="lazy"` when IO isn't
 *          available (SSR / older browsers).
 *
 * Click handling: the inline preview fires `onExpand(preview)` with a
 * cursor anchored at this image. The host (typically the message
 * timeline) opens `<ExpandedImageDialog />` with that preview.
 */
import { createSignal, onCleanup, onMount, Show, type Accessor } from "solid-js";

export interface ExpandedImageItem {
  src: string;
  name: string;
  /** Optional caption shown beneath the image in the modal. */
  sizeLabel?: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

interface AttachmentLike {
  id: string;
  name: string;
  previewUrl?: string;
  sizeBytes?: number;
}

function formatBytes(n: number | undefined): string | undefined {
  if (!Number.isFinite(n) || !n || n <= 0) return undefined;
  const bytes = n as number;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Convert an array of attachment-shaped objects into a fullscreen
 * preview cursor anchored at `selectedImageId`. Filters out non-image
 * (no `previewUrl`) entries so the modal's ←/→ navigation only
 * traverses things it can actually render.
 *
 * Returns null if the selected id isn't a previewable image — callers
 * should treat that as "don't open the modal".
 */
export function buildExpandedImagePreview(
  attachments: ReadonlyArray<AttachmentLike>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewable = attachments.flatMap<ExpandedImageItem & { id: string }>((a) =>
    a.previewUrl
      ? [
          {
            id: a.id,
            src: a.previewUrl,
            name: a.name,
            ...(formatBytes(a.sizeBytes) ? { sizeLabel: formatBytes(a.sizeBytes)! } : {}),
          },
        ]
      : [],
  );
  if (previewable.length === 0) return null;
  const index = previewable.findIndex((p) => p.id === selectedImageId);
  if (index < 0) return null;
  return {
    images: previewable.map(({ src, name, sizeLabel }) => ({
      src,
      name,
      ...(sizeLabel ? { sizeLabel } : {}),
    })),
    index,
  };
}

interface InlineImagePreviewProps {
  src: Accessor<string>;
  alt: Accessor<string>;
  /** Called when the user clicks the thumbnail. Host opens the dialog. */
  onExpand?: () => void;
  /** Override the lazy-load IntersectionObserver root margin. */
  rootMargin?: string;
  /** Disable lazy-loading entirely — for tests + above-the-fold uses. */
  eager?: boolean;
}

export function InlineImagePreview(props: InlineImagePreviewProps) {
  const [isVisible, setVisible] = createSignal(Boolean(props.eager));
  const [ref, setRef] = createSignal<HTMLButtonElement>();

  onMount(() => {
    if (props.eager) return;
    const el = ref();
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      // Older browsers / SSR — flip visible immediately and rely on
      // the native `loading="lazy"` attribute below.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin: props.rootMargin ?? "200px" },
    );
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  });

  return (
    <button
      ref={setRef}
      type="button"
      data-testid="inline-image-preview"
      data-loaded={isVisible() ? "true" : "false"}
      aria-label={`Open ${props.alt()} in fullscreen`}
      class="group/img relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-strong)] p-0 transition-colors hover:border-[var(--accent)] focus-visible:border-[var(--accent)] cursor-zoom-in"
      onClick={() => props.onExpand?.()}
    >
      <Show
        when={isVisible()}
        fallback={
          <div
            data-testid="inline-image-preview-placeholder"
            class="flex h-[120px] min-w-[160px] items-center justify-center text-xs text-[var(--dim)]"
            aria-hidden="true"
          >
            ◧
          </div>
        }
      >
        <img
          src={props.src()}
          alt={props.alt()}
          loading="lazy"
          draggable={false}
          class="block h-auto max-h-[220px] w-auto max-w-full select-none object-contain"
        />
      </Show>
      <span
        aria-hidden="true"
        class="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-5 items-center rounded-full border border-[var(--border)] bg-[var(--bg-strong)]/85 px-1.5 text-xs text-[var(--fg-secondary)] opacity-0 transition-opacity group-hover/img:opacity-100"
      >
        ⛶ expand
      </span>
    </button>
  );
}
