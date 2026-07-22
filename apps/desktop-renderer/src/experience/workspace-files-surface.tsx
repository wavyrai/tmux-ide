import type {
  WorkspaceFileGitStatus,
  WorkspaceFileResourceId,
  WorkspaceFileTreeRow,
  WorkspaceFileTreeView,
} from "@tmux-ide/contracts";
import { For, Match, Show, Switch, createMemo, createUniqueId } from "solid-js";

import { Button } from "../ui-system/index.ts";
import { DomIcon } from "./dom-icon.tsx";

/**
 * Presentational Files dock body. It renders a pre-built explorer tree view
 * (`flattenWorkspaceFileTree`) plus an optional read-only preview, and reports
 * intent through callbacks. It holds no data of its own: expansion, selection,
 * and preview loading are owned by the store that satisfies this interface.
 */

export type FilesSurfaceModel =
  | { readonly kind: "unavailable"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly workspaceName: string;
      readonly view: WorkspaceFileTreeView;
      /** Total entries the workspace holds, when the daemon reports more than one catalog page. */
      readonly totalEntries?: number;
    };

export type FilesPreviewModel =
  | { readonly kind: "absent" }
  | { readonly kind: "loading"; readonly name: string; readonly relativePath: string }
  | {
      readonly kind: "ready";
      readonly name: string;
      readonly relativePath: string;
      readonly content: string;
      readonly languageHint: string | null;
      readonly totalLines: number;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "binary";
      readonly name: string;
      readonly relativePath: string;
      readonly totalBytes: number;
      readonly mediaType: string | null;
    }
  | {
      readonly kind: "too-large";
      readonly name: string;
      readonly relativePath: string;
      readonly totalBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "unavailable";
      readonly name: string | null;
      readonly relativePath: string | null;
      readonly reason: string;
      readonly retryable: boolean;
    };

export interface FilesSurfaceProps {
  readonly model?: FilesSurfaceModel;
  readonly preview?: FilesPreviewModel;
  readonly onSelectFile?: (id: WorkspaceFileResourceId) => void;
  readonly onToggleDirectory?: (id: WorkspaceFileResourceId, next: boolean) => void;
  readonly onRetry?: () => void;
  readonly onRetryPreview?: () => void;
}

const GIT_STATUS_GLYPH: Readonly<Record<WorkspaceFileGitStatus, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

function formatBytes(total: number): string {
  if (total < 1_024) return `${total} B`;
  if (total < 1_024 * 1_024) return `${Math.round(total / 1_024)} KB`;
  return `${(total / (1_024 * 1_024)).toFixed(1)} MB`;
}

function treeItems(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
}

function PreviewPanel(props: {
  preview: FilesPreviewModel;
  onRetry?: () => void;
}) {
  const lines = createMemo(() => {
    const preview = props.preview;
    return preview.kind === "ready" ? preview.content.split("\n") : [];
  });
  return (
    <section class="workspace-files__preview" aria-label="File preview">
      <Switch
        fallback={
          <div class="workspace-files__preview-empty" role="note">
            <span class="workspace-files__preview-icon">
              <DomIcon id="preview" usage="rail" />
            </span>
            <p>Select a file to preview its contents.</p>
          </div>
        }
      >
        <Match when={props.preview.kind === "loading" && props.preview}>
          {(preview) => (
            <div class="workspace-files__preview-state" role="status">
              <small>{preview().relativePath}</small>
              <p>Loading preview…</p>
            </div>
          )}
        </Match>
        <Match when={props.preview.kind === "ready" && props.preview}>
          {(preview) => (
            <>
              <header class="workspace-files__preview-header">
                <div>
                  <strong>{preview().name}</strong>
                  <small>{preview().relativePath}</small>
                </div>
                <span class="workspace-files__preview-meta">
                  {preview().languageHint ?? "text"} · {preview().totalLines} lines
                </span>
              </header>
              <Show when={preview().truncated}>
                <p class="workspace-files__notice" role="note">
                  Preview truncated to the first {lines().length} rendered lines of{" "}
                  {preview().totalLines}.
                </p>
              </Show>
              <ol class="workspace-files__code" aria-label={`Contents of ${preview().relativePath}`}>
                <For each={lines()}>{(line) => <li>{line === "" ? " " : line}</li>}</For>
              </ol>
            </>
          )}
        </Match>
        <Match when={props.preview.kind === "binary" && props.preview}>
          {(preview) => (
            <div class="workspace-files__preview-state" data-tone="notice" role="note">
              <small>{preview().relativePath}</small>
              <p>
                Binary file — {formatBytes(preview().totalBytes)}
                {preview().mediaType ? ` · ${preview().mediaType}` : ""}. No text preview is shown.
              </p>
            </div>
          )}
        </Match>
        <Match when={props.preview.kind === "too-large" && props.preview}>
          {(preview) => (
            <div class="workspace-files__preview-state" data-tone="notice" role="note">
              <small>{preview().relativePath}</small>
              <p>
                File is {formatBytes(preview().totalBytes)}, above the{" "}
                {formatBytes(preview().limitBytes)} preview limit.
              </p>
            </div>
          )}
        </Match>
        <Match when={props.preview.kind === "unavailable" && props.preview}>
          {(preview) => (
            <div class="workspace-files__preview-state" data-tone="attention" role="status">
              <small>{preview().relativePath ?? "Preview"}</small>
              <p>{preview().reason}</p>
              <Show when={preview().retryable && props.onRetry}>
                <Button size="small" variant="secondary" onClick={() => props.onRetry?.()}>
                  Retry preview
                </Button>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    </section>
  );
}

function TreeRow(props: {
  row: WorkspaceFileTreeRow;
  focusableId: WorkspaceFileResourceId | null;
  onSelectFile?: (id: WorkspaceFileResourceId) => void;
  onToggleDirectory?: (id: WorkspaceFileResourceId, next: boolean) => void;
}) {
  const row = () => props.row;
  const status = () => row().gitStatus;
  return (
    <>
      <button
        type="button"
        role="treeitem"
        class="workspace-files__row"
        data-id={row().id}
        data-parent={row().parentId}
        data-kind={row().kind}
        data-expandable={row().expandable}
        data-expanded={row().expanded}
        data-hidden={row().hidden}
        data-ignored={row().ignored}
        aria-level={row().depth + 1}
        aria-selected={row().selected}
        aria-expanded={row().expandable ? row().expanded : undefined}
        tabIndex={row().id === props.focusableId ? 0 : -1}
        title={row().relativePath}
        onFocus={() => props.onSelectFile?.(row().id)}
        onClick={() => {
          if (row().expandable) props.onToggleDirectory?.(row().id, !row().expanded);
          props.onSelectFile?.(row().id);
        }}
      >
        <For each={Array.from({ length: row().depth })}>
          {() => <span class="workspace-files__indent" aria-hidden="true" />}
        </For>
        <span
          class="workspace-files__twist"
          data-visible={row().expandable}
          aria-hidden="true"
          onClick={(event) => {
            if (!row().expandable) return;
            event.stopPropagation();
            props.onToggleDirectory?.(row().id, !row().expanded);
          }}
        >
          <Show when={row().expandable}>
            <DomIcon id={row().expanded ? "split-down" : "split-right"} usage="action" />
          </Show>
        </span>
        <span class="workspace-files__glyph" aria-hidden="true">
          <DomIcon id={row().kind === "directory" ? "files" : "preview"} usage="action" />
        </span>
        <span class="workspace-files__name">{row().name}</span>
        <Show when={status()}>
          {(value) => (
            <span class="workspace-files__git" data-status={value()} aria-label={value()}>
              {GIT_STATUS_GLYPH[value()]}
            </span>
          )}
        </Show>
      </button>
      <Show when={row().expandable && row().expanded && !row().childrenLoaded}>
        <p
          class="workspace-files__row-loading"
          data-level={row().depth + 1}
          role="status"
          aria-label={`Loading ${row().name}`}
        >
          <For each={Array.from({ length: row().depth + 1 })}>
            {() => <span class="workspace-files__indent" aria-hidden="true" />}
          </For>
          <span>Loading…</span>
        </p>
      </Show>
    </>
  );
}

function moveTreeFocus(
  event: KeyboardEvent,
  onToggleDirectory?: (id: WorkspaceFileResourceId, next: boolean) => void,
): void {
  const list = event.currentTarget as HTMLElement;
  const items = treeItems(list);
  if (items.length === 0) return;
  const active = document.activeElement;
  const current = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
  const focused = current === -1 ? null : items[current]!;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next =
      current === -1
        ? 0
        : Math.min(items.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
    items[next]?.focus();
    return;
  }
  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    return;
  }
  if (!focused) return;
  const id = focused.dataset.id as WorkspaceFileResourceId | undefined;
  const expandable = focused.dataset.expandable === "true";
  const expanded = focused.dataset.expanded === "true";
  if (event.key === "ArrowRight") {
    if (!expandable || !id) return;
    event.preventDefault();
    if (!expanded) onToggleDirectory?.(id, true);
    else items[current + 1]?.focus();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    if (expandable && expanded && id) {
      onToggleDirectory?.(id, false);
      return;
    }
    const parent = focused.dataset.parent;
    const parentItem = items.find((item) => item.dataset.id === parent);
    parentItem?.focus();
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    if (!expandable || !id) return;
    event.preventDefault();
    onToggleDirectory?.(id, !expanded);
  }
}

export function WorkspaceFilesSurface(props: FilesSurfaceProps) {
  const model = createMemo<FilesSurfaceModel>(
    () =>
      props.model ?? {
        kind: "unavailable",
        reason: "Files are not available in this build yet.",
        retryable: false,
      },
  );
  const view = createMemo<WorkspaceFileTreeView | null>(() => {
    const value = model();
    return value.kind === "ready" ? value.view : null;
  });
  const focusableId = createMemo<WorkspaceFileResourceId | null>(() => {
    const current = view();
    if (!current) return null;
    return current.selectedId ?? current.rows[0]?.id ?? null;
  });
  const listId = createUniqueId();

  return (
    <div class="workspace-files" data-state={model().kind}>
      <Switch>
        <Match when={model().kind === "loading"}>
          <div class="workspace-files__state" role="status">
            <span class="workspace-files__state-icon">
              <DomIcon id="files" usage="rail" />
            </span>
            <div>
              <small>Files</small>
              <h3>Indexing workspace files…</h3>
              <p>The explorer appears once the daemon returns the first catalog.</p>
            </div>
          </div>
        </Match>
        <Match when={model().kind === "unavailable" && model()}>
          {(value) => (
            <div class="workspace-files__state" data-tone="attention" role="status">
              <span class="workspace-files__state-icon">
                <DomIcon id="files" usage="rail" />
              </span>
              <div>
                <small>Files unavailable</small>
                <h3>The file explorer needs attention</h3>
                <p>{(value() as Extract<FilesSurfaceModel, { kind: "unavailable" }>).reason}</p>
                <span>No file data is invented while the workspace is unavailable.</span>
              </div>
              <Show
                when={
                  (value() as Extract<FilesSurfaceModel, { kind: "unavailable" }>).retryable &&
                  props.onRetry
                }
              >
                <Button size="small" variant="primary" onClick={() => props.onRetry?.()}>
                  Retry
                </Button>
              </Show>
            </div>
          )}
        </Match>
        <Match when={model().kind === "ready" && view()}>
          {(current) => (
            <div class="workspace-files__workspace">
              <section class="workspace-files__tree-region" aria-labelledby={`${listId}-heading`}>
                <header>
                  <div>
                    <strong id={`${listId}-heading`}>Explorer</strong>
                    <span>
                      {(model() as Extract<FilesSurfaceModel, { kind: "ready" }>).workspaceName}
                    </span>
                  </div>
                  <Show when={current().truncated}>
                    <span class="workspace-files__bounded">Bounded view</span>
                  </Show>
                  <Show when={props.onRetry}>
                    <Button size="small" variant="ghost" onClick={() => props.onRetry?.()}>
                      <DomIcon id="refresh" usage="action" />
                      Refresh
                    </Button>
                  </Show>
                </header>
                <Show
                  when={current().rows.length > 0}
                  fallback={
                    <div class="workspace-files__empty" role="note">
                      <p>This workspace directory is empty.</p>
                    </div>
                  }
                >
                  <div
                    class="workspace-files__tree"
                    role="tree"
                    aria-label="Workspace files"
                    onKeyDown={(event) => moveTreeFocus(event, props.onToggleDirectory)}
                  >
                    <For each={current().rows}>
                      {(row) => (
                        <TreeRow
                          row={row}
                          focusableId={focusableId()}
                          onSelectFile={props.onSelectFile}
                          onToggleDirectory={props.onToggleDirectory}
                        />
                      )}
                    </For>
                  </div>
                </Show>
                <Show when={current().truncated}>
                  <p class="workspace-files__notice" role="note">
                    Some entries are hidden — the workspace exceeds the bounded explorer view.
                  </p>
                </Show>
              </section>
              <PreviewPanel preview={props.preview ?? { kind: "absent" }} onRetry={props.onRetryPreview} />
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}
