/**
 * Fullscreen image preview modal. Opens over the entire chat surface
 * when the user clicks an inline image (`InlineImagePreview`) or a
 * staged image attachment in the composer.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │                          [×]                              │
 *   │ ←     ┌──────────────────────────────────┐     →          │
 *   │       │                                  │                │
 *   │       │       <image, max 86vh×92vw>     │                │
 *   │       │                                  │                │
 *   │       └──────────────────────────────────┘                │
 *   │                screenshot.png · 240 KB (2/4)              │
 *   └────────────────────────────────────────────────────────────┘
 *           (backdrop fades + blurs; click anywhere closes)
 *
 * Keyboard:
 *   Esc       — close
 *   ←/→       — navigate between images in the same preview (only
 *               attached when `preview.images.length > 1`)
 *
 * The modal is uncontrolled past mount: the parent hands a single
 * `preview` snapshot and we own the in-modal cursor. A fresh `preview`
 * accessor (different reference) re-seeds the cursor — that's how the
 * host opens the modal pointed at a different image.
 */
import { createEffect, createSignal, on, onCleanup, Show, type Accessor } from "solid-js";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

interface ExpandedImageDialogProps {
  /** Active preview snapshot or null when the modal should be closed. */
  preview: Accessor<ExpandedImagePreview | null>;
  onClose: () => void;
}

export function ExpandedImageDialog(props: ExpandedImageDialogProps) {
  const [index, setIndex] = createSignal(0);

  // Re-seed the in-modal cursor whenever the host hands us a new
  // preview reference. `on(..., { defer: false })` runs synchronously
  // on the first read so we never render with a stale index.
  createEffect(
    on(
      () => props.preview(),
      (next) => {
        if (next) setIndex(next.index);
      },
    ),
  );

  function navigate(direction: -1 | 1) {
    const current = props.preview();
    if (!current || current.images.length <= 1) return;
    setIndex((i) => (i + direction + current.images.length) % current.images.length);
  }

  // Document-level keyboard handler. Only attaches while the modal is
  // open so the chat surface keeps its own arrow-key behaviors when
  // we're closed.
  createEffect(() => {
    if (!props.preview()) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        return;
      }
      const cursor = props.preview();
      if (!cursor || cursor.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigate(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        navigate(1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <Show when={props.preview()}>
      {(preview) => {
        const item = () => preview().images[index()];
        const total = () => preview().images.length;
        return (
          <div
            data-testid="expanded-image-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Expanded image preview"
            class="fixed inset-0 z-50 flex items-center justify-center px-4 py-6"
            style={{
              "background-color": "color-mix(in oklab, var(--bg) 75%, black)",
              "backdrop-filter": "blur(8px)",
            }}
          >
            <button
              type="button"
              data-testid="expanded-image-dialog-backdrop"
              aria-label="Close image preview"
              onClick={() => props.onClose()}
              class="absolute inset-0 z-0 cursor-zoom-out border-0 bg-transparent p-0"
            />
            <Show when={total() > 1}>
              <button
                type="button"
                data-testid="expanded-image-dialog-prev"
                aria-label="Previous image"
                onClick={() => navigate(-1)}
                class="absolute left-3 top-1/2 z-20 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-strong)]/80 text-[20px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] sm:left-6"
              >
                ‹
              </button>
            </Show>
            <div
              data-testid="expanded-image-dialog-frame"
              class="relative isolate z-10 flex max-h-[92vh] max-w-[92vw] flex-col items-center"
            >
              <button
                type="button"
                data-testid="expanded-image-dialog-close"
                aria-label="Close image preview"
                onClick={() => props.onClose()}
                class="absolute right-2 top-2 z-30 inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-strong)]/80 text-lg text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                ×
              </button>
              <Show when={item()}>
                {(currentItem) => (
                  <>
                    <img
                      data-testid="expanded-image-dialog-image"
                      src={currentItem().src}
                      alt={currentItem().name}
                      draggable={false}
                      class="block max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-[var(--border)] bg-[var(--bg-strong)] object-contain shadow-2xl"
                    />
                    <p
                      data-testid="expanded-image-dialog-caption"
                      class="mt-2 max-w-[92vw] truncate text-center text-base text-[var(--fg-secondary)]"
                    >
                      <span>{currentItem().name}</span>
                      <Show when={currentItem().sizeLabel}>
                        {(_size) => (
                          <span class="mx-2 text-[var(--dim)]" aria-hidden="true">
                            ·
                          </span>
                        )}
                      </Show>
                      <Show when={currentItem().sizeLabel}>
                        {(size) => <span class="text-[var(--dim)]">{size()}</span>}
                      </Show>
                      <Show when={total() > 1}>
                        <span class="ml-2 text-[var(--dim)]">
                          ({index() + 1}/{total()})
                        </span>
                      </Show>
                    </p>
                  </>
                )}
              </Show>
            </div>
            <Show when={total() > 1}>
              <button
                type="button"
                data-testid="expanded-image-dialog-next"
                aria-label="Next image"
                onClick={() => navigate(1)}
                class="absolute right-3 top-1/2 z-20 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-strong)]/80 text-[20px] text-[var(--fg-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)] sm:right-6"
              >
                ›
              </button>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
