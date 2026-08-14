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
  const bare = NAMED_KEY[event.name] ?? (/^f(?:[1-9]|1[0-2])$/iu.test(event.name)
    ? event.name.toUpperCase()
    : null);
  const key = event.ctrl
    ? `C-${bare ?? event.name}`
    : bare;
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
  for (let offset = 0; offset < framed.length; offset += SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS) {
    inputs.push(
      SessionRuntimeTerminalInputSchemaZ.parse({
        kind: "text",
        data: framed.slice(offset, offset + SESSION_RUNTIME_MAX_TERMINAL_INPUT_TEXT_CHARS),
      }),
    );
  }
  return Object.freeze(inputs);
}
