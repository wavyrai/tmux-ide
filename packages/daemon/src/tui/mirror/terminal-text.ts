import stringWidth from "string-width";

const GENERATED_SESSION_SUFFIX = /-[a-f0-9]{20}$/u;

/** Keep daemon routing opaque while presenting the name the user actually chose. */
export function friendlySessionLabel(sessionName: string): string {
  return sessionName.replace(GENERATED_SESSION_SUFFIX, "");
}

export function terminalDisplayWidth(text: string): number {
  return stringWidth(text);
}

/**
 * Clip text to a terminal-cell budget without splitting a grapheme cluster.
 *
 * This utility deliberately has no dependency on any workspace feature.
 */
export function clipTerminal(text: string, width: number): string {
  if (width <= 0) return "";
  if (terminalDisplayWidth(text) <= width) return text;
  const ellipsis = "…";
  const limit = Math.max(0, width - terminalDisplayWidth(ellipsis));
  let out = "";
  let used = 0;
  for (const segment of graphemes(text)) {
    const segmentWidth = terminalDisplayWidth(segment);
    if (used + segmentWidth > limit) break;
    out += segment;
    used += segmentWidth;
  }
  return out + ellipsis;
}

/** Keep an append-only input's caret visible, without splitting graphemes. */
export function clipTerminalEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (terminalDisplayWidth(text) <= width) return text;
  let tail = "";
  for (const segment of graphemes(text).reverse()) {
    if (terminalDisplayWidth(segment + tail) > width - 1) break;
    tail = segment + tail;
  }
  return `…${tail}`;
}

function graphemes(text: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter)
    return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (entry) => entry.segment,
    );
  return [...text];
}

/** PURE — greedy word-wrap for terminal prose (never returns empty for
 *  non-empty text; words longer than the width hard-break). */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line.length === 0) {
        let w = word;
        while (w.length > width) {
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        line = w;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        let w = word;
        while (w.length > width) {
          out.push(w.slice(0, width));
          w = w.slice(width);
        }
        line = w;
      }
    }
    if (line.length > 0 || para.length === 0) out.push(line);
  }
  return out.length > 0 ? out : [""];
}
