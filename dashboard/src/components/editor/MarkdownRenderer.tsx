/**
 * Markdown renderer — Solid port of emdash's
 * `markdown-renderer.tsx`.
 *
 * Reads the source from the Monaco model registry (buffer URI →
 * disk URI fallback), runs it through chat-solid's `renderMarkdown`
 * (DOMPurify-wrapped marked), and dangerously sets the resulting
 * HTML inside the dashboard's `.chat-markdown` block — same
 * stylesheet the chat surface uses, so the visual treatment is
 * consistent across both.
 *
 * Reactive: `useBufferVersion()` ticks on every edit; the
 * `createMemo` re-runs and the rendered HTML updates without a
 * polling loop. Editing in source mode and flipping back to
 * preview shows your changes immediately — no re-fetch.
 */

import { Eye, Pencil } from "lucide-solid";
import { createMemo, Show } from "solid-js";
import { renderMarkdown } from "@tmux-ide/chat-solid";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { useBufferVersion } from "@/lib/monaco/use-model";
import { buildMonacoModelPath, toDiskUri } from "@/lib/monaco/model-path";

interface MarkdownRendererProps {
  filePath: string;
  modelRootPath: string;
  /**
   * Toggles the renderer's `kind` slot to `'markdown-source'`. The
   * host (Files view, G17-P4) decides what that means — typically
   * "swap the renderer for a Monaco code editor on the same buffer
   * URI".
   */
  onEditSource?: (filePath: string) => void;
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
  const bufferUri = () => buildMonacoModelPath(props.modelRootPath, props.filePath);
  const bufferVersion = useBufferVersion(bufferUri());

  const html = createMemo<string>(() => {
    // Subscribe to the buffer's version so the memo re-evaluates on
    // every edit. The void read is enough — Solid tracks the call.
    void bufferVersion();
    const content =
      modelRegistry.getValue(bufferUri()) ?? modelRegistry.getValue(toDiskUri(bufferUri())) ?? "";
    return renderMarkdown(content);
  });

  return (
    <div
      data-testid="editor-markdown-renderer"
      class="relative h-full overflow-y-auto bg-[var(--bg)]"
    >
      <div class="sticky top-3 z-10 float-right mr-3 inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5">
        <button
          type="button"
          data-testid="editor-markdown-toggle-preview"
          aria-label="Preview"
          aria-pressed="true"
          class="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--accent)]"
          disabled
        >
          <Eye class="h-3.5 w-3.5" />
        </button>
        <Show when={props.onEditSource}>
          <button
            type="button"
            data-testid="editor-markdown-toggle-source"
            aria-label="Edit source"
            class="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--dim)] hover:bg-[var(--surface-active)] hover:text-[var(--fg)]"
            onClick={() => props.onEditSource?.(props.filePath)}
          >
            <Pencil class="h-3.5 w-3.5" />
          </button>
        </Show>
      </div>
      <div
        class="chat-markdown w-full max-w-3xl px-8 py-8"
        // eslint-disable-next-line solid/no-innerhtml
        innerHTML={html()}
      />
    </div>
  );
}
