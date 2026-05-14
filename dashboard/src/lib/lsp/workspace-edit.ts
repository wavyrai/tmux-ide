/**
 * Apply an LSP `WorkspaceEdit` to a snapshot of file contents.
 *
 * The dashboard fetches each affected file's on-disk content, then
 * computes the post-edit content here so the rename / code-action
 * preview UI can render a per-file diff before the user confirms.
 * Apply happens by `PUT`-ing the patched content back through
 * `saveFile`.
 *
 * Only `changes` and `documentChanges` of kind `TextDocumentEdit`
 * (the most common shapes returned by typescript-language-server) are
 * supported — `CreateFile` / `RenameFile` / `DeleteFile` resource
 * operations are skipped with a recorded warning so the caller can
 * surface "this rename includes file-system changes that the dashboard
 * can't preview yet". Future work can extend the helper.
 */

import type { LspTextEdit, LspWorkspaceEdit, LspTextDocumentEdit } from "./api";

export interface FileEditPlan {
  /** Workspace-relative path. */
  filePath: string;
  /** Absolute LSP URI as returned by the language server. */
  uri: string;
  edits: LspTextEdit[];
}

export interface AppliedFileEdit extends FileEditPlan {
  /** Source content (as fetched from disk). */
  before: string;
  /** Content after `edits` are applied. */
  after: string;
}

export interface WorkspaceEditPlan {
  files: FileEditPlan[];
  /** Resource ops the dashboard does not yet apply (createFile, etc). */
  warnings: string[];
}

function isTextDocumentEdit(doc: unknown): doc is LspTextDocumentEdit {
  if (!doc || typeof doc !== "object") return false;
  const d = doc as Record<string, unknown>;
  return (
    "textDocument" in d &&
    "edits" in d &&
    typeof (d.textDocument as { uri?: unknown }).uri === "string" &&
    Array.isArray(d.edits)
  );
}

/**
 * Relativize a `file://...` URI to a workspace-relative path under
 * `sessionDir`. Returns `null` when the URI points outside the
 * workspace (e.g., a rename that touches a vendored library).
 */
export function relativizeWorkspaceUri(uri: string, sessionDir: string): string | null {
  let absolute: string;
  try {
    absolute = decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
  const root = sessionDir.replace(/\/$/, "");
  if (absolute === root) return "";
  if (!absolute.startsWith(root + "/")) return null;
  return absolute.slice(root.length + 1);
}

/**
 * Flatten an LSP WorkspaceEdit into a per-file plan. Each entry
 * carries the workspace-relative path + the ordered list of text
 * edits to apply. The caller is responsible for fetching each file's
 * current content and running `applyTextEdits` to compute the
 * preview body.
 */
export function planWorkspaceEdit(edit: LspWorkspaceEdit, sessionDir: string): WorkspaceEditPlan {
  const files: FileEditPlan[] = [];
  const warnings: string[] = [];

  // `documentChanges` is the modern path and always wins when both
  // shapes are present.
  if (edit.documentChanges && edit.documentChanges.length > 0) {
    for (const doc of edit.documentChanges) {
      if (!isTextDocumentEdit(doc)) {
        const kind = (doc as { kind?: unknown })?.kind;
        warnings.push(`Skipped resource op: ${String(kind ?? "unknown")}`);
        continue;
      }
      const rel = relativizeWorkspaceUri(doc.textDocument.uri, sessionDir);
      if (rel === null) {
        warnings.push(`Skipped out-of-workspace URI: ${doc.textDocument.uri}`);
        continue;
      }
      files.push({ filePath: rel, uri: doc.textDocument.uri, edits: doc.edits });
    }
    return { files, warnings };
  }

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const rel = relativizeWorkspaceUri(uri, sessionDir);
      if (rel === null) {
        warnings.push(`Skipped out-of-workspace URI: ${uri}`);
        continue;
      }
      files.push({ filePath: rel, uri, edits });
    }
  }
  return { files, warnings };
}

/**
 * Apply an ordered LSP TextEdit[] to a string. Edits are sorted
 * back-to-front so earlier offsets stay valid as later ones replace
 * text. LSP positions are 0-based on both line and character; text
 * is split on `\n` so a trailing newline is preserved as an empty
 * final segment.
 */
export function applyTextEdits(source: string, edits: LspTextEdit[]): string {
  if (edits.length === 0) return source;
  // Compute character offsets up-front so we don't re-walk the text
  // once per edit. Each entry in lineStarts[i] is the absolute offset
  // of line `i`'s first character.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) lineStarts.push(i + 1);
  }
  const totalLines = lineStarts.length;

  function offsetFor(line: number, character: number): number {
    const safeLine = Math.max(0, Math.min(line, totalLines - 1));
    const base = lineStarts[safeLine] ?? source.length;
    const lineEnd = safeLine + 1 < totalLines ? lineStarts[safeLine + 1]! - 1 : source.length;
    return Math.min(base + character, lineEnd);
  }

  type Resolved = { start: number; end: number; newText: string };
  const resolved: Resolved[] = edits.map((e) => ({
    start: offsetFor(e.range.start.line, e.range.start.character),
    end: offsetFor(e.range.end.line, e.range.end.character),
    newText: e.newText,
  }));
  // Sort by start desc; ties broken by original index for deterministic
  // behaviour when the server returns adjacent edits.
  resolved.sort((a, b) => b.start - a.start);

  let result = source;
  for (const r of resolved) {
    result = result.slice(0, r.start) + r.newText + result.slice(r.end);
  }
  return result;
}
