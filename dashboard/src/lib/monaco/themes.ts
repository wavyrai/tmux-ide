/**
 * Monaco theme definitions, wired against the dashboard's existing
 * design tokens (`--bg`, `--fg`, `--accent`, `--border`, etc — see
 * `src/styles.css`).
 *
 * Mechanics mirror emdash's `monaco-themes.ts`: paint each CSS custom
 * property to a 1×1 canvas pixel, read back the sRGB bytes, and emit
 * a Monaco-compatible hex string. The canvas trick is the only safe
 * way to handle modern CSS colour spaces (`color(display-p3 ...)`,
 * `oklch(...)`) — Monaco's color parser only takes hex.
 *
 * Two themes register here: `custom-dark` (default) and `custom-light`.
 * Switching themes at the dashboard level is just
 * `monaco.editor.setTheme('custom-light')` — the dashboard's
 * `lib/settings.ts` already writes `data-theme` on `<html>`, so the
 * CSS variables resolve to the active theme's palette before each
 * registration call.
 */

import type * as monaco from "monaco-editor";

type MonacoColors = Record<string, string>;

/**
 * Convert any CSS color string to a Monaco-compatible hex value via
 * a 1×1 canvas. Handles hex / rgb / hsl / oklch / display-p3 alike;
 * out-of-gamut values are clamped to sRGB (imperceptible for chrome
 * colors).
 */
function cssColorToHex(cssColor: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#000000";
  ctx.fillStyle = cssColor.trim();
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = (n: number) => (n ?? 0).toString(16).padStart(2, "0");
  return a !== undefined && a < 255
    ? `#${hex(r ?? 0)}${hex(g ?? 0)}${hex(b ?? 0)}${hex(a)}`
    : `#${hex(r ?? 0)}${hex(g ?? 0)}${hex(b ?? 0)}`;
}

/**
 * Read the dashboard's design tokens for a given theme. Mounts a
 * throwaway `<div data-theme="...">` to force the CSS variables to
 * resolve under that theme, reads them, then removes the element.
 *
 * `data-theme` overrides for our dark themes (`dark`, `catppuccin`,
 * `dracula`, `tokyonight`, ...) are aliased to "custom-dark" + the
 * lights to "custom-light" — Monaco itself only needs to swap between
 * those two palettes; per-theme nuance comes from the underlying
 * tokens.
 */
function readMonacoVarsForTheme(themeId: string): MonacoColors {
  if (typeof document === "undefined") return {};
  const el = document.createElement("div");
  el.dataset.theme = themeId;
  el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;";
  document.body.appendChild(el);
  const style = getComputedStyle(el);
  const get = (v: string) => style.getPropertyValue(v).trim();

  // Map design tokens → Monaco theme keys. Token names match
  // dashboard/src/styles.css (no `--monaco-*` aliases needed).
  const mapping: Array<[string, string]> = [
    ["--bg", "editor.background"],
    ["--fg", "editor.foreground"],
    ["--surface-hover", "editor.lineHighlightBackground"],
    ["--dim", "editorLineNumber.foreground"],
    ["--bg-strong", "editorGutter.background"],
    ["--diff-add-bg", "diffEditor.insertedLineBackground"],
    ["--diff-add-text", "diffEditor.insertedTextBackground"],
    ["--diff-del-bg", "diffEditor.removedLineBackground"],
    ["--diff-del-text", "diffEditor.removedTextBackground"],
    ["--border", "diffEditor.border"],
    ["--surface", "diffEditor.unchangedRegionBackground"],
  ];

  const colors: MonacoColors = {};
  for (const [cssVar, monacoToken] of mapping) {
    const value = get(cssVar);
    if (value) colors[monacoToken] = cssColorToHex(value);
  }
  el.remove();
  return colors;
}

/**
 * Register `custom-dark` + `custom-light` on the Monaco namespace.
 * Idempotent — Monaco's `defineTheme` overwrites on a name collision.
 */
export function defineMonacoThemes(m: typeof monaco): void {
  m.editor.defineTheme("custom-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: readMonacoVarsForTheme("dark"),
  });
  m.editor.defineTheme("custom-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: readMonacoVarsForTheme("light"),
  });
}

/**
 * Map a dashboard theme id (`dark`, `light`, `catppuccin`, ...) to
 * the Monaco theme name the pool should activate. Anything other than
 * the explicit "light" themes lands on `custom-dark`.
 */
export function getMonacoThemeForId(themeId: string): "custom-dark" | "custom-light" {
  return themeId === "light" || themeId === "gruvbox-light" ? "custom-light" : "custom-dark";
}
