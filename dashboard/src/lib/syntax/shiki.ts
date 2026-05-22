/**
 * Shiki singleton — lazy-loaded highlighter for read-only previews
 * and markdown code fences. Pulls a small popular-language bundle on
 * first use and reuses the same `Highlighter` instance for the rest
 * of the session.
 *
 * Themes are chosen from the Solid settings store's `themeId`: light
 * themes map to `github-light`, dark themes to `github-dark`.
 */

import type { BundledLanguage, BundledTheme, Highlighter } from "shiki";
import { createHighlighter } from "shiki";
import { settings, type ThemeId } from "@/lib/settings";

const POPULAR_LANGS: readonly BundledLanguage[] = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "markdown",
  "css",
  "html",
  "yaml",
  "shellscript",
  "python",
  "go",
  "rust",
  "sql",
  "docker",
  "toml",
];

const LIGHT_THEME: BundledTheme = "github-light";
const DARK_THEME: BundledTheme = "github-dark";
const THEMES: readonly BundledTheme[] = [LIGHT_THEME, DARK_THEME];

const LIGHT_THEME_IDS: ReadonlySet<ThemeId> = new Set<ThemeId>(["light", "gruvbox-light"]);

// Extension → shiki bundled-language id. Returns `null` when shiki
// doesn't have a bundle — callers should fall back to a plaintext
// renderer in that case.
const EXTENSION_LANG: Record<string, BundledLanguage> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  yml: "yaml",
  yaml: "yaml",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  py: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  toml: "toml",
  dockerfile: "docker",
};

let highlighterPromise: Promise<Highlighter> | null = null;

/** Lazy-load (and reuse) the singleton highlighter. */
export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...THEMES],
      langs: [...POPULAR_LANGS],
    });
  }
  return highlighterPromise;
}

/** Pick the shiki theme that pairs with the current dashboard theme. */
export function activeShikiTheme(): BundledTheme {
  return LIGHT_THEME_IDS.has(settings().themeId) ? LIGHT_THEME : DARK_THEME;
}

/**
 * Resolve a shiki language id for a file path. Returns `null` when
 * the extension isn't in the popular-lang bundle — the caller should
 * fall through to a plaintext renderer.
 */
export function languageForFile(filePath: string): BundledLanguage | null {
  const base = filePath.split("/").pop() ?? filePath;
  // Dockerfile by basename (no extension).
  if (/^Dockerfile(\..+)?$/i.test(base)) return "docker";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXTENSION_LANG[ext] ?? null;
}

/**
 * Highlight `content` for `lang`. If shiki doesn't ship the language
 * bundled, lazy-loads it before highlighting. Returns the inner
 * `<pre><code>` HTML for direct embedding.
 */
export async function highlightCode(content: string, lang: BundledLanguage): Promise<string> {
  const highlighter = await getHighlighter();
  if (!highlighter.getLoadedLanguages().includes(lang)) {
    try {
      await highlighter.loadLanguage(lang);
    } catch {
      // Unknown / unbundled language — caller already handled the
      // null-language case, so just render unstyled.
      return `<pre class="shiki"><code>${escapeHtml(content)}</code></pre>`;
    }
  }
  return highlighter.codeToHtml(content, {
    lang,
    theme: activeShikiTheme(),
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
