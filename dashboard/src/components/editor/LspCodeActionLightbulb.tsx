/**
 * Code-action lightbulb — shows a small icon at the cursor's left
 * margin whenever `/lsp/codeActions` returns one or more items for
 * the current selection. Clicking the bulb opens a menu listing
 * actions; selecting one applies the action's `edit` (a multi-file
 * WorkspaceEdit) via the same path as the rename modal.
 *
 * Actions whose only payload is a `command` (no `edit`) are still
 * listed but tagged "command — not yet supported". The dashboard
 * doesn't currently round-trip workspace/executeCommand through the
 * daemon; that's a follow-up slice.
 */

import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import { Effect } from "effect";
import type * as monaco from "monaco-editor";
import { lspCodeActions, type LspCodeAction, type LspWorkspaceEdit } from "@/lib/lsp/api";
import { fetchFilePreview, saveFile } from "@/lib/api";
import { getSessionDir } from "@/lib/lsp/session-dir";
import { applyTextEdits, planWorkspaceEdit } from "@/lib/lsp/workspace-edit";

const ACTION_DEBOUNCE_MS = 250;

export interface LspCodeActionLightbulbProps {
  editor: () => monaco.editor.IStandaloneCodeEditor | null;
  sessionName: string;
  filePath: string;
}

interface BulbState {
  /** Editor-relative px coords for the bulb's anchor. */
  top: number;
  left: number;
  actions: LspCodeAction[];
}

export function LspCodeActionLightbulb(props: LspCodeActionLightbulbProps): JSX.Element {
  const [bulb, setBulb] = createSignal<BulbState | null>(null);
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [applying, setApplying] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;

  function cancel(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function dismiss(): void {
    cancel();
    setBulb(null);
    setMenuOpen(false);
  }

  async function applyAction(action: LspCodeAction): Promise<void> {
    const edit: LspWorkspaceEdit | undefined = action.edit;
    if (!edit) {
      setError("This action only ships a command — not yet supported.");
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const sessionDir = await getSessionDir(props.sessionName);
      if (!sessionDir) {
        setError("Could not resolve session directory.");
        return;
      }
      const plan = planWorkspaceEdit(edit, sessionDir);
      for (const file of plan.files) {
        const fetched = await Effect.runPromise(
          fetchFilePreview(props.sessionName, file.filePath),
        ).catch(() => null);
        if (!fetched?.exists) continue;
        const after = applyTextEdits(fetched.content, file.edits);
        await Effect.runPromise(saveFile(props.sessionName, file.filePath, after));
      }
      dismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  async function fetchActions(
    editor: monaco.editor.IStandaloneCodeEditor,
    selection: monaco.Selection,
  ): Promise<void> {
    const seq = ++requestSeq;
    try {
      const { actions } = await lspCodeActions(props.sessionName, {
        file: props.filePath,
        line: selection.startLineNumber - 1,
        column: selection.startColumn - 1,
        endLine: selection.endLineNumber - 1,
        endColumn: selection.endColumn - 1,
      });
      if (seq !== requestSeq) return;
      if (!actions || actions.length === 0) {
        setBulb(null);
        return;
      }
      // Anchor the bulb to the cursor line's left margin.
      const visible = editor.getScrolledVisiblePosition({
        lineNumber: selection.positionLineNumber,
        column: 1,
      });
      if (!visible) {
        setBulb(null);
        return;
      }
      setBulb({
        top: visible.top,
        left: Math.max(0, visible.left - 18),
        actions,
      });
    } catch {
      if (seq === requestSeq) setBulb(null);
    }
  }

  function schedule(editor: monaco.editor.IStandaloneCodeEditor): void {
    cancel();
    debounceTimer = setTimeout(() => {
      const selection = editor.getSelection();
      if (!selection) {
        setBulb(null);
        return;
      }
      void fetchActions(editor, selection);
    }, ACTION_DEBOUNCE_MS);
  }

  createEffect(() => {
    const editor = props.editor();
    if (!editor) return;
    const disposables: monaco.IDisposable[] = [];
    disposables.push(
      editor.onDidChangeCursorSelection(() => {
        setMenuOpen(false);
        schedule(editor);
      }),
    );
    disposables.push(
      editor.onDidScrollChange(() => {
        // Re-anchor on scroll — the bulb's pixel coords come from
        // `getScrolledVisiblePosition`, so the position becomes stale.
        const selection = editor.getSelection();
        if (!selection || !bulb()) return;
        const visible = editor.getScrolledVisiblePosition({
          lineNumber: selection.positionLineNumber,
          column: 1,
        });
        if (!visible) return;
        setBulb((prev) =>
          prev ? { ...prev, top: visible.top, left: Math.max(0, visible.left - 18) } : prev,
        );
      }),
    );
    disposables.push(editor.onDidChangeModel(() => dismiss()));
    onCleanup(() => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      cancel();
    });
  });

  onCleanup(() => cancel());

  return (
    <Show when={bulb()}>
      {(state) => (
        <>
          <button
            type="button"
            data-testid="lsp-code-action-lightbulb"
            data-action-count={state().actions.length}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            class="absolute z-20 flex h-4 w-4 items-center justify-center rounded-sm bg-[var(--bg-strong)] text-[10px] text-[var(--yellow,#d6a44b)] shadow"
            style={{ left: `${state().left}px`, top: `${state().top}px` }}
            aria-label={`${state().actions.length} code action${state().actions.length === 1 ? "" : "s"} available`}
          >
            ⚡
          </button>
          <Show when={menuOpen()}>
            <div
              data-testid="lsp-code-action-menu"
              class="absolute z-30 flex max-w-[360px] flex-col rounded border border-[var(--border)] bg-[var(--bg-strong)] shadow-lg"
              style={{
                left: `${state().left + 18}px`,
                top: `${state().top + 18}px`,
              }}
            >
              <For each={state().actions}>
                {(action) => (
                  <button
                    type="button"
                    data-testid="lsp-code-action-row"
                    data-action-kind={action.kind ?? ""}
                    disabled={applying() || !!action.disabled}
                    onClick={() => void applyAction(action)}
                    class="flex flex-col items-start px-3 py-1.5 text-left text-[11px] text-[var(--fg)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
                  >
                    <span class="truncate">{action.title}</span>
                    <Show when={action.disabled?.reason}>
                      {(reason) => <span class="text-[10px] text-[var(--dim)]">{reason()}</span>}
                    </Show>
                    <Show when={!action.edit && action.command}>
                      <span class="text-[10px] text-[var(--dim)]">command — not yet supported</span>
                    </Show>
                  </button>
                )}
              </For>
              <Show when={error()}>
                <div class="border-t border-[var(--border-weak)] px-3 py-1 text-[10px] text-[var(--red,#cc6666)]">
                  {error()}
                </div>
              </Show>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}
