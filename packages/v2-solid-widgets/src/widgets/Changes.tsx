import { createSignal, createMemo, createEffect, For, Show, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { fetchProjectDiff, fetchProjectFileDiff, type DiffData, type DiffFileEntry } from "../api";
import type { BaseMountOptions } from "../types";

interface ChangesViewProps {
  options: () => BaseMountOptions;
}

type DiffStyle = "unified" | "split";

interface DiffLine {
  kind: "context" | "add" | "del" | "hunk" | "meta";
  text: string;
}

function classifyLine(line: string): DiffLine["kind"] {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ")
  )
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

function parseDiff(patch: string): DiffLine[] {
  if (!patch) return [];
  return patch.split("\n").map((text) => ({ kind: classifyLine(text), text }));
}

function colorFor(kind: DiffLine["kind"]): { fg: string; bg: string } {
  switch (kind) {
    case "add":
      return { fg: "var(--diff-add-text, var(--green))", bg: "var(--diff-add-bg, transparent)" };
    case "del":
      return { fg: "var(--diff-del-text, var(--red))", bg: "var(--diff-del-bg, transparent)" };
    case "hunk":
      return { fg: "var(--cyan, var(--accent))", bg: "transparent" };
    case "meta":
      return { fg: "var(--theme-focused-foreground-subdued, var(--dim))", bg: "transparent" };
    default:
      return { fg: "var(--theme-text, var(--fg))", bg: "transparent" };
  }
}

export function ChangesView(props: ChangesViewProps) {
  const [data, setData] = createSignal<DiffData | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [selected, setSelected] = createSignal(0);
  const [filePatch, setFilePatch] = createSignal<string>("");
  const [diffStyle, setDiffStyle] = createSignal<DiffStyle>("unified");
  const [diffEl, setDiffEl] = createSignal<HTMLDivElement | null>(null);
  let listEl: HTMLDivElement | undefined;

  async function refresh() {
    try {
      setLoading(true);
      const d = await fetchProjectDiff(props.options());
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => {
    void refresh();
  });

  // When sessionName changes (host re-targeted), reload.
  createEffect(() => {
    void props.options().sessionName;
    void refresh();
  });

  const files = createMemo<DiffFileEntry[]>(() => data()?.files ?? []);
  const totalAdditions = createMemo(() => files().reduce((s, f) => s + f.additions, 0));
  const totalDeletions = createMemo(() => files().reduce((s, f) => s + f.deletions, 0));

  // Fetch per-file patch when selection changes.
  createEffect(() => {
    const list = files();
    const f = list[selected()];
    if (!f) {
      setFilePatch("");
      return;
    }
    void fetchProjectFileDiff(props.options(), f.file)
      .then(setFilePatch)
      .catch(() => setFilePatch(""));
  });

  const lines = createMemo<DiffLine[]>(() => parseDiff(filePatch()));

  function scrollSelectedListItemIntoView() {
    if (!listEl) return;
    const node = listEl.querySelector<HTMLElement>(`[data-file-index="${selected()}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }

  // Keyboard: j/k navigate files, r refresh, Tab toggles split/unified.
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const list = files();
      if (e.key === "j" || e.key === "ArrowDown") {
        setSelected((i) => Math.min(Math.max(0, list.length - 1), i + 1));
        e.preventDefault();
        queueMicrotask(scrollSelectedListItemIntoView);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        setSelected((i) => Math.max(0, i - 1));
        e.preventDefault();
        queueMicrotask(scrollSelectedListItemIntoView);
      } else if (e.key === "r") {
        void refresh();
        e.preventDefault();
      } else if (e.key === "Tab") {
        setDiffStyle((s) => (s === "unified" ? "split" : "unified"));
        e.preventDefault();
      } else if (e.key === "g") {
        setSelected(0);
        e.preventDefault();
        queueMicrotask(scrollSelectedListItemIntoView);
      } else if (e.key === "G") {
        setSelected(Math.max(0, list.length - 1));
        e.preventDefault();
        queueMicrotask(scrollSelectedListItemIntoView);
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Reset diff scroll when selection or style changes.
  createEffect(() => {
    void selected();
    void diffStyle();
    const el = diffEl();
    if (el) el.scrollTop = 0;
  });

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        "font-family": "var(--font-family-mono, var(--font-mono))",
        "font-size": "12px",
        color: "var(--theme-text, var(--fg))",
        "background-color": "var(--theme-background, var(--bg))",
      }}
    >
      {/* Toolbar */}
      <header
        style={{
          display: "flex",
          "align-items": "center",
          gap: "12px",
          padding: "6px 12px",
          "border-bottom": "1px solid var(--theme-border, var(--border))",
          "flex-shrink": "0",
          "font-size": "11px",
          "font-variant-numeric": "tabular-nums",
        }}
      >
        <span style={{ "font-weight": "500" }}>Changes</span>
        <span style={{ color: "var(--theme-focused-foreground-subdued, var(--dim))" }}>
          {files().length} file{files().length === 1 ? "" : "s"}
        </span>
        <Show when={totalAdditions() > 0}>
          <span style={{ color: "var(--green, var(--diff-add-text))" }}>+{totalAdditions()}</span>
        </Show>
        <Show when={totalDeletions() > 0}>
          <span style={{ color: "var(--red, var(--diff-del-text))" }}>-{totalDeletions()}</span>
        </Show>
        <span style={{ flex: "1" }} />
        <div
          style={{
            display: "inline-flex",
            border: "1px solid var(--theme-border, var(--border))",
            "border-radius": "2px",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            data-testid="v2-changes-style-unified"
            onClick={() => setDiffStyle("unified")}
            style={{
              padding: "1px 8px",
              "font-size": "11px",
              "font-family": "inherit",
              cursor: "pointer",
              border: "none",
              background: diffStyle() === "unified" ? "var(--surface-hover)" : "transparent",
              color:
                diffStyle() === "unified"
                  ? "var(--theme-text, var(--fg))"
                  : "var(--theme-focused-foreground-subdued, var(--dim))",
            }}
          >
            unified
          </button>
          <button
            type="button"
            data-testid="v2-changes-style-split"
            onClick={() => setDiffStyle("split")}
            style={{
              padding: "1px 8px",
              "font-size": "11px",
              "font-family": "inherit",
              cursor: "pointer",
              border: "none",
              background: diffStyle() === "split" ? "var(--surface-hover)" : "transparent",
              color:
                diffStyle() === "split"
                  ? "var(--theme-text, var(--fg))"
                  : "var(--theme-focused-foreground-subdued, var(--dim))",
            }}
          >
            split
          </button>
        </div>
      </header>

      <Show when={error()}>
        <div
          style={{
            padding: "4px 12px",
            color: "var(--red)",
            "background-color": "var(--bg-strong)",
            "border-bottom": "1px solid var(--red)",
            "font-size": "11px",
          }}
        >
          {error()}
        </div>
      </Show>

      {/* File rail + patch viewer */}
      <div style={{ display: "flex", "flex-grow": "1", "min-height": "0", "min-width": "0" }}>
        {/* Left rail */}
        <div
          ref={listEl}
          data-testid="v2-changes-files"
          style={{
            width: "260px",
            "flex-shrink": "0",
            "border-right": "1px solid var(--theme-border, var(--border))",
            "overflow-y": "auto",
          }}
        >
          <Show
            when={files().length > 0}
            fallback={
              <div
                style={{
                  padding: "12px",
                  color: "var(--theme-focused-foreground-subdued, var(--dim))",
                }}
              >
                <Show when={!loading()} fallback={<>… loading</>}>
                  All clean ✓
                </Show>
              </div>
            }
          >
            <For each={files()}>
              {(f, i) => {
                const isSel = () => i() === selected();
                return (
                  <div
                    data-file-index={i()}
                    data-file-path={f.file}
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      padding: "2px 8px",
                      "border-left": isSel() ? "2px solid var(--accent)" : "2px solid transparent",
                      "background-color": isSel() ? "var(--surface-hover)" : "transparent",
                      cursor: "pointer",
                      "white-space": "nowrap",
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                    }}
                    onClick={() => setSelected(i())}
                  >
                    <span
                      style={{
                        "min-width": "0",
                        flex: "1",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                      }}
                    >
                      {f.file}
                    </span>
                    <Show when={f.additions > 0}>
                      <span
                        style={{
                          color: "var(--green, var(--diff-add-text))",
                          "font-variant-numeric": "tabular-nums",
                        }}
                      >
                        +{f.additions}
                      </span>
                    </Show>
                    <Show when={f.deletions > 0}>
                      <span
                        style={{
                          color: "var(--red, var(--diff-del-text))",
                          "font-variant-numeric": "tabular-nums",
                        }}
                      >
                        -{f.deletions}
                      </span>
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
        </div>

        {/* Right pane: patch viewer */}
        <div
          ref={setDiffEl}
          data-testid="v2-changes-patch"
          style={{
            "flex-grow": "1",
            overflow: "auto",
            "min-width": "0",
            position: "relative",
          }}
        >
          <Show
            when={files()[selected()] && filePatch()}
            fallback={
              <div
                style={{
                  padding: "12px",
                  color: "var(--theme-focused-foreground-subdued, var(--dim))",
                }}
              >
                {files().length === 0 && !loading()
                  ? "No uncommitted changes"
                  : "Select a file to view diff"}
              </div>
            }
          >
            <Show
              when={diffStyle() === "unified"}
              fallback={<SplitDiff lines={lines()} scrollEl={diffEl} />}
            >
              <UnifiedDiff lines={lines()} scrollEl={diffEl} />
            </Show>
          </Show>
        </div>
      </div>

      <footer
        style={{
          padding: "4px 12px",
          "border-top": "1px solid var(--theme-border-subdued, var(--border-weak))",
          color: "var(--theme-focused-foreground-subdued, var(--dim))",
          "font-size": "10px",
          "flex-shrink": "0",
        }}
      >
        j/k navigate files · r refresh · tab toggle split/unified
      </footer>
    </div>
  );
}

interface DiffViewProps {
  lines: DiffLine[];
  scrollEl: () => HTMLDivElement | null;
}

const DIFF_LINE_HEIGHT = 17; // font-size 11px × line-height 1.5 ≈ 16.5px

function UnifiedDiff(props: DiffViewProps) {
  const virtualizer = createVirtualizer({
    get count() {
      return props.lines.length;
    },
    getScrollElement: () => props.scrollEl(),
    estimateSize: () => DIFF_LINE_HEIGHT,
    overscan: 16,
  });
  // Memo wrappers for reactivity inside <For each={...}>.
  const virtualItems = createMemo(() => virtualizer.getVirtualItems());
  const virtualTotalSize = createMemo(() => virtualizer.getTotalSize());
  return (
    <div
      data-testid="v2-changes-unified-spacer"
      style={{
        "font-size": "11px",
        "line-height": "1.5",
        height: `${virtualTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      <For each={virtualItems()}>
        {(vItem) => {
          const line = () => props.lines[vItem.index]!;
          const c = () => colorFor(line().kind);
          return (
            <div
              data-index={vItem.index}
              style={{
                position: "absolute",
                top: "0",
                left: "0",
                width: "100%",
                height: `${vItem.size}px`,
                transform: `translateY(${vItem.start}px)`,
                "background-color": c().bg,
                color: c().fg,
                "white-space": "pre",
                "box-sizing": "border-box",
              }}
            >
              {line().text || " "}
            </div>
          );
        }}
      </For>
    </div>
  );
}

/**
 * Split view: emits each line into either the left column (`-` / context),
 * the right column (`+` / context), or both (context / hunk / meta). Hunk
 * markers and meta span both columns. Each virtualized row is a grid
 * with two columns so the layout matches the original.
 */
function SplitDiff(props: DiffViewProps) {
  const virtualizer = createVirtualizer({
    get count() {
      return props.lines.length;
    },
    getScrollElement: () => props.scrollEl(),
    estimateSize: () => DIFF_LINE_HEIGHT,
    overscan: 16,
  });
  // Memo wrappers for reactivity inside <For each={...}>.
  const virtualItems = createMemo(() => virtualizer.getVirtualItems());
  const virtualTotalSize = createMemo(() => virtualizer.getTotalSize());
  return (
    <div
      data-testid="v2-changes-split-spacer"
      style={{
        "font-size": "11px",
        "line-height": "1.5",
        height: `${virtualTotalSize()}px`,
        width: "100%",
        position: "relative",
      }}
    >
      <For each={virtualItems()}>
        {(vItem) => {
          const line = () => props.lines[vItem.index]!;
          const c = () => colorFor(line().kind);
          const rowStyle = {
            position: "absolute" as const,
            top: "0",
            left: "0",
            width: "100%",
            height: `${vItem.size}px`,
            transform: `translateY(${vItem.start}px)`,
            display: "grid",
            "grid-template-columns": "1fr 1fr",
            "box-sizing": "border-box" as const,
          };
          if (line().kind === "hunk" || line().kind === "meta") {
            return (
              <div data-index={vItem.index} style={rowStyle}>
                <div
                  style={{
                    "background-color": c().bg,
                    color: c().fg,
                    "white-space": "pre",
                    "grid-column": "1 / -1",
                  }}
                >
                  {line().text || " "}
                </div>
              </div>
            );
          }
          if (line().kind === "del") {
            return (
              <div data-index={vItem.index} style={rowStyle}>
                <div
                  style={{
                    "background-color": c().bg,
                    color: c().fg,
                    "white-space": "pre",
                    "border-right": "1px solid var(--theme-border-subdued, var(--border-weak))",
                  }}
                >
                  {line().text || " "}
                </div>
                <div
                  style={{
                    "white-space": "pre",
                    "border-right": "1px solid var(--theme-border-subdued, var(--border-weak))",
                  }}
                />
              </div>
            );
          }
          if (line().kind === "add") {
            return (
              <div data-index={vItem.index} style={rowStyle}>
                <div
                  style={{
                    "white-space": "pre",
                    "border-right": "1px solid var(--theme-border-subdued, var(--border-weak))",
                  }}
                />
                <div style={{ "background-color": c().bg, color: c().fg, "white-space": "pre" }}>
                  {line().text || " "}
                </div>
              </div>
            );
          }
          // context — both columns
          return (
            <div data-index={vItem.index} style={rowStyle}>
              <div
                style={{
                  color: c().fg,
                  "white-space": "pre",
                  "border-right": "1px solid var(--theme-border-subdued, var(--border-weak))",
                }}
              >
                {line().text || " "}
              </div>
              <div style={{ color: c().fg, "white-space": "pre" }}>{line().text || " "}</div>
            </div>
          );
        }}
      </For>
    </div>
  );
}
