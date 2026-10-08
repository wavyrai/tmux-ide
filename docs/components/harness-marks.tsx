import { SpriteIcon } from "@/components/icons/sprite-icon";

/**
 * Marks of the agent harnesses the setup prompt is for: Claude Code, Codex
 * and Cursor. Claude Code and Codex are static SVG files with their own
 * fills (the Codex gradient lives inside its file, so ids never clash); they
 * load once and stay out of every page's HTML and client JavaScript. Cursor
 * comes from the icon sprite in currentColor so it follows the pill's ink in
 * both themes. Decorative: the surrounding control names the act.
 *
 * Sources: Claude Code and Cursor are Simple Icons (CC0 1.0); Codex is from
 * lobe-icons (MIT). See docs/THIRD_PARTY_NOTICES.md.
 */
export function HarnessMarks({ size = 16 }: { size?: number }) {
  return (
    <span aria-hidden className="harness-marks">
      <img src="/marks/claude-code.svg" alt="" width={size} height={size} decoding="async" />
      <img src="/marks/codex.svg" alt="" width={size} height={size} decoding="async" />
      <SpriteIcon name="cursor" size={size} />
    </span>
  );
}
