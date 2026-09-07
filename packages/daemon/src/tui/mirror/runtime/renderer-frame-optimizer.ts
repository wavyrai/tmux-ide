const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const RESET = "\x1b[0m";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

interface Token {
  text: string;
  kind: "text" | "cup" | "sgr" | "cursor";
}

/**
 * Elide only redundant reset/CUP/identical-SGR transitions in a complete frame.
 * This deliberately rejects OSC, images, other terminal commands and malformed
 * UTF-8. It never changes cursor motion, text, the final reset or frame markers.
 * No style is assumed at frame entry: a reset must establish a known baseline.
 */
export function optimizeRendererFrame(bytes: Uint8Array): Uint8Array {
  let frame: string;
  try {
    frame = decoder.decode(bytes);
  } catch {
    return bytes;
  }
  if (!frame.startsWith(FRAME_START) || !frame.endsWith(FRAME_END)) return bytes;
  const body = frame.slice(FRAME_START.length, -FRAME_END.length);
  const tokens: Token[] = [];
  let position = 0;
  while (position < body.length) {
    if (body[position] !== "\x1b") {
      const end = body.indexOf("\x1b", position);
      const text = body.slice(position, end < 0 ? body.length : end);
      // eslint-disable-next-line no-control-regex -- Reject terminal control bytes in text runs.
      if (/[\x00-\x1f\x7f-\x9f]/u.test(text)) return bytes;
      tokens.push({ text, kind: "text" });
      position += text.length;
      continue;
    }
    // eslint-disable-next-line no-control-regex -- Match only explicitly supported ANSI controls.
    const match = /^\x1b\[(?:([1-9]\d*;[1-9]\d*)H|([\d;]+)m|(\?25[hl]))/.exec(body.slice(position));
    if (!match) return bytes;
    const text = match[0];
    if (match[2] && !isSupportedSgr(match[2])) return bytes;
    tokens.push({ text, kind: match[1] ? "cup" : match[2] ? "sgr" : "cursor" });
    position += text.length;
  }

  let known = false;
  let style = "";
  let changed = false;
  const output: string[] = [FRAME_START];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === RESET) {
      if (known && style && tokens[i + 1]?.kind === "cup") {
        let next = i + 2;
        let repeatedStyle = "";
        while (tokens[next]?.kind === "sgr" && tokens[next]!.text !== RESET) {
          repeatedStyle += tokens[next]!.text;
          next++;
        }
        if (repeatedStyle === style && tokens[next]?.kind === "text") {
          output.push(tokens[i + 1]!.text);
          i = next - 1;
          changed = true;
          continue;
        }
      }
      known = true;
      style = "";
    } else if (token.kind === "sgr") {
      style += token.text;
    }
    output.push(token.text);
  }
  if (!changed) return bytes;
  output.push(FRAME_END);
  return Buffer.from(output.join(""), "utf8");
}

function isSupportedSgr(parameters: string): boolean {
  if (
    /^(?:0|1|2|3|4|5|7|8|9|22|23|24|25|27|28|29|39|49|3[0-7]|4[0-7]|9[0-7]|10[0-7])$/.test(
      parameters,
    )
  )
    return true;
  if (!/^(?:38|48);(?:2;\d+;\d+;\d+|5;\d+)$/.test(parameters)) return false;
  return parameters
    .split(";")
    .slice(2)
    .every((value) => Number(value) <= 255);
}
