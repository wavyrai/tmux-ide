/**
 * Pure helpers for the proposed-plan card:
 *
 *   - `proposedPlanTitle(md)` — first heading from the markdown,
 *     stripped of leading `#` chars; falls back to `null` so the
 *     caller can render a generic "Proposed plan" label.
 *   - `buildCollapsedProposedPlanPreviewMarkdown(md, opts)` — take
 *     the first N lines of the body so the card can show a hint
 *     even when collapsed.
 *   - `buildProposedPlanMarkdownFilename(md)` — derive a kebab-case
 *     `.md` filename from the plan title so the download button has
 *     a stable, readable name.
 *   - `normalizePlanMarkdownForExport(md)` — trim trailing
 *     whitespace, force a single trailing newline so the on-disk
 *     diff is clean.
 *   - `stripDisplayedPlanMarkdown(md)` — same body the card renders
 *     (currently identity; carried as a hook so a future tweak
 *     like "drop the first heading from the rendered preview"
 *     lands without touching the card).
 *
 * Pure — no Solid, no DOM. All functions are deterministic so they
 * pin cleanly under vitest.
 */

const MAX_FILENAME_LENGTH = 64;
const DEFAULT_PROPOSED_PLAN_FILENAME = "proposed-plan.md";

export function proposedPlanTitle(markdown: string): string | null {
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) {
      return line.replace(/^#+\s*/, "").trim() || null;
    }
    // Non-heading first line — treat the first sentence as the title.
    return line.length > 80 ? `${line.slice(0, 77)}...` : line;
  }
  return null;
}

export function stripDisplayedPlanMarkdown(markdown: string): string {
  return markdown;
}

export function normalizePlanMarkdownForExport(markdown: string): string {
  const trimmed = markdown.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
  return `${trimmed}\n`;
}

export interface CollapsedPreviewOptions {
  maxLines?: number;
}

export function buildCollapsedProposedPlanPreviewMarkdown(
  markdown: string,
  options: CollapsedPreviewOptions = {},
): string {
  const maxLines = options.maxLines ?? 10;
  if (maxLines <= 0) return "";
  const lines = markdown.split(/\r?\n/);
  if (lines.length <= maxLines) return markdown;
  return lines.slice(0, maxLines).join("\n");
}

export function buildProposedPlanMarkdownFilename(markdown: string): string {
  const title = proposedPlanTitle(markdown);
  if (!title) return DEFAULT_PROPOSED_PLAN_FILENAME;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FILENAME_LENGTH);
  if (slug.length === 0) return DEFAULT_PROPOSED_PLAN_FILENAME;
  return `${slug}.md`;
}

/**
 * Trigger a browser download by spinning up a transient `<a>` with
 * a `text/markdown` blob URL. Safe on every modern browser; no
 * external dependency. Returns the blob URL that was used so the
 * caller can revoke it manually if it captured it (the helper
 * already revokes after one tick).
 */
export function downloadPlanAsTextFile(filename: string, contents: string): string {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return url;
}

/**
 * Heuristic that decides whether the plan is long enough to merit
 * a collapsed preview + expand affordance. Matches the upstream
 * threshold (`> 900 chars` OR `> 20 lines`) so the visual treatment
 * stays consistent.
 */
export function isProposedPlanCollapsible(markdown: string): boolean {
  if (markdown.length > 900) return true;
  return markdown.split(/\r?\n/).length > 20;
}
