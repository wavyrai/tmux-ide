import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type { Cell } from "../selection.ts";
import { retainedTerminalCell } from "../terminal-retained-row.ts";

const MAX_LINK_LINE = 8192;

/** Deliberate activation only; ordinary selection and application mouse input keep ownership. */
export function isTerminalLinkClick(event: {
  readonly type: string;
  readonly button?: number;
  readonly modifiers?: {
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
  };
}): boolean {
  return (
    event.type === "down" &&
    event.button === 0 &&
    Boolean(event.modifiers?.ctrl || event.modifiers?.meta) &&
    !event.modifiers?.shift &&
    !event.modifiers?.alt
  );
}

export function safeTerminalLink(value: string): string | null {
  if (
    value.length > MAX_LINK_LINE ||
    Array.from(value).some((char) => char.codePointAt(0)! <= 32 || char === "\x7f")
  )
    return null;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Resolve visible text at an absolute retained cell; never interprets escape sequences or OSC metadata. */
export function terminalLinkAt(snapshot: TerminalReplicaSnapshot, cell: Cell): string | null {
  const rowAt = (index: number) =>
    index < snapshot.history.length
      ? snapshot.history[index]
      : snapshot.grid[index - snapshot.history.length];
  if (
    !Number.isSafeInteger(cell.row) ||
    !Number.isSafeInteger(cell.col) ||
    cell.row < 0 ||
    cell.col < 0 ||
    cell.col >= snapshot.cols ||
    !rowAt(cell.row)
  )
    return null;
  let first = cell.row;
  let last = cell.row;
  // wrapped marks continuation of the preceding row, including the history/live boundary.
  while (first > 0 && rowAt(first)?.wrapped) {
    if ((cell.row - first + 1) * snapshot.cols > MAX_LINK_LINE) return null;
    first--;
  }
  while (rowAt(last + 1)?.wrapped) {
    if ((last - first + 2) * snapshot.cols > MAX_LINK_LINE) return null;
    last++;
  }
  let text = "";
  let target = -1;
  for (let row = first; row <= last; row++) {
    for (let column = 0; column < snapshot.cols; column++) {
      const source = retainedTerminalCell(rowAt(row)!, column);
      if (row === cell.row && column === cell.col) target = text.length;
      if (source?.width === 0) {
        if (row === cell.row && column === cell.col) return null;
        continue;
      }
      text += source?.grapheme || " ";
      if (text.length > MAX_LINK_LINE) return null;
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
    let value = match[0].replace(/[.,;:!?]+$/u, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]) {
      while (value.endsWith(close!) && value.split(close!).length > value.split(open!).length)
        value = value.slice(0, -1);
    }
    if (target >= match.index && target < match.index + value.length)
      return safeTerminalLink(value);
  }
  return null;
}
