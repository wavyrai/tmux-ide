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

function graphemes(text: string): string[] {
  const Segmenter = Intl.Segmenter;
  if (Segmenter)
    return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
      (entry) => entry.segment,
    );
  return [...text];
}
