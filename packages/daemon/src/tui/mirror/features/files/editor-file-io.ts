import { constants } from "node:fs";
import { open, realpath, stat, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import {
  MAX_EDITABLE_BYTES,
  isBinary,
  sanitizeForDisplay,
  type ReadOnlyReason,
} from "../../editor-buffer.ts";

export const MAX_PREVIEW_BYTES = 128 * 1024;
export const MAX_EDITOR_LINES = 20_000;
export const MAX_PREVIEW_LINES = 4096;
export interface EditorFileContent {
  readonly path: string;
  readonly text: string;
  readonly reason: ReadOnlyReason;
  readonly truncated: boolean;
  readonly lineCount: number;
  readonly bytesRead: number;
}
/** Bound both native rope text and line metadata before allocating an EditBuffer. */
export function boundEditorText(
  text: string,
  maxLines = MAX_EDITOR_LINES,
): { text: string; lineCount: number; truncated: boolean } {
  let lines = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) !== 10) continue;
    if (lines === maxLines)
      return { text: text.slice(0, index), lineCount: lines, truncated: true };
    lines++;
  }
  return { text, lineCount: lines, truncated: false };
}
export async function readEditorFile(
  path: string,
  signal: AbortSignal,
  io = { open, realpath, stat },
): Promise<EditorFileContent> {
  signal.throwIfAborted();
  const target = await io.realpath(path);
  const before = await io.stat(target);
  if (!before.isFile()) throw new Error("Only regular files can be opened");
  signal.throwIfAborted();
  const handle = await io.open(
    target,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only regular files can be opened");
    signal.throwIfAborted();
    const large = info.size >= MAX_EDITABLE_BYTES;
    // One byte beyond the observed size detects growth without an unbounded read.
    const cap = large ? MAX_PREVIEW_BYTES : Math.min(MAX_EDITABLE_BYTES, info.size + 1);
    const bytes = Buffer.alloc(cap);
    let length = 0;
    while (length < cap) {
      signal.throwIfAborted();
      const result = await handle.read(bytes, length, Math.min(64 * 1024, cap - length), length);
      signal.throwIfAborted();
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const binary = isBinary(bytes.subarray(0, length));
    const truncated = large || length === cap || (binary && length > MAX_PREVIEW_BYTES);
    const view = bytes.subarray(0, truncated ? Math.min(length, MAX_PREVIEW_BYTES) : length);
    const decoded = binary ? sanitizeForDisplay(view) : view.toString("utf8");
    const expanded = Buffer.byteLength(decoded) >= MAX_EDITABLE_BYTES;
    const bounded = boundEditorText(
      expanded ? decoded.slice(0, MAX_PREVIEW_BYTES) : decoded,
      truncated || expanded ? MAX_PREVIEW_LINES : MAX_EDITOR_LINES,
    );
    return {
      path: target,
      text: bounded.text,
      lineCount: bounded.lineCount,
      reason: truncated || expanded || bounded.truncated ? "preview" : binary ? "binary" : null,
      truncated: truncated || expanded || bounded.truncated,
      bytesRead: length,
    };
  } finally {
    await handle.close();
  }
}
/** Exclusive owned temp, same-directory atomic replacement, no stale owner commit. */
export async function saveEditorFile(
  path: string,
  text: string,
  signal: AbortSignal,
  mayCommit: () => boolean,
  io = { open, stat: lstat, rename, unlink },
): Promise<void> {
  signal.throwIfAborted();
  if (!mayCommit()) throw new Error("Save cancelled");
  const info = await io.stat(path);
  if (!info.isFile()) throw new Error("Only regular files can be saved");
  const temporary = join(dirname(path), `.${basename(path)}.tmux-ide-${randomUUID()}.tmp`);
  let owned = false;
  try {
    signal.throwIfAborted();
    const handle = await io.open(temporary, "wx", info.mode & 0o777);
    owned = true;
    try {
      await handle.writeFile(text, { encoding: "utf8", signal });
      await handle.chmod(info.mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal.throwIfAborted();
    if (!mayCommit()) throw new Error("Save cancelled");
    await io.rename(temporary, path);
    owned = false;
  } finally {
    if (owned) await io.unlink(temporary).catch(() => undefined);
  }
}
