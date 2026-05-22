/**
 * TabStrip — open-buffer tab list above the editor pane.
 *
 * Reads from the buffer store (`bufferState.order` +
 * `bufferState.buffers`). Each tab shows the file basename + a
 * dirty dot (`•`) when `buffer.dirty` is true + a close button.
 * Active tab styling derives from `bufferState.activeUri`.
 *
 * Clicking a tab calls `setActiveBuffer(uri)`. Close `×` calls
 * `closeBuffer(uri)`; a dirty buffer requires a `discardDirty`
 * confirm — for G17-P5 the host wires `window.confirm` so the
 * tab strip stays presentational.
 *
 * Ergonomics:
 *   - Preview tabs (`buffer.isPreview`) render in italic; double
 *     -clicking the tab pins it.
 *   - Drag-to-reorder via native HTML5 DnD calling
 *     `reorderBuffers(from, to)`.
 *   - Activating a tab scrolls it into view if the strip overflows.
 */

import { For, Show, createEffect, createSignal } from "solid-js";
import { X } from "lucide-solid";
import {
  bufferState,
  closeBuffer,
  pinBuffer,
  reorderBuffers,
  setActiveBuffer,
  type OpenBuffer,
} from "@/lib/editor/buffer-store";
import { getFileIcon } from "@/lib/editor/file-icon";

interface TabStripProps {
  /**
   * Confirm-on-close hook. Defaults to `window.confirm` when
   * omitted. Returning false aborts the close.
   */
  onConfirmDiscardDirty?: (buf: OpenBuffer) => boolean;
}

function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? filePath : filePath.slice(idx + 1);
}

const DRAG_MIME = "application/x-tmux-ide-tab";

export function TabStrip(props: TabStripProps) {
  let stripEl: HTMLDivElement | undefined;
  const [dragOverUri, setDragOverUri] = createSignal<string | null>(null);

  function tryClose(uri: string) {
    const buf = bufferState.buffers[uri];
    if (!buf) return;
    if (!buf.dirty) {
      closeBuffer(uri);
      return;
    }
    const confirmFn =
      props.onConfirmDiscardDirty ??
      ((b: OpenBuffer) =>
        typeof window !== "undefined" &&
        typeof window.confirm === "function" &&
        window.confirm(`Discard unsaved changes to ${b.filePath}?`));
    if (confirmFn(buf)) {
      closeBuffer(uri, { discardDirty: true });
    }
  }

  // Scroll the active tab into view when activation changes. Uses
  // `inline: "nearest"` so an already-visible tab doesn't trigger a
  // pointless scroll, and falls back to a manual scrollLeft tweak on
  // browsers without scrollIntoView options.
  createEffect(() => {
    const uri = bufferState.activeUri;
    if (!uri || !stripEl) return;
    const el = stripEl.querySelector<HTMLElement>(`[data-buffer-uri="${cssEscape(uri)}"]`);
    if (!el) return;
    try {
      el.scrollIntoView({ inline: "nearest", block: "nearest" });
    } catch {
      // Older Safari rejects the options object — fall back to the
      // boolean form, which is best-effort.
      try {
        el.scrollIntoView(false);
      } catch {
        /* ignore */
      }
    }
  });

  function onDragStart(ev: DragEvent, uri: string) {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData(DRAG_MIME, uri);
    // Some browsers need a non-empty text/plain payload to actually
    // initiate the drag — keep the URI as a fallback type.
    ev.dataTransfer.setData("text/plain", uri);
  }

  function onDragOver(ev: DragEvent, uri: string) {
    if (!ev.dataTransfer) return;
    const types = ev.dataTransfer.types;
    if (!types.includes(DRAG_MIME)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    if (dragOverUri() !== uri) setDragOverUri(uri);
  }

  function onDragLeave(uri: string) {
    if (dragOverUri() === uri) setDragOverUri(null);
  }

  function onDrop(ev: DragEvent, targetUri: string) {
    if (!ev.dataTransfer) return;
    const sourceUri = ev.dataTransfer.getData(DRAG_MIME);
    setDragOverUri(null);
    if (!sourceUri || sourceUri === targetUri) return;
    ev.preventDefault();
    const order = bufferState.order;
    const from = order.indexOf(sourceUri);
    const to = order.indexOf(targetUri);
    if (from === -1 || to === -1) return;
    reorderBuffers(from, to);
  }

  function onDragEnd() {
    setDragOverUri(null);
  }

  return (
    <Show when={bufferState.order.length > 0}>
      <div
        ref={stripEl}
        data-testid="editor-tab-strip"
        role="tablist"
        class="flex h-7 shrink-0 items-center overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-strong)] text-base"
      >
        <For each={bufferState.order}>
          {(uri) => {
            const buf = () => bufferState.buffers[uri];
            const active = () => bufferState.activeUri === uri;
            const isPreview = () => buf()?.isPreview === true;
            const isDropTarget = () => dragOverUri() === uri;
            return (
              <Show when={buf()}>
                {(b) => (
                  <div
                    data-testid="editor-tab"
                    data-buffer-uri={uri}
                    data-active={active() ? "true" : undefined}
                    data-dirty={b().dirty ? "true" : undefined}
                    data-preview={isPreview() ? "true" : undefined}
                    data-drop-target={isDropTarget() ? "true" : undefined}
                    role="tab"
                    aria-selected={active()}
                    draggable={true}
                    onDragStart={(ev) => onDragStart(ev, uri)}
                    onDragOver={(ev) => onDragOver(ev, uri)}
                    onDragLeave={() => onDragLeave(uri)}
                    onDrop={(ev) => onDrop(ev, uri)}
                    onDragEnd={onDragEnd}
                    onDblClick={() => pinBuffer(uri)}
                    class={
                      "group relative flex h-7 shrink-0 items-center gap-1.5 border-r border-[var(--border)] px-3 text-base " +
                      (active()
                        ? "bg-[var(--bg)] text-[var(--fg)]"
                        : "text-[var(--fg-secondary)] hover:bg-[var(--surface-hover)]") +
                      (isDropTarget() ? " ring-1 ring-inset ring-[var(--accent)]" : "")
                    }
                  >
                    <button
                      type="button"
                      data-testid="editor-tab-pick"
                      onClick={() => setActiveBuffer(uri)}
                      class="inline-flex items-center gap-1 bg-transparent text-left text-base text-inherit"
                    >
                      <Show when={b().dirty}>
                        <span
                          aria-hidden="true"
                          data-testid="editor-tab-dirty-dot"
                          class="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                        />
                      </Show>
                      {(() => {
                        const Icon = getFileIcon(b().filePath);
                        return <Icon class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />;
                      })()}
                      <span
                        class={
                          "font-mono " + (isPreview() ? "italic text-[var(--fg-secondary)]" : "")
                        }
                      >
                        {basename(b().filePath)}
                      </span>
                      <Show when={b().status === "loading"}>
                        <span class="text-xs text-[var(--dim)]">loading…</span>
                      </Show>
                      <Show when={b().status === "error"}>
                        <span class="text-xs text-[var(--red-foreground,var(--red))]">!</span>
                      </Show>
                      <Show when={b().saving}>
                        <span class="text-xs text-[var(--dim)]">saving…</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      data-testid="editor-tab-close"
                      aria-label={`Close ${b().filePath}`}
                      title={b().dirty ? "Unsaved changes" : "Close"}
                      onClick={() => tryClose(uri)}
                      class="inline-flex h-4 w-4 items-center justify-center rounded text-[var(--dim)] opacity-0 transition-opacity hover:bg-[var(--surface-active)] hover:text-[var(--fg)] focus:opacity-100 group-hover:opacity-100"
                    >
                      <X class="h-3 w-3" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/**
 * Minimal CSS.escape polyfill — buffer URIs contain `/` and `:` so we
 * can't dump them into a querySelector verbatim. Falls back to the
 * native CSS.escape when available.
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
