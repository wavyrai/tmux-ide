/**
 * SVG renderer — Solid port of emdash's `svg-renderer.tsx`.
 *
 * Reads the SVG source from the Monaco model registry (the
 * buffer / disk URI for the file), wraps it in a Blob URL, and
 * renders it via `<img>`. The Blob URL is revoked on cleanup +
 * whenever the source content changes (a `createMemo` re-runs).
 *
 * `useBufferVersion()` is the reactive handle: when the underlying
 * Monaco model's content version ticks, the memo re-evaluates and
 * picks up the new value. Editing in source mode and flipping back
 * to preview shows your changes immediately — no re-fetch.
 *
 * The source-toggle button is wired via `onEditSource` — the host
 * (Files view, G17-P4) decides where the toggle routes (typically
 * `editorView.updateRenderer(filePath, () => ({ kind: 'svg-source' }))`).
 */

import { Pencil } from "lucide-solid";
import { createMemo, onCleanup, Show } from "solid-js";
import { modelRegistry } from "@/lib/monaco/model-registry";
import { useBufferVersion } from "@/lib/monaco/use-model";
import { buildMonacoModelPath, toDiskUri } from "@/lib/monaco/model-path";

interface SvgRendererProps {
  /** Workspace-relative file path. */
  filePath: string;
  /** Workspace root used to build the Monaco model URI. */
  modelRootPath: string;
  /** Called when the user clicks the "Edit source" button. */
  onEditSource?: (filePath: string) => void;
}

export function SvgRenderer(props: SvgRendererProps) {
  const bufferUri = () => buildMonacoModelPath(props.modelRootPath, props.filePath);
  // Either the buffer (`file://`) or the disk mirror (`disk://`)
  // has the SVG source. Prefer the buffer because edits flow there
  // first, fall back to disk for the read-only preview case.
  const bufferVersion = useBufferVersion(bufferUri());
  const fileName = () => props.filePath.split("/").pop() ?? props.filePath;

  const svgUrl = createMemo<string>((prevUrl) => {
    // Subscribe to the buffer version so the memo re-runs on edit.
    void bufferVersion();
    const content =
      modelRegistry.getValue(bufferUri()) ?? modelRegistry.getValue(toDiskUri(bufferUri())) ?? "";
    // Revoke the previous URL so we don't leak Blobs on every edit.
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    if (!content) return "";
    return URL.createObjectURL(new Blob([content], { type: "image/svg+xml" }));
  }, "");

  onCleanup(() => {
    const url = svgUrl();
    if (url) URL.revokeObjectURL(url);
  });

  return (
    <div
      data-testid="editor-svg-renderer"
      class="relative flex h-full items-center justify-center overflow-auto p-4"
    >
      <img src={svgUrl()} alt={fileName()} class="max-h-full max-w-full object-contain" />
      <Show when={props.onEditSource}>
        <button
          type="button"
          data-testid="editor-svg-edit-source"
          class="absolute right-3 top-3 z-10 rounded bg-[var(--bg)]/80 p-1 text-[var(--dim)] hover:bg-[var(--surface-active)] hover:text-[var(--fg)]"
          onClick={() => props.onEditSource?.(props.filePath)}
          title="Edit source"
          aria-label="Edit source"
        >
          <Pencil class="h-3.5 w-3.5" />
        </button>
      </Show>
    </div>
  );
}
