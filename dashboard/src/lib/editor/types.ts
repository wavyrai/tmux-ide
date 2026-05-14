/**
 * Editor file types — Solid port of emdash's
 * `lib/editor/types.ts`.
 *
 * `ManagedFile` is the shape every renderer takes: a stable path,
 * the detected kind, optional content (only set for image data
 * URLs; Monaco-backed files keep their content inside the
 * registry's model), and a size for the too-large case. The
 * dispatch table picks a renderer based on `kind`; the renderer
 * reads buffer text for `text` / `markdown` / `svg` through the
 * model registry.
 */

/** All possible kinds a file can be in once opened by the editor. */
export type ManagedFileKind = "text" | "markdown" | "svg" | "image" | "too-large" | "binary";

/**
 * A file ready for one of the renderers below. Path is workspace-
 * relative; content is only populated for `image` kinds (data URL
 * fetched by the daemon). Everything else reads from the Monaco
 * model registry.
 */
export interface ManagedFile {
  path: string;
  kind: ManagedFileKind;
  /** Data URL for images; empty for Monaco-backed files. */
  content: string;
  /** True only while the image data-URL is being fetched. */
  isLoading: boolean;
  /** Only set for `kind === 'too-large'`. */
  totalSize?: number | null;
  /** Stable identifier — used as a Solid key in tab strips. */
  tabId: string;
}

/**
 * Renderer descriptor. The `kind` slot tracks whether a previewable
 * file (markdown / svg) is showing the rendered preview or the raw
 * source mode (lands in G17-P4 alongside the source toggle).
 */
export type FileRendererKind =
  | "text"
  | "markdown"
  | "markdown-source"
  | "svg"
  | "svg-source"
  | "image"
  | "too-large"
  | "binary";

export interface FileRendererData {
  kind: FileRendererKind;
}
