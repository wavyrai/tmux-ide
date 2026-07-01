/**
 * Pane snapshot reader for agent-state detection.
 *
 * Reads the bottom-buffer text of a tmux pane and normalizes it into a
 * `PaneSnapshot` — the raw evidence later detectors classify into
 * blocked/working/done/idle. The parsing (`parseSnapshot`) is pure and
 * unit-tested; `readPaneSnapshot` is the thin tmux I/O wrapper.
 */
import { captureRecent } from "@tmux-ide/tmux-bridge";

export interface PaneSnapshot {
  /** Last N non-empty lines, ANSI-stripped, trailing whitespace trimmed. */
  bottomNonEmpty: string[];
  /** ANSI-stripped joined snapshot text. */
  text: string;
  /** Original raw capture, kept for ansi-format debugging. */
  raw: string;
}

// Well-known ANSI escape matcher (ansi-regex): SGR/cursor CSI sequences plus
// OSC strings terminated by BEL.
/* eslint-disable no-control-regex */
const ANSI =
  /[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/* eslint-enable no-control-regex */

/** Strip ANSI escape sequences from a string. */
function stripAnsi(input: string): string {
  return input.replace(ANSI, "");
}

const DEFAULT_LINES = 20;

/**
 * Normalize raw pane text into a `PaneSnapshot`. Pure — never throws.
 *
 * @param raw Raw pane capture (may contain ANSI escapes).
 * @param opts.lines Number of trailing non-empty lines to keep (default 20).
 */
export function parseSnapshot(raw: string, opts: { lines?: number } = {}): PaneSnapshot {
  const lines = opts.lines ?? DEFAULT_LINES;
  const text = stripAnsi(raw ?? "");

  const nonEmpty = text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);

  const bottomNonEmpty = lines > 0 ? nonEmpty.slice(-lines) : [];

  return { bottomNonEmpty, text, raw: raw ?? "" };
}

/**
 * Capture a pane's recent buffer and parse it into a `PaneSnapshot`.
 * On any tmux error, returns an empty snapshot rather than throwing.
 *
 * @param target tmux pane target (session, window, or pane id).
 * @param opts.lines Number of trailing non-empty lines to keep (default 20).
 */
export function readPaneSnapshot(target: string, opts: { lines?: number } = {}): PaneSnapshot {
  const lines = opts.lines ?? DEFAULT_LINES;
  try {
    const raw = captureRecent(target, lines);
    return parseSnapshot(raw, { lines });
  } catch {
    return { bottomNonEmpty: [], text: "", raw: "" };
  }
}
