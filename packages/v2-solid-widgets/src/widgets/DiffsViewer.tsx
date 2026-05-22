/**
 * DiffsViewer — Solid port of the dashboard's git-diff panel
 * (dashboard/components/diffs/DiffPanel.tsx).
 *
 * Production replacement for DiffPanel. Fetches the project-wide diff
 * summary from /api/project/:name/diff and per-file patches from
 * /api/project/:name/diff/:file on demand. Renders a file rail (with
 * +adds / -dels per file and an "All files" entry) on the left and a
 * unified-diff body on the right with t3-style semantic data-* hooks
 * (`data-diffs-header`, `data-diff-file`, `data-diff-line-kind`) so
 * themers can target the rail without touching widget internals.
 *
 * Visual language is aligned with context/t3code/apps/web/src/components/
 * DiffPanel.tsx — same color-mix() palette for context / addition /
 * deletion / hunk lines, same "stacked vs split" naming for the view
 * toggle (split is reserved for follow-up; today it falls back to
 * unified rendering until the @pierre/diffs Solid wrapper lands).
 *
 * Mirrors PlansRail's contract: callbacks travel through options;
 * setOptions on the mount handle pushes selection/style updates from
 * the React host into the live Solid signal without remount.
 */
import { createEffect, createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { fetchProjectDiff, fetchProjectFileDiff, type DiffData, type DiffFileEntry } from "../api";
import type { DiffsViewerMountOptions } from "../types";

interface DiffsViewerViewProps {
  options: () => DiffsViewerMountOptions;
}

type DiffStyle = "unified" | "split";

type DiffLineKind = "context" | "add" | "del" | "hunk" | "meta";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const MAX_DIFF_LINES = 2000;
const POLL_INTERVAL_MS = 5000;

const LINE_COLOR: Record<DiffLineKind, { fg: string; bg: string }> = {
  // t3 DiffPanel.tsx UNSAFE_CSS uses color-mix on `--background` + a role
  // color. We do the same so the rail picks up theme switches without
  // bespoke palette files.
  add: {
    fg: "var(--diff-add-text, color-mix(in srgb, var(--green) 80%, var(--fg)))",
    bg: "color-mix(in srgb, var(--bg) 92%, var(--green))",
  },
  del: {
    fg: "var(--diff-del-text, color-mix(in srgb, var(--red) 80%, var(--fg)))",
    bg: "color-mix(in srgb, var(--bg) 92%, var(--red))",
  },
  hunk: {
    fg: "var(--cyan, var(--accent))",
    bg: "color-mix(in srgb, var(--bg) 95%, var(--accent))",
  },
  meta: {
    fg: "var(--dim)",
    bg: "transparent",
  },
  context: {
    fg: "var(--fg)",
    bg: "transparent",
  },
};

function classifyLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function parseDiff(patch: string): DiffLine[] {
  if (!patch) return [];
  return patch.split("\n").map((text) => ({ kind: classifyLine(text), text }));
}

function fileBasename(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? file : file.slice(idx + 1);
}

function fileDirname(file: string): string {
  const idx = file.lastIndexOf("/");
  return idx === -1 ? "" : file.slice(0, idx + 1);
}

export function DiffsViewerView(props: DiffsViewerViewProps) {
  const [data, setData] = createSignal<DiffData | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loadingSummary, setLoadingSummary] = createSignal(true);
  const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
  const [filePatch, setFilePatch] = createSignal<string>("");
  const [loadingFile, setLoadingFile] = createSignal(false);
  const [diffStyle, setDiffStyle] = createSignal<DiffStyle>("unified");
  const [showFull, setShowFull] = createSignal(false);

  async function refreshSummary() {
    try {
      const d = await fetchProjectDiff(props.options());
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSummary(false);
    }
  }

  onMount(() => {
    void refreshSummary();
    const interval = setInterval(() => void refreshSummary(), POLL_INTERVAL_MS);
    onCleanup(() => clearInterval(interval));
  });

  // When sessionName changes the host re-targets; reload from scratch.
  createEffect(() => {
    void props.options().sessionName;
    void refreshSummary();
  });

  // Fetch per-file patch when the rail selection changes. `selectedFile`
  // === null means "All files" (the project-wide patch from /diff).
  createEffect(() => {
    const file = selectedFile();
    if (!file) {
      setFilePatch(data()?.diff ?? "");
      return;
    }
    setLoadingFile(true);
    void fetchProjectFileDiff(props.options(), file)
      .then(setFilePatch)
      .catch(() => setFilePatch(""))
      .finally(() => setLoadingFile(false));
  });

  // Reset the truncation cutoff each time the visible patch changes so a
  // long file followed by a short one doesn't keep the "showing first N"
  // banner around incorrectly.
  createEffect(() => {
    void filePatch();
    setShowFull(false);
  });

  const files = createMemo<DiffFileEntry[]>(() => data()?.files ?? []);
  const totalAdditions = createMemo(() => files().reduce((s, f) => s + f.additions, 0));
  const totalDeletions = createMemo(() => files().reduce((s, f) => s + f.deletions, 0));
  const allLines = createMemo<DiffLine[]>(() => parseDiff(filePatch()));
  const truncated = createMemo(() => allLines().length > MAX_DIFF_LINES && !showFull());
  const lines = createMemo<DiffLine[]>(() =>
    truncated() ? allLines().slice(0, MAX_DIFF_LINES) : allLines(),
  );

  // Virtualized diff line list: every line previously rendered a div
  // with inline-styled background-color, so a 5k-line refactor diff
  // produced 5k DOM nodes. Fixed-height rows (`line-height: 1.5` on a
  // 12px monospace font ≈ 18px) make a flat fixed-estimate virtualizer
  // a clean fit.
  const [diffScrollEl, setDiffScrollEl] = createSignal<HTMLDivElement | null>(null);
  const diffVirtualizer = createVirtualizer({
    get count() {
      return lines().length;
    },
    getScrollElement: () => diffScrollEl(),
    estimateSize: () => 18,
    overscan: 12,
  });

  return (
    <div
      data-testid="diffs-viewer-solid"
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        width: "100%",
        "min-width": "0",
        "background-color": "var(--bg)",
        color: "var(--fg)",
        "font-family": "var(--font-mono)",
        "font-size": "var(--text-base)",
      }}
    >
      <Show
        when={!loadingSummary() || data()}
        fallback={
          <div
            style={{
              flex: "1",
              display: "flex",
              "align-items": "center",
              "justify-content": "center",
              color: "var(--dim)",
            }}
          >
            Loading diffs…
          </div>
        }
      >
        <Show
          when={data() && data()!.diff.trim().length > 0}
          fallback={
            <div
              data-testid="diffs-viewer-empty"
              style={{
                flex: "1",
                display: "flex",
                "align-items": "center",
                "justify-content": "center",
                color: "var(--dim)",
              }}
            >
              No uncommitted changes
            </div>
          }
        >
          {/* Toolbar */}
          <div
            data-diffs-header
            style={{
              display: "flex",
              "align-items": "center",
              height: "var(--chrome-h)",
              padding: "0 var(--space-3)",
              "background-color": "var(--surface)",
              "border-bottom": "1px solid var(--border)",
              "flex-shrink": "0",
              gap: "var(--space-2)",
            }}
          >
            <span style={{ color: "var(--dim)" }}>
              {files().length} file{files().length !== 1 ? "s" : ""} changed
            </span>
            <span style={{ color: "var(--dim)", opacity: "0.3" }}>│</span>
            <span style={{ color: "var(--green)" }}>+{totalAdditions()}</span>
            <span style={{ color: "var(--dim)", opacity: "0.3" }}>/</span>
            <span style={{ color: "var(--red)" }}>−{totalDeletions()}</span>
            <span style={{ flex: "1" }} />
            <div
              role="group"
              aria-label="diff view mode"
              style={{
                display: "flex",
                border: "1px solid var(--border)",
                "border-radius": "4px",
                overflow: "hidden",
              }}
            >
              <For each={["unified", "split"] as DiffStyle[]}>
                {(style) => (
                  <button
                    type="button"
                    data-testid={`diffs-viewer-style-${style}`}
                    onClick={() => setDiffStyle(style)}
                    aria-pressed={diffStyle() === style}
                    style={{
                      padding: "0 var(--space-2)",
                      height: "20px",
                      "font-size": "var(--text-sm)",
                      background: diffStyle() === style ? "var(--surface-active)" : "transparent",
                      color: diffStyle() === style ? "var(--fg)" : "var(--dim)",
                      border: "none",
                      cursor: "pointer",
                      "font-family": "inherit",
                    }}
                  >
                    {style}
                  </button>
                )}
              </For>
            </div>
          </div>

          {/* Body: file rail + patch viewport */}
          <div
            style={{
              display: "flex",
              flex: "1",
              "min-height": "0",
              "min-width": "0",
            }}
          >
            {/* File rail */}
            <div
              data-testid="diffs-viewer-file-list"
              style={{
                width: "260px",
                "flex-shrink": "0",
                "overflow-y": "auto",
                "border-right": "1px solid var(--border)",
                "background-color": "var(--bg-weak)",
              }}
            >
              <button
                type="button"
                data-testid="diffs-viewer-file-all"
                onClick={() => setSelectedFile(null)}
                aria-pressed={selectedFile() === null}
                style={{
                  width: "100%",
                  display: "flex",
                  "align-items": "center",
                  height: "24px",
                  padding: "0 var(--space-2)",
                  "text-align": "left",
                  border: "none",
                  background: selectedFile() === null ? "var(--surface-active)" : "transparent",
                  color: selectedFile() === null ? "var(--accent)" : "var(--dim)",
                  cursor: "pointer",
                  "font-family": "inherit",
                  "font-size": "inherit",
                }}
              >
                <span style={{ flex: "1", overflow: "hidden", "text-overflow": "ellipsis" }}>
                  All files
                </span>
                <span style={{ "flex-shrink": "0", color: "var(--dim)" }}>{files().length}</span>
              </button>
              <For each={files()}>
                {(f) => {
                  const basename = fileBasename(f.file);
                  const dir = fileDirname(f.file);
                  const isSelected = () => selectedFile() === f.file;
                  return (
                    <button
                      type="button"
                      data-testid="diffs-viewer-file"
                      data-diff-file-path={f.file}
                      onClick={() => setSelectedFile(f.file)}
                      aria-pressed={isSelected()}
                      style={{
                        width: "100%",
                        display: "flex",
                        "align-items": "center",
                        height: "24px",
                        padding: "0 var(--space-2)",
                        "text-align": "left",
                        border: "none",
                        background: isSelected() ? "var(--surface-active)" : "transparent",
                        cursor: "pointer",
                        "font-family": "inherit",
                        "font-size": "inherit",
                        color: "inherit",
                      }}
                    >
                      <span
                        style={{
                          flex: "1",
                          "min-width": "0",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        <Show when={dir}>
                          <span style={{ color: "var(--dim)" }}>{dir}</span>
                        </Show>
                        <span
                          style={{
                            color: isSelected() ? "var(--accent)" : "var(--fg)",
                          }}
                        >
                          {basename}
                        </span>
                      </span>
                      <span
                        style={{
                          "flex-shrink": "0",
                          display: "flex",
                          gap: "var(--space-2)",
                          "margin-left": "8px",
                        }}
                      >
                        <Show when={f.additions > 0}>
                          <span style={{ color: "var(--green)" }}>+{f.additions}</span>
                        </Show>
                        <Show when={f.deletions > 0}>
                          <span style={{ color: "var(--red)" }}>−{f.deletions}</span>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>

            {/* Patch viewport */}
            <div
              data-testid="diffs-viewer-patch"
              data-diff-style={diffStyle()}
              style={{
                flex: "1",
                "min-width": "0",
                "min-height": "0",
                display: "flex",
                "flex-direction": "column",
              }}
            >
              <Show when={error()}>
                <div
                  style={{
                    padding: "var(--space-1) var(--space-3)",
                    color: "var(--red)",
                    "background-color": "var(--bg-strong)",
                    "border-bottom": "1px solid var(--red)",
                    "font-size": "var(--text-sm)",
                  }}
                >
                  {error()}
                </div>
              </Show>
              <Show when={truncated()}>
                <div
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    background: "var(--surface)",
                    "border-bottom": "1px solid var(--border)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "space-between",
                  }}
                >
                  <span style={{ color: "var(--yellow)" }}>
                    showing first {MAX_DIFF_LINES} of {allLines().length} lines
                  </span>
                  <button
                    type="button"
                    data-testid="diffs-viewer-show-all"
                    onClick={() => setShowFull(true)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "var(--accent)",
                      cursor: "pointer",
                      "font-family": "inherit",
                      "font-size": "inherit",
                      "text-decoration": "underline",
                    }}
                  >
                    show all
                  </button>
                </div>
              </Show>
              <Show
                when={!loadingFile()}
                fallback={
                  <div
                    style={{
                      flex: "1",
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "center",
                      color: "var(--dim)",
                    }}
                  >
                    loading diff…
                  </div>
                }
              >
                <Show
                  when={lines().length > 0}
                  fallback={
                    <div
                      style={{
                        flex: "1",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        color: "var(--dim)",
                      }}
                    >
                      select a file to view diff
                    </div>
                  }
                >
                  <div
                    ref={setDiffScrollEl}
                    style={{
                      flex: "1",
                      "min-height": "0",
                      "min-width": "0",
                      "overflow-y": "auto",
                      "overflow-x": "auto",
                      position: "relative",
                    }}
                  >
                    <div
                      data-testid="diffs-viewer-spacer"
                      style={{
                        height: `${diffVirtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      <For each={diffVirtualizer.getVirtualItems()}>
                        {(vItem) => {
                          const ln = () => lines()[vItem.index]!;
                          return (
                            <div
                              data-index={vItem.index}
                              data-diff-line-kind={ln().kind}
                              style={{
                                position: "absolute",
                                top: "0",
                                left: "0",
                                width: "100%",
                                height: `${vItem.size}px`,
                                transform: `translateY(${vItem.start}px)`,
                                padding: "0 var(--space-3)",
                                "box-sizing": "border-box",
                                "white-space": "pre",
                                "line-height": "1.5",
                                color: LINE_COLOR[ln().kind].fg,
                                "background-color": LINE_COLOR[ln().kind].bg,
                              }}
                            >
                              {ln().text || " "}
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
