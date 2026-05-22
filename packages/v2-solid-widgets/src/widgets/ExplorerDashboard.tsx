/**
 * ExplorerDashboard — Solid port of dashboard/components/tui-tree/FileTree.tsx.
 *
 * Recursive nested-tree renderer with per-node expand/collapse. The
 * React host fetches `/api/project/:name/files` and pushes the tree
 * through `setOptions({ rootEntries })`; the widget owns the expanded
 * set in a single `createSignal<Set<string>>()` so toggling one folder
 * is a single signal write and Solid re-renders only that subtree —
 * which is the architectural payoff the recursive case stress-tests.
 *
 * Visual language mirrors FileTree.tsx + matches t3's file-rail
 * idiom:
 *   - Folders show a chevron (▸ closed / ▾ open) prefix, files
 *     show a leaf prefix (·).
 *   - Tight 22px rows, monospace, subtle hover background.
 *   - Selection: ▸ marker AND var(--accent) foreground.
 *   - Gitignored entries dimmed when filter is OFF, hidden when ON.
 *
 * Data-* attributes: data-explorer-row (per node, with path /
 * selected / is-dir / depth), data-explorer-tree (root). Themers
 * target rows without touching widget internals.
 *
 * Click contract: a single delegated handler at the root resolves
 * the clicked row via `closest('[data-explorer-row]')` — matches the
 * delegation pattern in FileTree.tsx (avoids per-row listeners).
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import type { ExplorerDashboardMountOptions, ExplorerNode } from "../types";

interface ExplorerDashboardViewProps {
  options: () => ExplorerDashboardMountOptions;
}

interface FlatRow {
  node: ExplorerNode;
  depth: number;
}

function filterEntries(
  entries: ReadonlyArray<ExplorerNode>,
  gitignoreFilter: boolean,
): ExplorerNode[] {
  if (!gitignoreFilter) return [...entries];
  return entries.filter((e) => !e.ignored);
}

/**
 * Walk the recursive tree into a flat row list honoring the
 * expansion predicate so collapsed subtrees are pruned. This makes
 * the (previously recursive) tree a single linear list the
 * virtualizer can window.
 */
function flattenTree(
  entries: ReadonlyArray<ExplorerNode>,
  gitignoreFilter: boolean,
  isExpanded: (path: string) => boolean,
  depth = 0,
  out: FlatRow[] = [],
): FlatRow[] {
  for (const node of filterEntries(entries, gitignoreFilter)) {
    out.push({ node, depth });
    if (node.isDir && isExpanded(node.path) && node.children && node.children.length > 0) {
      flattenTree(node.children, gitignoreFilter, isExpanded, depth + 1, out);
    }
  }
  return out;
}

export function ExplorerDashboardView(props: ExplorerDashboardViewProps) {
  // Widget-owned expanded-paths set. Persists across snapshot updates
  // (a host re-fetch that keeps the same folder structure leaves the
  // user's open folders open) but resets when the widget unmounts.
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  const rootEntries = createMemo<ReadonlyArray<ExplorerNode>>(
    () => props.options().rootEntries ?? [],
  );
  const gitignoreFilter = createMemo(() => props.options().gitignoreFilter !== false);
  const defaultExpanded = createMemo(() => props.options().defaultExpanded === true);
  const selectedPath = createMemo<string | null>(() => props.options().selectedPath ?? null);

  const visibleRoots = createMemo<ExplorerNode[]>(() =>
    filterEntries(rootEntries(), gitignoreFilter()),
  );

  // A node is expanded if (a) it's explicitly in the expanded set or
  // (b) defaultExpanded is on AND it hasn't been explicitly collapsed.
  // We track collapsed-overrides separately so defaultExpanded behaves
  // intuitively without polluting `expanded` with every initial path.
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());

  function isExpanded(path: string): boolean {
    if (expanded().has(path)) return true;
    if (defaultExpanded() && !collapsed().has(path)) return true;
    return false;
  }

  function toggle(path: string) {
    if (isExpanded(path)) {
      // Currently open → close. If it was open via defaultExpanded
      // mark it collapsed; otherwise remove from expanded.
      const open = expanded();
      if (open.has(path)) {
        const next = new Set(open);
        next.delete(path);
        setExpanded(next);
      } else {
        const next = new Set(collapsed());
        next.add(path);
        setCollapsed(next);
      }
    } else {
      // Currently closed → open. Remove any collapsed-override and add
      // to the expanded set so the rule order is consistent.
      const exp = new Set(expanded());
      exp.add(path);
      setExpanded(exp);
      const col = new Set(collapsed());
      col.delete(path);
      setCollapsed(col);
    }
  }

  function handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest<HTMLElement>("[data-explorer-row]");
    if (!row) return;
    const path = row.getAttribute("data-explorer-row");
    const isDir = row.getAttribute("data-explorer-is-dir") === "true";
    if (!path) return;
    if (isDir) toggle(path);
    props.options().onSelect?.(path, isDir);
  }

  // Flatten the recursive tree to a single linear row list so the
  // virtualizer can window it. Recomputes when the tree, gitignore
  // filter, or any expand/collapse state changes.
  const flatRows = createMemo<FlatRow[]>(() =>
    flattenTree(visibleRoots(), gitignoreFilter(), isExpanded),
  );

  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | null>(null);
  const virtualizer = createVirtualizer({
    get count() {
      return flatRows().length;
    },
    getScrollElement: () => scrollEl(),
    estimateSize: () => 22,
    overscan: 8,
    getItemKey: (i) => flatRows()[i]?.node.path ?? i,
  });
  // Inline `.getVirtualItems()` / `.getTotalSize()` inside JSX does
  // not subscribe to the virtualizer's signal — wrap in createMemo
  // per commit 9b139e5 so the spacer + For re-render on scroll.
  const virtualItems = createMemo(() => virtualizer.getVirtualItems());
  const virtualTotalSize = createMemo(() => virtualizer.getTotalSize());

  return (
    <div
      ref={setScrollEl}
      data-testid="explorer-dashboard-solid"
      data-explorer-tree
      role="tree"
      onClick={handleClick}
      style={{
        width: "100%",
        height: "100%",
        "min-height": "0",
        "overflow-y": "auto",
        "font-family": "var(--font-mono)",
        "font-size": "var(--text-base)",
        color: "var(--fg)",
        "background-color": "var(--bg-weak, var(--bg))",
        position: "relative",
      }}
    >
      <Show
        when={flatRows().length > 0}
        fallback={
          <div
            data-testid="explorer-dashboard-empty"
            style={{
              padding: "var(--space-4)",
              color: "var(--dim)",
              "font-size": "var(--text-sm)",
            }}
          >
            no files
          </div>
        }
      >
        <div
          data-testid="explorer-dashboard-spacer"
          style={{
            height: `${virtualTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          <For each={virtualItems()}>
            {(vItem) => {
              const row = () => flatRows()[vItem.index]!;
              return (
                <div
                  data-index={vItem.index}
                  style={{
                    position: "absolute",
                    top: "0",
                    left: "0",
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <ExplorerRow
                    entry={row().node}
                    depth={row().depth}
                    gitignoreFilter={gitignoreFilter}
                    selectedPath={selectedPath}
                    isExpanded={isExpanded}
                  />
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

interface ExplorerRowProps {
  entry: ExplorerNode;
  depth: number;
  gitignoreFilter: () => boolean;
  selectedPath: () => string | null;
  isExpanded: (path: string) => boolean;
}

function ExplorerRow(props: ExplorerRowProps) {
  const isSelected = () => props.selectedPath() === props.entry.path;
  const open = () => props.isExpanded(props.entry.path);
  const visibleChildren = createMemo<ExplorerNode[]>(() => {
    if (!props.entry.isDir) return [];
    return filterEntries(props.entry.children ?? [], props.gitignoreFilter());
  });
  const isIgnored = () => props.entry.ignored === true;

  const indentPx = () => `${props.depth * 14 + 6}px`;

  return (
    <div
      role="treeitem"
      aria-selected={isSelected()}
      aria-expanded={props.entry.isDir ? open() : undefined}
      data-explorer-row={props.entry.path}
      data-explorer-is-dir={props.entry.isDir ? "true" : "false"}
      data-explorer-selected={isSelected() ? "true" : "false"}
      data-explorer-ignored={isIgnored() ? "true" : "false"}
      data-explorer-depth={props.depth}
      style={{
        display: "flex",
        "align-items": "center",
        gap: "var(--space-1)",
        height: "22px",
        "padding-left": indentPx(),
        "padding-right": "8px",
        cursor: "pointer",
        background: isSelected() ? "var(--surface-active, var(--surface))" : "transparent",
        color: isSelected() ? "var(--accent)" : isIgnored() ? "var(--dim)" : "var(--fg)",
        "user-select": "none",
        opacity: isIgnored() && !props.gitignoreFilter() ? "0.6" : "1",
      }}
      onMouseEnter={(e) => {
        if (!isSelected()) {
          e.currentTarget.style.background = "var(--surface-hover, var(--surface))";
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected()) {
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "10px",
          "flex-shrink": "0",
          color: "var(--fg-muted, var(--dim))",
          "text-align": "center",
          "font-size": "var(--text-xs)",
        }}
      >
        <Show when={props.entry.isDir} fallback={"·"}>
          {open() ? "▾" : "▸"}
        </Show>
      </span>
      <span
        style={{
          "min-width": "0",
          flex: "1",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.entry.name}
      </span>
      <Show when={props.entry.isDir && visibleChildren().length > 0}>
        <span
          style={{
            "flex-shrink": "0",
            "font-size": "var(--text-xs)",
            color: "var(--dim)",
            "font-variant-numeric": "tabular-nums",
          }}
        >
          {visibleChildren().length}
        </span>
      </Show>
    </div>
  );
}
