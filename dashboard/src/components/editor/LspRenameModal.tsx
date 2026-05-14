/**
 * Rename modal (F2) — driven by the active editor's cursor.
 *
 * Flow:
 *   1. User presses F2 (or Shift+F6, VS Code's other rename key).
 *   2. A modal prompts for the new name, defaulted to the word under
 *      the cursor.
 *   3. On confirm, POST /lsp/rename → receive a `WorkspaceEdit`.
 *   4. For each affected file, fetch on-disk content via the daemon
 *      preview endpoint, run `applyTextEdits` locally, render a
 *      file-by-file diff preview.
 *   5. On `Apply`, `PUT` each post-edit content back through
 *      `saveFile`. The buffer-store's FS-watch picks up the change
 *      and reseeds any open buffers (G17-P6).
 *
 * The modal owns its keybind so the only host-side glue is
 * `<LspRenameModal editor={editor} sessionName=… filePath=… />`.
 */

import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { Effect } from "effect";
import type * as monaco from "monaco-editor";
import { lspRename } from "@/lib/lsp/api";
import { fetchFilePreview, saveFile } from "@/lib/api";
import { getSessionDir } from "@/lib/lsp/session-dir";
import { applyTextEdits, planWorkspaceEdit, type AppliedFileEdit } from "@/lib/lsp/workspace-edit";

export interface LspRenameModalProps {
  editor: () => monaco.editor.IStandaloneCodeEditor | null;
  sessionName: string;
  filePath: string;
}

type Phase = "input" | "loading" | "preview" | "applying" | "error";

interface PreviewState {
  newName: string;
  files: AppliedFileEdit[];
  warnings: string[];
}

export function LspRenameModal(props: LspRenameModalProps): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [phase, setPhase] = createSignal<Phase>("input");
  const [newName, setNewName] = createSignal("");
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<PreviewState | null>(null);
  const [cursor, setCursor] = createSignal<{ line: number; column: number } | null>(null);
  let nameInputRef!: HTMLInputElement;

  function close(): void {
    setOpen(false);
    setPhase("input");
    setPreview(null);
    setErrorMessage(null);
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && open()) {
      event.preventDefault();
      close();
      return;
    }
    if (!open() && (event.key === "F2" || (event.key === "F6" && event.shiftKey))) {
      const editor = props.editor();
      if (!editor) return;
      // Only fire when the editor has focus — F2 also fires inside
      // other text inputs that don't want a rename.
      if (!editor.hasTextFocus()) return;
      const position = editor.getPosition();
      if (!position) return;
      const model = editor.getModel();
      const word = model?.getWordAtPosition(position);
      event.preventDefault();
      setCursor({ line: position.lineNumber - 1, column: position.column - 1 });
      setNewName(word?.word ?? "");
      setOpen(true);
      setPhase("input");
      queueMicrotask(() => {
        nameInputRef?.focus();
        nameInputRef?.select();
      });
    }
  }

  createEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function runRename(): Promise<void> {
    const name = newName().trim();
    const target = cursor();
    if (!name || !target) return;
    setPhase("loading");
    setErrorMessage(null);
    try {
      const { edit } = await lspRename(props.sessionName, {
        file: props.filePath,
        line: target.line,
        column: target.column,
        newName: name,
      });
      if (!edit) {
        setErrorMessage("Rename returned no edits.");
        setPhase("error");
        return;
      }
      const sessionDir = await getSessionDir(props.sessionName);
      if (!sessionDir) {
        setErrorMessage("Could not resolve session directory.");
        setPhase("error");
        return;
      }
      const plan = planWorkspaceEdit(edit, sessionDir);
      const previews: AppliedFileEdit[] = [];
      for (const file of plan.files) {
        const fetched = await Effect.runPromise(
          fetchFilePreview(props.sessionName, file.filePath),
        ).catch(() => null);
        if (!fetched?.exists) continue;
        const after = applyTextEdits(fetched.content, file.edits);
        previews.push({ ...file, before: fetched.content, after });
      }
      setPreview({ newName: name, files: previews, warnings: plan.warnings });
      setPhase("preview");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  async function applyRename(): Promise<void> {
    const data = preview();
    if (!data) return;
    setPhase("applying");
    setErrorMessage(null);
    try {
      for (const file of data.files) {
        await Effect.runPromise(saveFile(props.sessionName, file.filePath, file.after));
      }
      close();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  return (
    <Show when={open()}>
      <Portal>
        <div
          data-testid="v2-rename-modal-backdrop"
          class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            data-testid="v2-rename-modal"
            class="flex max-h-[80vh] w-[720px] max-w-[95vw] flex-col overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl"
          >
            <div class="border-b border-[var(--border)] px-4 py-2 text-[12px] text-[var(--dim)]">
              Rename symbol
            </div>
            <Show when={phase() === "input" || phase() === "loading"}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void runRename();
                }}
                class="flex flex-col gap-2 p-4"
              >
                <input
                  ref={nameInputRef}
                  data-testid="v2-rename-input"
                  type="text"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  disabled={phase() === "loading"}
                  class="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[13px] font-mono text-[var(--fg)] outline-none focus:border-[var(--accent)]"
                />
                <div class="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    class="px-2 py-1 text-[11px] text-[var(--dim)] hover:text-[var(--fg)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    data-testid="v2-rename-preview-btn"
                    disabled={phase() === "loading" || !newName().trim()}
                    class="rounded border border-[var(--accent)] px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    {phase() === "loading" ? "Computing preview…" : "Preview"}
                  </button>
                </div>
              </form>
            </Show>
            <Show when={phase() === "preview"}>
              {(() => {
                const data = preview();
                if (!data) return null;
                return (
                  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <Show when={data.warnings.length > 0}>
                      <ul class="border-b border-[var(--border)] px-4 py-2 text-[11px] text-[var(--yellow,#d6a44b)]">
                        <For each={data.warnings}>{(w) => <li>⚠ {w}</li>}</For>
                      </ul>
                    </Show>
                    <Show
                      when={data.files.length > 0}
                      fallback={
                        <div
                          data-testid="v2-rename-empty"
                          class="flex flex-1 items-center justify-center text-[11px] text-[var(--dim)]"
                        >
                          No files would change.
                        </div>
                      }
                    >
                      <div data-testid="v2-rename-preview" class="min-h-0 flex-1 overflow-y-auto">
                        <For each={data.files}>
                          {(file) => (
                            <div class="border-b border-[var(--border-weak)]">
                              <div class="bg-[var(--surface,var(--bg))] px-4 py-1 text-[11px] font-mono text-[var(--dim)]">
                                {file.filePath}
                              </div>
                              <RenameDiff before={file.before} after={file.after} />
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="flex items-center justify-between border-t border-[var(--border)] px-4 py-2">
                      <span class="text-[11px] text-[var(--dim)]">
                        {data.files.length} file{data.files.length === 1 ? "" : "s"} affected
                      </span>
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={close}
                          class="px-2 py-1 text-[11px] text-[var(--dim)] hover:text-[var(--fg)]"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          data-testid="v2-rename-apply-btn"
                          disabled={data.files.length === 0}
                          onClick={() => void applyRename()}
                          class="rounded border border-[var(--accent)] px-2 py-1 text-[11px] text-[var(--accent)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </Show>
            <Show when={phase() === "applying"}>
              <div class="flex h-24 items-center justify-center text-[11px] text-[var(--dim)]">
                Applying changes…
              </div>
            </Show>
            <Show when={phase() === "error"}>
              <div class="flex flex-col gap-2 p-4 text-[11px]">
                <div class="text-[var(--red,#cc6666)]">{errorMessage() ?? "Rename failed."}</div>
                <div class="flex justify-end">
                  <button
                    type="button"
                    onClick={close}
                    class="rounded border border-[var(--border)] px-2 py-1 text-[var(--fg)]"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

/**
 * Line-level diff renderer — naïve LCS-free pass that walks the two
 * line lists in parallel emitting `-`/`+` rows for any mismatch and
 * `=` rows for unchanged context. Good enough for the rename preview
 * since edits are localised and the file lists are short.
 */
function RenameDiff(props: { before: string; after: string }): JSX.Element {
  const rows = () => diffLines(props.before, props.after);
  return (
    <div class="overflow-x-auto px-4 py-2 font-mono text-[11px] leading-snug">
      <For each={rows()}>
        {(row) => {
          if (row.kind === "removed") {
            return (
              <div data-row="removed" class="whitespace-pre text-[var(--red,#cc6666)]">
                <span aria-hidden="true">- </span>
                {row.text}
              </div>
            );
          }
          if (row.kind === "added") {
            return (
              <div data-row="added" class="whitespace-pre text-[var(--green,#7da97d)]">
                <span aria-hidden="true">+ </span>
                {row.text}
              </div>
            );
          }
          return (
            <div data-row="context" class="whitespace-pre text-[var(--dim)]">
              <span aria-hidden="true"> </span>
              {row.text}
            </div>
          );
        }}
      </For>
    </div>
  );
}

interface DiffRow {
  kind: "added" | "removed" | "context";
  text: string;
}

function diffLines(before: string, after: string): DiffRow[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // Trim long unchanged prefix + suffix runs — the preview shouldn't
  // dump every line of an 8000-line file when only one identifier
  // changed.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA > head && tailB > head && a[tailA] === b[tailB]) {
    tailA--;
    tailB--;
  }
  const CONTEXT = 2;
  const rows: DiffRow[] = [];
  const start = Math.max(0, head - CONTEXT);
  for (let i = start; i < head; i++) {
    rows.push({ kind: "context", text: a[i]! });
  }
  for (let i = head; i <= tailA; i++) {
    rows.push({ kind: "removed", text: a[i]! });
  }
  for (let i = head; i <= tailB; i++) {
    rows.push({ kind: "added", text: b[i]! });
  }
  const endContext = Math.min(a.length - 1, tailA + CONTEXT);
  for (let i = tailA + 1; i <= endContext; i++) {
    rows.push({ kind: "context", text: a[i]! });
  }
  return rows;
}
