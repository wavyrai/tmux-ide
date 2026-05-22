/**
 * Canonical markdown → shiki-highlighted HTML pipeline.
 *
 * Composes chat-solid's `renderMarkdown` (marked + DOMPurify, the one
 * real markdown renderer — we never hand-roll a second parser) with a
 * post-pass that swaps every fenced code block for shiki's themed
 * output via `@/lib/syntax/shiki`.
 *
 * Two consumers:
 *   - The plans surface renders a plan body string through
 *     `renderMarkdownHighlighted`.
 *   - chat-solid is a standalone lib and cannot import dashboard
 *     code, so it takes an injected `highlightCodeFences` instead —
 *     ChatView passes `highlightFences` here through the mount.
 */

import { renderMarkdown, type MarkdownFileLinkMeta } from "@tmux-ide/chat-solid";
import { activeShikiTheme, highlightCode } from "@/lib/syntax/shiki";
import type { BundledLanguage } from "shiki";

export type { MarkdownFileLinkMeta };

/**
 * Replace every `<pre><code class="language-X">…</code></pre>` block
 * with shiki's themed `<pre>`. Blocks without a recognised language
 * (or when shiki has no bundle for it) are left as the DOMPurified
 * `<pre>` fallback. Browser-only — SSR callers get the input back.
 */
export async function highlightFences(html: string): Promise<string> {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;
  const blocks = Array.from(root.querySelectorAll("pre > code"));
  // Read the active theme once so a mid-batch theme flip can't tear
  // adjacent blocks across two palettes.
  void activeShikiTheme();
  await Promise.all(
    blocks.map(async (codeEl) => {
      const langClass = Array.from(codeEl.classList).find((c) => c.startsWith("language-"));
      if (!langClass) return;
      const lang = langClass.slice("language-".length) as BundledLanguage;
      const text = codeEl.textContent ?? "";
      try {
        const replacement = await highlightCode(text, lang);
        const pre = codeEl.parentElement;
        if (!pre) return;
        const tpl = doc.createElement("template");
        tpl.innerHTML = replacement;
        const next = tpl.content.firstElementChild;
        if (next) pre.replaceWith(next);
      } catch {
        // Unknown / unbundled language — leave the block alone.
      }
    }),
  );
  return root.innerHTML;
}

/**
 * Render a markdown string to sanitized, shiki-highlighted HTML.
 * `cwd` is forwarded to the file-link resolver so `[x](./a.ts)`
 * anchors get the same data attributes the chat surface uses.
 */
export async function renderMarkdownHighlighted(
  markdown: string,
  opts: { cwd?: string } = {},
): Promise<string> {
  const base = renderMarkdown(markdown, opts);
  return highlightFences(base);
}
