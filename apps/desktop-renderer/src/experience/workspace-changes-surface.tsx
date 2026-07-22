import type {
  WorkspaceChangeEntry,
  WorkspaceChangeGroup,
  WorkspaceChangeResourceId,
  WorkspaceChangeStatus,
  WorkspaceChangesView,
  WorkspaceDiffHunk,
} from "@tmux-ide/contracts";
import { For, Match, Show, Switch, createMemo, createUniqueId } from "solid-js";

import { Button } from "../ui-system/index.ts";
import { DomIcon } from "./dom-icon.tsx";

/**
 * Presentational Changes dock body. It renders a grouped changes view
 * (`flattenWorkspaceChangesView`) and an optional read-only structured diff,
 * reporting selection intent through callbacks. All git access lives in the
 * store that satisfies this interface.
 */

export type ChangesSurfaceModel =
  | { readonly kind: "unavailable"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly branch: string | null;
      readonly detached: boolean;
      readonly view: WorkspaceChangesView;
      readonly truncated: boolean;
      readonly totalEntries: number;
    };

export type ChangesDiffModel =
  | { readonly kind: "absent" }
  | { readonly kind: "loading"; readonly relativePath: string }
  | {
      readonly kind: "ready";
      readonly relativePath: string;
      readonly originPath: string | null;
      readonly hunks: readonly WorkspaceDiffHunk[];
      readonly totalHunks: number;
      readonly totalLines: number;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "binary";
      readonly relativePath: string;
      readonly oldBytes: number | null;
      readonly newBytes: number | null;
    }
  | {
      readonly kind: "too-large";
      readonly relativePath: string;
      readonly totalBytes: number;
      readonly limitBytes: number;
    }
  | {
      readonly kind: "unavailable";
      readonly relativePath: string | null;
      readonly reason: string;
      readonly retryable: boolean;
    };

export interface ChangesSurfaceProps {
  readonly model?: ChangesSurfaceModel;
  readonly diff?: ChangesDiffModel;
  readonly onSelectChange?: (id: WorkspaceChangeResourceId) => void;
  readonly onRetry?: () => void;
  readonly onRetryDiff?: () => void;
}

const GROUP_LABEL: Readonly<Record<WorkspaceChangeGroup, string>> = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};

const STATUS_GLYPH: Readonly<Record<WorkspaceChangeStatus, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "type-changed": "T",
  conflicted: "!",
  untracked: "U",
};

function formatBytes(total: number): string {
  if (total < 1_024) return `${total} B`;
  if (total < 1_024 * 1_024) return `${Math.round(total / 1_024)} KB`;
  return `${(total / (1_024 * 1_024)).toFixed(1)} MB`;
}

function moveOptionFocus(event: KeyboardEvent): void {
  const list = event.currentTarget as HTMLElement;
  const options = [...list.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  if (options.length === 0) return;
  if (event.key === "Enter" || event.key === " ") {
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && options.includes(active)) {
      event.preventDefault();
      active.click();
    }
    return;
  }
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const current = Math.max(0, options.indexOf(document.activeElement as HTMLButtonElement));
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? options.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, current - 1)
          : Math.min(options.length - 1, current + 1);
  event.preventDefault();
  options[next]?.focus();
}

function changeSubtitle(entry: WorkspaceChangeEntry): string {
  if (entry.binary) return "binary";
  const additions = entry.additions ?? 0;
  const deletions = entry.deletions ?? 0;
  return `+${additions} −${deletions}`;
}

function DiffPanel(props: { diff: ChangesDiffModel; onRetry?: () => void }) {
  return (
    <section class="workspace-changes__diff" aria-label="Change diff">
      <Switch
        fallback={
          <div class="workspace-changes__diff-empty" role="note">
            <span class="workspace-changes__diff-icon">
              <DomIcon id="changes" usage="rail" />
            </span>
            <p>Select a change to review its diff.</p>
          </div>
        }
      >
        <Match when={props.diff.kind === "loading" && props.diff}>
          {(diff) => (
            <div class="workspace-changes__diff-state" role="status">
              <small>{diff().relativePath}</small>
              <p>Loading diff…</p>
            </div>
          )}
        </Match>
        <Match when={props.diff.kind === "ready" && props.diff}>
          {(diff) => (
            <>
              <header class="workspace-changes__diff-header">
                <div>
                  <Show when={diff().originPath}>
                    <small>{diff().originPath} →</small>
                  </Show>
                  <strong>{diff().relativePath}</strong>
                </div>
                <span class="workspace-changes__diff-meta">
                  {diff().totalHunks} hunks · {diff().totalLines} lines
                </span>
              </header>
              <Show when={diff().truncated}>
                <p class="workspace-changes__notice" role="note">
                  Diff truncated — showing {diff().hunks.length} of {diff().totalHunks} hunks.
                </p>
              </Show>
              <div class="workspace-changes__hunks">
                <For each={diff().hunks}>
                  {(hunk) => (
                    <div class="workspace-changes__hunk">
                      <p class="workspace-changes__hunk-header">{hunk.header}</p>
                      <For each={hunk.lines}>
                        {(line) => (
                          <div class="workspace-changes__line" data-kind={line.kind}>
                            <span class="workspace-changes__gutter" aria-hidden="true">
                              {line.oldLine ?? ""}
                            </span>
                            <span class="workspace-changes__gutter" aria-hidden="true">
                              {line.newLine ?? ""}
                            </span>
                            <span class="workspace-changes__sign" aria-hidden="true">
                              {line.kind === "insert" ? "+" : line.kind === "delete" ? "−" : " "}
                            </span>
                            <code>{line.content === "" ? " " : line.content}</code>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </>
          )}
        </Match>
        <Match when={props.diff.kind === "binary" && props.diff}>
          {(diff) => (
            <div class="workspace-changes__diff-state" data-tone="notice" role="note">
              <small>{diff().relativePath}</small>
              <p>
                Binary file changed
                {diff().oldBytes !== null && diff().newBytes !== null
                  ? ` — ${formatBytes(diff().oldBytes!)} → ${formatBytes(diff().newBytes!)}`
                  : ""}
                . No text diff is shown.
              </p>
            </div>
          )}
        </Match>
        <Match when={props.diff.kind === "too-large" && props.diff}>
          {(diff) => (
            <div class="workspace-changes__diff-state" data-tone="notice" role="note">
              <small>{diff().relativePath}</small>
              <p>
                Change is {formatBytes(diff().totalBytes)}, above the{" "}
                {formatBytes(diff().limitBytes)} diff limit.
              </p>
            </div>
          )}
        </Match>
        <Match when={props.diff.kind === "unavailable" && props.diff}>
          {(diff) => (
            <div class="workspace-changes__diff-state" data-tone="attention" role="status">
              <small>{diff().relativePath ?? "Diff"}</small>
              <p>{diff().reason}</p>
              <Show when={diff().retryable && props.onRetry}>
                <Button size="small" variant="secondary" onClick={() => props.onRetry?.()}>
                  Retry diff
                </Button>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    </section>
  );
}

export function WorkspaceChangesSurface(props: ChangesSurfaceProps) {
  const model = createMemo<ChangesSurfaceModel>(
    () =>
      props.model ?? {
        kind: "unavailable",
        reason: "Changes are not available in this build yet.",
        retryable: false,
      },
  );
  const view = createMemo<WorkspaceChangesView | null>(() => {
    const value = model();
    return value.kind === "ready" ? value.view : null;
  });
  const summary = createMemo(() => view()?.summary ?? null);
  const branchLabel = createMemo(() => {
    const value = model();
    if (value.kind !== "ready") return "";
    if (value.detached) return "Detached HEAD";
    return value.branch ?? "No branch yet";
  });
  const listId = createUniqueId();

  return (
    <div class="workspace-changes" data-state={model().kind}>
      <Switch>
        <Match when={model().kind === "loading"}>
          <div class="workspace-changes__state" role="status">
            <span class="workspace-changes__state-icon">
              <DomIcon id="changes" usage="rail" />
            </span>
            <div>
              <small>Changes</small>
              <h3>Reading the working tree…</h3>
              <p>The change list appears once the daemon returns the git status.</p>
            </div>
          </div>
        </Match>
        <Match when={model().kind === "unavailable" && model()}>
          {(value) => (
            <div class="workspace-changes__state" data-tone="attention" role="status">
              <span class="workspace-changes__state-icon">
                <DomIcon id="changes" usage="rail" />
              </span>
              <div>
                <small>Changes unavailable</small>
                <h3>The change list needs attention</h3>
                <p>{(value() as Extract<ChangesSurfaceModel, { kind: "unavailable" }>).reason}</p>
                <span>No change data is invented while git status is unavailable.</span>
              </div>
              <Show
                when={
                  (value() as Extract<ChangesSurfaceModel, { kind: "unavailable" }>).retryable &&
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
            <div class="workspace-changes__workspace">
              <section
                class="workspace-changes__list-region"
                aria-labelledby={`${listId}-heading`}
              >
                <header>
                  <div>
                    <strong id={`${listId}-heading`}>{branchLabel()}</strong>
                    <span>
                      {summary()?.total ?? 0} changed · +{summary()?.additions ?? 0} −
                      {summary()?.deletions ?? 0}
                    </span>
                  </div>
                  <Show when={(model() as Extract<ChangesSurfaceModel, { kind: "ready" }>).truncated}>
                    <span class="workspace-changes__bounded">Bounded view</span>
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
                    <div class="workspace-changes__empty" role="note">
                      <p>The working tree is clean — no changes to review.</p>
                    </div>
                  }
                >
                  <div
                    class="workspace-changes__list"
                    role="listbox"
                    aria-label="Working tree changes"
                    onKeyDown={moveOptionFocus}
                  >
                    <For each={current().rows}>
                      {(row) => (
                        <Show
                          when={row.kind === "change" && row.entry}
                          fallback={
                            <p class="workspace-changes__group" role="presentation">
                              <span>{GROUP_LABEL[row.group]}</span>
                              <span class="workspace-changes__group-count">{row.count}</span>
                            </p>
                          }
                        >
                          {(entry) => (
                            <button
                              type="button"
                              role="option"
                              class="workspace-changes__row"
                              data-status={entry().status}
                              aria-selected={row.selected}
                              tabIndex={row.selected ? 0 : -1}
                              title={entry().relativePath}
                              onFocus={() => props.onSelectChange?.(entry().id)}
                              onClick={() => props.onSelectChange?.(entry().id)}
                            >
                              <span
                                class="workspace-changes__status"
                                data-status={entry().status}
                                aria-label={entry().status}
                              >
                                {STATUS_GLYPH[entry().status]}
                              </span>
                              <span class="workspace-changes__identity">
                                <strong>{entry().name}</strong>
                                <small>
                                  <Show when={entry().originPath}>
                                    {`${entry().originPath} → `}
                                  </Show>
                                  {entry().relativePath}
                                </small>
                              </span>
                              <span class="workspace-changes__delta">
                                {changeSubtitle(entry())}
                              </span>
                            </button>
                          )}
                        </Show>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
              <DiffPanel diff={props.diff ?? { kind: "absent" }} onRetry={props.onRetryDiff} />
            </div>
          )}
        </Match>
      </Switch>
    </div>
  );
}
