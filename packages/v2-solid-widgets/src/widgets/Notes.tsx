/**
 * Notes — per-project markdown scratchpad. Prop-driven Solid widget;
 * the host (NotesBridge in dashboard) supplies content + updatedAt
 * from the daemon and consumes edits via `onSave`. The widget owns
 * the draft buffer + dirty flag.
 *
 * Save flow:
 *   - Cmd/Ctrl+S inside the textarea or click Save → onSave(draft)
 *   - host PUTs /api/project/:name/notes and pushes the fresh
 *     content + updatedAt back via setOptions
 *   - widget compares incoming content to its draft; if equal (or
 *     the local copy was clean) it adopts the new content, else it
 *     keeps the user's draft and surfaces an "external change" badge.
 *
 * Semantic data-* hooks for tests + CSS overrides:
 *   - data-testid="notes-view"
 *   - data-testid="notes-textarea"
 *   - data-testid="notes-save"
 *   - data-testid="notes-status"
 */

import { createEffect, createSignal, Show } from "solid-js";
import type { NotesMountOptions } from "../types";

interface NotesViewProps {
  options: () => NotesMountOptions;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never saved";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "saved";
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function NotesView(props: NotesViewProps) {
  const [draft, setDraft] = createSignal(props.options().content);
  const [dirty, setDirty] = createSignal(false);
  const [externalChanged, setExternalChanged] = createSignal(false);

  // Reconcile incoming server content with the user's draft. If the
  // user has unsaved edits and the server content diverges, keep the
  // draft and flag the divergence; otherwise adopt the new content.
  createEffect(() => {
    const incoming = props.options().content;
    if (!dirty()) {
      setDraft(incoming);
      setExternalChanged(false);
    } else if (incoming !== draft()) {
      setExternalChanged(true);
    }
  });

  function save(): void {
    const cb = props.options().onSave;
    if (!cb) return;
    cb(draft());
    setDirty(false);
    setExternalChanged(false);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      save();
    }
  }

  return (
    <div
      data-testid="notes-view"
      class="flex h-full min-h-0 w-full flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <div class="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <div class="flex items-center gap-3">
          <span class="text-[12px] font-medium">Notes</span>
          <span
            data-testid="notes-status"
            class="text-[11px] text-[var(--dim)]"
          >
            <Show
              when={dirty()}
              fallback={<>Last saved {formatRelative(props.options().updatedAt)}</>}
            >
              Unsaved changes
            </Show>
          </span>
          <Show when={externalChanged()}>
            <span class="rounded bg-[var(--yellow,#d4a017)]/15 px-2 py-0.5 text-[10px] text-[var(--yellow,#d4a017)]">
              External change pending
            </span>
          </Show>
          <Show when={props.options().error}>
            <span class="text-[11px] text-[var(--red,#cc6666)]" role="alert">
              {props.options().error}
            </span>
          </Show>
        </div>
        <button
          type="button"
          data-testid="notes-save"
          onClick={() => save()}
          disabled={props.options().saving || !dirty()}
          class="rounded bg-[var(--accent)] px-3 py-1 text-[11px] font-medium text-[var(--accent-fg,var(--bg))] disabled:opacity-40"
        >
          {props.options().saving ? "Saving…" : "Save"}
        </button>
      </div>
      <textarea
        data-testid="notes-textarea"
        spellcheck={false}
        class="min-h-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[1.5] text-[var(--fg)] outline-none"
        placeholder="# Project notes&#10;&#10;Jot anything down. Stored as .tmux-ide/notes.md in the project directory."
        value={draft()}
        onInput={(e) => {
          setDraft(e.currentTarget.value);
          setDirty(true);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
