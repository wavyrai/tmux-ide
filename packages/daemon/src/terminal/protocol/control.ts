/**
 * Pure parsing for tmux control mode (`tmux -C`).
 *
 * In control mode tmux writes newline-terminated event lines: command replies
 * arrive wrapped in `%begin`/`%end` (or `%error`) blocks, and asynchronous
 * notifications (`%output`, `%layout-change`, `%exit`, …) arrive between
 * blocks. Pane output bytes in `%output` are escaped — every C0 control byte
 * and the backslash itself appear as three-digit octal escapes (`\015`,
 * `\033`, `\134`) — so the decoder here resolves those back to raw BYTES.
 *
 * Everything in this module is pure so the protocol handling can be
 * unit-tested without a live tmux. The client reads tmux's stdout with
 * latin1 encoding (one JS char per byte); `decodeControlBytes` returns a
 * Uint8Array that xterm's `write()` interprets as UTF-8, which keeps
 * multi-byte characters intact end to end.
 */

export type ControlEvent =
  | { kind: "begin"; num: number; flags: number }
  | { kind: "end"; num: number; flags: number }
  | { kind: "error"; num: number; flags: number }
  | { kind: "output"; pane: string; data: Uint8Array }
  /** `%extended-output %N age … : data` — the framing tmux switches to once a
   *  client attaches with pause flags (`attach -f pause-after=N`). `ageMs` is
   *  how long the payload sat in the server's buffer for THIS client —
   *  fall-behind telemetry (m43 flood spike). Clients that never set pause
   *  flags never receive this framing. */
  | { kind: "extended-output"; pane: string; ageMs: number | null; data: Uint8Array }
  | { kind: "exit"; reason: string | null }
  | { kind: "notify"; name: string; rest: string }
  | { kind: "reply-line"; line: string };

/** Decode a latin1 control-mode payload (with \ooo escapes) into raw bytes. */
export function decodeControlBytes(escaped: string): Uint8Array {
  const out = new Uint8Array(escaped.length);
  let n = 0;
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped.charCodeAt(i);
    if (
      ch === 0x5c && // backslash
      i + 3 < escaped.length + 1 &&
      isOctal(escaped.charCodeAt(i + 1)) &&
      isOctal(escaped.charCodeAt(i + 2)) &&
      isOctal(escaped.charCodeAt(i + 3))
    ) {
      out[n++] = parseInt(escaped.slice(i + 1, i + 4), 8) & 0xff;
      i += 3;
    } else {
      out[n++] = ch & 0xff;
    }
  }
  return out.subarray(0, n);
}

function isOctal(code: number | undefined): boolean {
  return code !== undefined && code >= 0x30 && code <= 0x37; // '0'..'7'
}

/**
 * Parse one control-mode line into an event.
 *
 * `insideReply` matters because reply-block bodies are arbitrary command
 * output — a line starting with `%` inside a block is still body text unless
 * it's the block terminator itself.
 */
export function parseControlLine(line: string, insideReply: boolean): ControlEvent {
  if (line.startsWith("%end ") || line.startsWith("%error ")) {
    const isError = line.startsWith("%error ");
    const parts = line.split(" ");
    const num = Number(parts[2] ?? -1);
    const flags = Number(parts[3] ?? -1);
    return { kind: isError ? "error" : "end", num, flags };
  }
  if (insideReply) return { kind: "reply-line", line };

  if (line.startsWith("%begin ")) {
    const parts = line.split(" ");
    return {
      kind: "begin",
      num: Number(parts[2] ?? -1),
      flags: Number(parts[3] ?? -1),
    };
  }
  if (line.startsWith("%output ")) {
    const rest = line.slice("%output ".length);
    const space = rest.indexOf(" ");
    const pane = space === -1 ? rest : rest.slice(0, space);
    const payload = space === -1 ? "" : rest.slice(space + 1);
    return { kind: "output", pane, data: decodeControlBytes(payload) };
  }
  if (line.startsWith("%extended-output ")) {
    // `%extended-output %N age … : data` (tmux 3.7b emits exactly one field —
    // the buffer age in ms — between pane and the ` : ` separator; parse
    // defensively so extra future fields degrade to a null age, never a
    // mis-split payload).
    const rest = line.slice("%extended-output ".length);
    const space = rest.indexOf(" ");
    const pane = space === -1 ? rest : rest.slice(0, space);
    const tail = space === -1 ? "" : rest.slice(space + 1);
    const sep = tail.indexOf(" : ");
    const meta = sep === -1 ? tail : tail.slice(0, sep);
    const payload = sep === -1 ? "" : tail.slice(sep + 3);
    const age = Number(meta.trim().split(/\s+/)[0]);
    return {
      kind: "extended-output",
      pane,
      ageMs: Number.isFinite(age) ? age : null,
      data: decodeControlBytes(payload),
    };
  }
  if (line.startsWith("%exit")) {
    const reason = line.length > "%exit ".length ? line.slice("%exit ".length) : null;
    return { kind: "exit", reason };
  }
  if (line.startsWith("%")) {
    const space = line.indexOf(" ");
    const name = space === -1 ? line.slice(1) : line.slice(1, space);
    return { kind: "notify", name, rest: space === -1 ? "" : line.slice(space + 1) };
  }
  // Shouldn't happen outside a reply block, but never throw on protocol noise.
  return { kind: "reply-line", line };
}

/** Encode text as a `send-keys -H` hex-byte argv tail (UTF-8 bytes). */
export function textToHexKeys(text: string): string[] {
  const bytes = new TextEncoder().encode(text);
  const hex: string[] = [];
  for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
  return hex;
}
