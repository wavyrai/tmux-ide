import { createSignal, createMemo, For, Show, onCleanup, onMount } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { fetchProjectFiles, type ProjectFileNode } from "../api";
import type { ExplorerMountOptions } from "../types";

interface ExplorerViewProps {
  options: () => ExplorerMountOptions;
}

interface FlatRow {
  node: ProjectFileNode;
  depth: number;
  expanded: boolean;
  expandable: boolean;
}

const ROW_HEIGHT = 20;
const OVERSCAN = 5;

/**
 * Walk the recursive file tree into a flat row list, honoring the
 * per-directory expanded set so collapsed branches are pruned.
 */
function flatten(
  tree: ProjectFileNode[],
  expanded: Set<string>,
  depth = 0,
  out: FlatRow[] = [],
): FlatRow[] {
  for (const node of tree) {
    const isExpanded = node.isDirectory && expanded.has(node.path);
    out.push({
      node,
      depth,
      expanded: isExpanded,
      expandable: node.isDirectory && !!node.children && node.children.length > 0,
    });
    if (isExpanded && node.children && node.children.length > 0) {
      flatten(node.children, expanded, depth + 1, out);
    }
  }
  return out;
}

export function ExplorerView(props: ExplorerViewProps) {
  const [tree, setTree] = createSignal<ProjectFileNode[]>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  const [selected, setSelected] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [truncated, setTruncated] = createSignal(false);
  const [listEl, setListEl] = createSignal<HTMLDivElement | null>(null);

  async function refresh() {
    try {
      setLoading(true);
      const data = await fetchProjectFiles(props.options());
      setTree(data.tree);
      setTruncated(data.truncated);
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

  const rows = createMemo<FlatRow[]>(() => flatten(tree(), expanded()));

  const virtualizer = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => listEl(),
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  // `virtualizer.getVirtualItems()` is a method call — calling it inline
  // inside `<For each={...}>` does not subscribe to the virtualizer's
  // internal state, so the For sees the empty initial array forever and
  // the rail renders an empty spacer. Memo wrappers re-run on virtualizer
  // re-measure (count change, scroll, resize, …).
  const virtualItems = createMemo(() => virtualizer.getVirtualItems());
  const virtualTotalSize = createMemo(() => virtualizer.getTotalSize());

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function activateRow(row: FlatRow) {
    if (row.node.isDirectory) {
      toggle(row.node.path);
    } else {
      props.options().onOpenFile?.(row.node.path);
    }
  }

  function scrollSelectedIntoView() {
    virtualizer.scrollToIndex(selected(), { align: "auto" });
  }

  // Keyboard navigation — j/k or arrow keys move selection,
  // enter / l / right activate, h / left collapse-or-up, r refreshes.
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const list = rows();
      if (list.length === 0) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        setSelected((i) => Math.min(list.length - 1, i + 1));
        e.preventDefault();
        queueMicrotask(scrollSelectedIntoView);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        setSelected((i) => Math.max(0, i - 1));
        e.preventDefault();
        queueMicrotask(scrollSelectedIntoView);
      } else if (e.key === "Enter" || e.key === "l" || e.key === "ArrowRight") {
        const row = list[selected()];
        if (row) activateRow(row);
        e.preventDefault();
      } else if (e.key === "h" || e.key === "ArrowLeft") {
        const row = list[selected()];
        if (!row) return;
        if (row.node.isDirectory && row.expanded) {
          toggle(row.node.path);
        } else {
          const targetDepth = row.depth - 1;
          if (targetDepth < 0) return;
          for (let i = selected() - 1; i >= 0; i--) {
            if (list[i]!.depth === targetDepth) {
              setSelected(i);
              break;
            }
          }
        }
        e.preventDefault();
        queueMicrotask(scrollSelectedIntoView);
      } else if (e.key === "r") {
        void refresh();
        e.preventDefault();
      } else if (e.key === "g") {
        setSelected(0);
        e.preventDefault();
        queueMicrotask(scrollSelectedIntoView);
      } else if (e.key === "G") {
        setSelected(list.length - 1);
        e.preventDefault();
        queueMicrotask(scrollSelectedIntoView);
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        "min-height": "0",
        "font-family": "var(--font-mono)",
        "font-size": "var(--text-base)",
        color: "var(--theme-text, var(--fg))",
        "background-color": "var(--theme-background, var(--bg))",
      }}
    >
      <header
        style={{
          padding: "var(--space-2) var(--space-3)",
          "border-bottom": "1px solid var(--theme-border, var(--border))",
          "flex-shrink": "0",
          display: "flex",
          gap: "var(--space-3)",
          "align-items": "center",
          "font-size": "var(--text-sm)",
          "font-variant-numeric": "tabular-nums",
        }}
      >
        <span style={{ "font-weight": "500" }}>Explorer</span>
        <Show when={truncated()}>
          <span style={{ color: "var(--yellow, var(--theme-focused-foreground-subdued))" }}>
            tree truncated · increase limit on backend
          </span>
        </Show>
        <span style={{ flex: "1" }} />
        <span style={{ color: "var(--theme-focused-foreground-subdued, var(--dim))" }}>
          {rows().length} entr{rows().length === 1 ? "y" : "ies"}
        </span>
      </header>

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

      <div
        ref={setListEl}
        style={{
          "flex-grow": "1",
          "overflow-y": "auto",
          "min-height": "0",
          position: "relative",
          contain: "strict",
        }}
        data-testid="v2-explorer-list"
      >
        <Show when={!loading() && rows().length === 0 && !error()}>
          <div
            style={{
              padding: "var(--space-3)",
              color: "var(--theme-focused-foreground-subdued, var(--dim))",
            }}
          >
            — no files visible (gitignored or empty) —
          </div>
        </Show>
        <Show when={loading() && rows().length === 0}>
          <div
            style={{
              padding: "var(--space-3)",
              color: "var(--theme-focused-foreground-subdued, var(--dim))",
            }}
          >
            … loading
          </div>
        </Show>
        <div
          data-testid="v2-explorer-spacer"
          style={{
            height: `${virtualTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={virtualItems()}>
            {(vItem) => {
              const row = () => rows()[vItem.index]!;
              const isSel = () => vItem.index === selected();
              const indent = () => row().depth * 12;
              const glyph = () => (row().node.isDirectory ? (row().expanded ? "▾" : "▸") : "·");
              return (
                <div
                  data-row-index={vItem.index}
                  data-row-path={row().node.path}
                  data-row-kind={row().node.isDirectory ? "dir" : "file"}
                  style={{
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    height: `${vItem.size}px`,
                    transform: `translateY(${vItem.start}px)`,
                    display: "flex",
                    "align-items": "center",
                    gap: "var(--space-2)",
                    padding: "var(--space-1) var(--space-3) var(--space-1) var(--space-2)",
                    "box-sizing": "border-box",
                    "border-left": isSel() ? "2px solid var(--accent)" : "2px solid transparent",
                    "background-color": isSel() ? "var(--surface-hover)" : "transparent",
                    cursor: "pointer",
                    "white-space": "nowrap",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                  }}
                  onClick={() => {
                    setSelected(vItem.index);
                    activateRow(row());
                  }}
                >
                  <span style={{ width: `${indent()}px`, "flex-shrink": "0" }} />
                  <span
                    aria-hidden="true"
                    style={{
                      color: "var(--theme-focused-foreground-subdued, var(--dim))",
                      "font-family": "var(--font-mono)",
                      width: "1ch",
                      "text-align": "center",
                      "flex-shrink": "0",
                    }}
                  >
                    {glyph()}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      color: "var(--theme-text, var(--fg))",
                      "font-weight": row().node.isDirectory ? "500" : "400",
                    }}
                  >
                    {row().node.name}
                  </span>
                  <Show when={row().node.truncated}>
                    <span
                      style={{
                        "font-size": "var(--text-xs)",
                        color: "var(--theme-focused-foreground-subdued, var(--dim))",
                      }}
                    >
                      …
                    </span>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>

      <footer
        style={{
          padding: "var(--space-1) var(--space-3)",
          "border-top": "1px solid var(--theme-border-subdued, var(--border-weak))",
          color: "var(--theme-focused-foreground-subdued, var(--dim))",
          "font-size": "var(--text-xs)",
          "flex-shrink": "0",
        }}
      >
        j/k navigate · enter/l open · h collapse/up · r refresh
      </footer>
    </div>
  );
}
