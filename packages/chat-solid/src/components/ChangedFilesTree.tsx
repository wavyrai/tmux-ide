import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { ChangedFile } from "../lib/changedFiles";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";

interface DirectoryGroup {
  dir: string;
  files: ChangedFile[];
}

export interface ChangedFilesTreeProps {
  files: Accessor<ChangedFile[]>;
  /**
   * Optional turn id (`turnId`) the host can attach so a downstream
   * "open in diff viewer" callback knows which turn produced the
   * change. The widget passes it back through `onOpenDiff` verbatim.
   */
  turnId?: Accessor<string | null>;
  /**
   * When set, file rows become diff-viewer entry points: clicking a
   * file fires `onOpenDiff(turnId, path)` so the host can hand off to
   * its diff surface. The inline expand-to-pre fallback stays
   * available via the row's chevron, so power-users who only want a
   * quick peek don't have to round-trip through the viewer.
   *
   * Omit to keep the legacy inline-expand behavior on row click
   * (back-compat with the original card UX).
   */
  onOpenDiff?: (turnId: string | null, path: string) => void;
}

export function ChangedFilesTree(props: ChangedFilesTreeProps) {
  const [open, setOpen] = createSignal(true);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const groups = createMemo(() => groupFiles(props.files()));
  const writeCount = createMemo(() => props.files().filter((file) => file.kind === "write").length);
  const readCount = createMemo(() => props.files().filter((file) => file.kind === "read").length);

  function togglePath(path: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <Show when={props.files().length > 0}>
      <section class="sticky top-0 z-10 rounded-md border border-border-weak bg-bg/95 p-2 shadow-sm backdrop-blur">
        <button
          type="button"
          class="flex w-full items-center justify-between border-0 bg-transparent p-0 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <span class="text-[12px] font-medium text-fg">Changed files</span>
          <span class="text-[11px] text-dim">
            {writeCount()} written
            <Show when={readCount() > 0}> - {readCount()} read</Show> {open() ? "v" : ">"}
          </span>
        </button>

        <Show when={open()}>
          <div class="mt-2 max-h-72 overflow-auto">
            <For each={groups()}>
              {(group) => (
                <div class="mb-1 last:mb-0">
                  <Show when={group.dir}>
                    <div class="px-1 py-0.5 text-[11px] text-dim">{group.dir}/</div>
                  </Show>
                  <For each={group.files}>
                    {(file) => (
                      <div data-testid="changed-files-tree-file" data-path={file.path}>
                        <div class="group/file flex w-full items-stretch">
                          <button
                            type="button"
                            data-testid="changed-files-tree-row"
                            class={`flex min-w-0 flex-1 items-center justify-between rounded border-0 bg-transparent px-2 py-1 text-left text-[12px] hover:bg-surface-hover ${
                              file.kind === "read" ? "text-dim" : "text-fg-secondary"
                            }`}
                            onClick={() => {
                              if (props.onOpenDiff && file.kind === "write") {
                                props.onOpenDiff(props.turnId?.() ?? null, file.path);
                                return;
                              }
                              togglePath(file.path);
                            }}
                          >
                            <span class="min-w-0 truncate">{basename(file.path)}</span>
                            <span class="ml-2 flex-shrink-0 text-[11px]">
                              <Show
                                when={file.kind === "write"}
                                fallback={<span class="text-dim">read</span>}
                              >
                                <Show
                                  when={hasNonZeroStat({
                                    additions: file.totalAdditions,
                                    deletions: file.totalDeletions,
                                  })}
                                  fallback={<span class="text-dim">changed</span>}
                                >
                                  <DiffStatLabel
                                    additions={file.totalAdditions}
                                    deletions={file.totalDeletions}
                                  />
                                </Show>
                              </Show>
                            </span>
                          </button>
                          <Show when={props.onOpenDiff && file.kind === "write"}>
                            <button
                              type="button"
                              data-testid="changed-files-tree-expand"
                              aria-label={`Toggle inline diff for ${basename(file.path)}`}
                              class="flex shrink-0 items-center justify-center px-1.5 text-[10px] text-dim opacity-0 transition-opacity hover:text-accent group-hover/file:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                togglePath(file.path);
                              }}
                            >
                              {expanded().has(file.path) ? "▾" : "▸"}
                            </button>
                          </Show>
                        </div>
                        <Show when={expanded().has(file.path)}>
                          <div class="mb-2 rounded-md border border-border-weak bg-surface">
                            <Show
                              when={file.edits.length > 0}
                              fallback={
                                <div class="p-2 text-[12px] text-dim">
                                  No diff content captured.
                                </div>
                              }
                            >
                              <For each={file.edits}>
                                {(edit, index) => (
                                  <div class="border-b border-border-weak last:border-b-0">
                                    <div class="px-2 py-1 text-[11px] text-dim">
                                      {edit.toolCallId} - {edit.createdAt}
                                    </div>
                                    <pre class="m-0 overflow-auto whitespace-pre-wrap px-2 pb-2 text-[11px] leading-relaxed text-fg-secondary">
                                      {formatDiff(edit.oldText, edit.newText)}
                                    </pre>
                                    <Show when={index() < file.edits.length - 1}>
                                      <div class="mx-2 border-t border-border-weak" />
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

function groupFiles(files: ChangedFile[]): DirectoryGroup[] {
  const groups = new Map<string, ChangedFile[]>();
  for (const file of files) {
    const dir = dirname(file.path);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return [...groups.entries()].map(([dir, groupFiles]) => ({ dir, files: groupFiles }));
}

function dirname(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function formatDiff(oldText: string, newText: string): string {
  if (!oldText) return prefixLines(newText, "+");
  if (!newText) return prefixLines(oldText, "-");
  return [`--- before`, prefixLines(oldText, "-"), `+++ after`, prefixLines(newText, "+")].join(
    "\n",
  );
}

function prefixLines(text: string, prefix: string): string {
  if (!text) return `${prefix}`;
  return text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
