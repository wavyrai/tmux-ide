/**
 * Per-pane agent chips — the border label rendered INSIDE an adopted session.
 *
 * Where the status bar ({@link ./statusline.ts}) shows the fleet rollup (one
 * glyph per session), a chip shows per-PANE truth: what agent is running in
 * THIS pane and its live state — `claude · working`, `codex · blocked`. The
 * updater writes each adopted pane's chip into a `@tmux_ide_chip` pane option
 * and `adoptSession` points `pane-border-format` at it (falling back to the
 * pane title when empty). `paneChip` is pure (tested); the io lives in the
 * updater.
 */
import { DEFAULT_THEME, type AppTheme } from "../../lib/app-config.ts";
import type { AgentStatus } from "../detect/classify.ts";
import { statusStyle } from "./statusline.ts";

/**
 * PURE — build a pane's chip string with tmux `#[...]` markup, or `""` for a
 * non-agent pane (`agent === null`, e.g. a raw shell). An empty chip clears the
 * pane option so the border format falls back to the pane title. The chip is
 * `<agent> · <status>` styled via the shared {@link statusStyle} so it reads the
 * same as its session's rollup glyph — one palette across the bar and the chips.
 */
export function paneChip(
  agent: string | null,
  status: AgentStatus,
  theme: AppTheme = DEFAULT_THEME,
): string {
  if (!agent) return "";
  return `${statusStyle(status, theme)}${agent} · ${status}#[default]`;
}
