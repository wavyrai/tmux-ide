/**
 * Marks of the agent harnesses the setup prompt is for: Claude Code, Codex
 * and Cursor. Claude Code and Codex are static SVG files with their own
 * fills (the Codex gradient lives inside its file, so ids never clash); they
 * load once and stay out of every page's HTML and client JavaScript. Cursor
 * is drawn inline in currentColor so it follows the pill's ink in both
 * themes. Decorative: the surrounding control names the act.
 *
 * Sources: Claude Code and Cursor are Simple Icons (CC0 1.0); Codex is from
 * lobe-icons (MIT). See docs/THIRD_PARTY_NOTICES.md.
 */
const CURSOR_PATH =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";

export function HarnessMarks({ size = 16 }: { size?: number }) {
  return (
    <span aria-hidden className="harness-marks">
      <img src="/marks/claude-code.svg" alt="" width={size} height={size} decoding="async" />
      <img src="/marks/codex.svg" alt="" width={size} height={size} decoding="async" />
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d={CURSOR_PATH} />
      </svg>
    </span>
  );
}
