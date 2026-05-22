/**
 * ShikiViewer — fast read-only syntax-highlighted preview.
 *
 * Used for preview-mode buffer tabs (single-click in the file rail).
 * Double-click pins the tab and FilesSurface swaps to the writable
 * Monaco editor — see the `buffer.isPreview` flag added in EDITOR-2.
 *
 * Highlighting is deferred to the shiki singleton in
 * `@/lib/syntax/shiki`; the singleton lazy-loads grammars as needed
 * so mounts stay cheap.
 */

import { createEffect, createSignal, on, Show, type JSX } from "solid-js";
import { activeShikiTheme, highlightCode, languageForFile } from "@/lib/syntax/shiki";

interface ShikiViewerProps {
  filePath: string;
  content: string;
  /** Override the detected language. */
  language?: string;
}

const MAX_HIGHLIGHT_BYTES = 200_000;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function ShikiViewer(props: ShikiViewerProps): JSX.Element {
  const [html, setHtml] = createSignal<string>("");
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    on([() => props.filePath, () => props.content, () => activeShikiTheme()], async () => {
      setError(null);
      const lang =
        (props.language as ReturnType<typeof languageForFile>) ?? languageForFile(props.filePath);
      if (!lang) {
        setHtml(`<pre class="shiki"><code>${escapeHtml(props.content)}</code></pre>`);
        return;
      }
      if (props.content.length > MAX_HIGHLIGHT_BYTES) {
        // Fall back to a plain `<pre>` to keep the preview snappy for
        // pasted lockfiles / generated dumps. The writable Monaco
        // editor handles the heavy lifting once the tab is pinned.
        setHtml(`<pre class="shiki"><code>${escapeHtml(props.content)}</code></pre>`);
        return;
      }
      try {
        const out = await highlightCode(props.content, lang);
        setHtml(out);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setHtml(`<pre class="shiki"><code>${escapeHtml(props.content)}</code></pre>`);
      }
    }),
  );

  return (
    <div
      data-testid="editor-shiki-viewer"
      data-file-path={props.filePath}
      class="relative h-full overflow-auto bg-[var(--bg)] text-base leading-[1.5]"
    >
      <Show when={error()}>
        <div
          data-testid="editor-shiki-error"
          class="border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 py-1 text-xs text-[var(--red-foreground,var(--red))]"
        >
          {error()}
        </div>
      </Show>
      <div
        class="shiki-host px-4 py-3 font-mono"
        // eslint-disable-next-line solid/no-innerhtml
        innerHTML={html()}
      />
    </div>
  );
}
