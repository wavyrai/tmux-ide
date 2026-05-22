import DOMPurify from "dompurify";
import { marked, Renderer, type Tokens } from "marked";
import { resolveMarkdownFileLinkMeta, type MarkdownFileLinkMeta } from "./markdownLinks";

marked.setOptions({
  breaks: true,
  gfm: true,
});

const DEFAULT_RENDERER = new Renderer();

export interface RenderMarkdownOptions {
  /**
   * Project root used to resolve relative paths in file links. When
   * provided, a `[label](./src/x.ts)` href resolves to `<cwd>/src/x.ts`
   * before it lands in the data attribute. Relative paths with no cwd
   * fall through verbatim — the host decides how to resolve them.
   */
  cwd?: string;
}

/**
 * Custom link renderer that decorates file-link anchors with
 * `data-file-path` / `data-file-line` / `data-file-column` so the host
 * can intercept clicks via event delegation. The href is rewritten to a
 * bare workspace path so DOMPurify (which strips the `file://` scheme by
 * default) doesn't drop the anchor.
 *
 * Non-file links pass through to the default renderer — same `<a
 * href="...">` shape the previous renderer emitted.
 */
function fileAwareLinkRenderer(opts: RenderMarkdownOptions): Renderer["link"] {
  return function link(this: Renderer, { href, title, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens);
    const meta = resolveMarkdownFileLinkMeta(href, opts.cwd);
    if (meta) {
      return renderFileLinkAnchor(meta, text, title);
    }
    return DEFAULT_RENDERER.link.call(this, { href, title, tokens } as Tokens.Link);
  };
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderFileLinkAnchor(
  meta: MarkdownFileLinkMeta,
  text: string,
  title?: string | null,
): string {
  const titleAttr = title
    ? ` title="${escapeAttr(title)}"`
    : ` title="${escapeAttr(meta.displayPath)}"`;
  const lineAttr =
    meta.line !== undefined ? ` data-file-line="${escapeAttr(String(meta.line))}"` : "";
  const colAttr =
    meta.column !== undefined ? ` data-file-column="${escapeAttr(String(meta.column))}"` : "";
  return (
    `<a class="chat-file-link" href="${escapeAttr(meta.targetPath)}"` +
    ` data-file-path="${escapeAttr(meta.filePath)}"` +
    `${lineAttr}${colAttr}${titleAttr}>${text}</a>`
  );
}

export function renderMarkdown(input: string, opts: RenderMarkdownOptions = {}): string {
  const renderer = new Renderer();
  renderer.link = fileAwareLinkRenderer(opts);
  const dirty = marked.parse(input, { async: false, renderer }) as string;
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["data-file-path", "data-file-line", "data-file-column"],
  });
}

export type { MarkdownFileLinkMeta };
