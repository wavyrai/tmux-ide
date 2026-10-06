import {
  SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS,
  SessionRuntimeTerminalInputSchemaZ,
  type SessionRuntimeTerminalInput,
} from "@tmux-ide/contracts";

export interface OpenTuiKeyEvent {
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

const NAMED_KEY: Readonly<Record<string, string>> = Object.freeze({
  return: "Enter",
  enter: "Enter",
  backspace: "BSpace",
  tab: "Tab",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  delete: "DC",
  insert: "IC",
  space: "Space",
});

export function terminalInputForOpenTuiKey(
  event: OpenTuiKeyEvent,
): SessionRuntimeTerminalInput | null {
  if (event.meta) return null;
  const bare =
    NAMED_KEY[event.name] ??
    (/^f(?:[1-9]|1[0-2])$/iu.test(event.name) ? event.name.toUpperCase() : null);
  const key = event.ctrl ? `C-${bare ?? event.name}` : bare;
  if (key !== null) {
    const parsed = SessionRuntimeTerminalInputSchemaZ.safeParse({ kind: "key", data: key });
    return parsed.success ? parsed.data : null;
  }
  if (event.name.length !== 1) return null;
  const data = event.shift ? event.name.toUpperCase() : event.name;
  return SessionRuntimeTerminalInputSchemaZ.parse({ kind: "text", data });
}

/** Preserve paste ordering and bracketed-paste semantics without an unbounded frame. */
export function terminalInputsForPaste(text: string): readonly SessionRuntimeTerminalInput[] {
  if (text.length === 0) return [];
  if (text.includes("\0")) throw new TypeError("terminal paste must not contain NUL");
  const framed = `\u001b[200~${text}\u001b[201~`;
  const inputs: SessionRuntimeTerminalInput[] = [];
  for (let offset = 0; offset < framed.length; ) {
    let end = Math.min(offset + SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS, framed.length);
    // Messages can be encoded independently. Keep a supplementary code point
    // intact instead of relying on the receiver to rejoin its UTF-16 halves.
    const last = framed.charCodeAt(end - 1);
    const next = framed.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    inputs.push(
      SessionRuntimeTerminalInputSchemaZ.parse({
        kind: "text",
        data: framed.slice(offset, end),
      }),
    );
    offset = end;
  }
  return Object.freeze(inputs);
}
