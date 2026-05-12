"use client";

/**
 * React → Solid bridge for the Explorer (file tree) widget.
 *
 * Same flow as the FileTree component in tui-tree: the host owns the
 * fetched tree + selectedPath; the widget owns expand state. Click
 * dispatches the path via onSelect — the host decides whether to load
 * a preview (for files) or just record the selection (for directories
 * — the widget *also* toggles the folder internally).
 *
 * ADR-0001 §1.4 Rule 4: the one *Bridge file allowed to call mount()
 * for the Explorer widget.
 */

import { useCallback, useEffect, useRef } from "react";

/**
 * File-tree node consumed by the Explorer Solid silo. Inlined here after
 * U2 retired the React `dashboard/components/tui-tree/FileTree.tsx`
 * (where this interface previously lived). The silo's bridge owns it now
 * because the silo is the only remaining consumer.
 */
export interface FileTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  ignored?: boolean;
  children?: FileTreeEntry[];
}

interface ExplorerBridgeProps {
  rootEntries: ReadonlyArray<FileTreeEntry>;
  selectedPath: string | null;
  gitignoreFilter?: boolean;
  defaultExpanded?: boolean;
  onSelect?: (path: string, entry: FileTreeEntry) => void;
}

// Structural shape of the widget's mount handle. Kept in sync with
// @tmux-ide/v2-solid-widgets's ExplorerDashboardMountHandle without
// importing it at compile time (the package is dynamically imported
// below).
type ExplorerDashboardMountHandle = {
  unmount(): void;
  setOptions(next: {
    rootEntries?: ReadonlyArray<{
      name: string;
      path: string;
      isDir: boolean;
      ignored?: boolean;
      children?: unknown;
    }>;
    selectedPath?: string | null;
    gitignoreFilter?: boolean;
    defaultExpanded?: boolean;
    onSelect?: (path: string, isDir: boolean) => void;
  }): void;
};

// Recursively walk the tree to find an entry by path, mirroring
// FileTree.tsx's findEntry helper so the host can hand the typed entry
// to its onSelect callback.
function findEntry(
  entries: ReadonlyArray<FileTreeEntry>,
  path: string,
): FileTreeEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.isDir && entry.children) {
      const found = findEntry(entry.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function ExplorerBridge({
  rootEntries,
  selectedPath,
  gitignoreFilter = true,
  defaultExpanded = false,
  onSelect,
}: ExplorerBridgeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ExplorerDashboardMountHandle | null>(null);

  // Stable refs so mount only fires once. Callers can change rootEntries
  // every render without remounting.
  const onSelectRef = useRef(onSelect);
  const rootEntriesRef = useRef(rootEntries);
  onSelectRef.current = onSelect;
  rootEntriesRef.current = rootEntries;

  const handleWidgetSelect = useCallback((path: string, _isDir: boolean) => {
    const entry = findEntry(rootEntriesRef.current, path);
    if (!entry) return;
    onSelectRef.current?.(path, entry);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cancelled = false;
    void (async () => {
      const mod = await import("@tmux-ide/v2-solid-widgets");
      if (cancelled) return;
      handleRef.current = mod.mountExplorerDashboard(el, {
        rootEntries,
        selectedPath,
        gitignoreFilter,
        defaultExpanded,
        onSelect: handleWidgetSelect,
      });
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // Mount once; prop updates flow through setOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current?.setOptions({
      rootEntries,
      selectedPath,
      gitignoreFilter,
      defaultExpanded,
    });
  }, [rootEntries, selectedPath, gitignoreFilter, defaultExpanded]);

  return (
    <div
      ref={containerRef}
      data-testid="explorer-bridge"
      style={{
        display: "flex",
        flex: "1 1 0%",
        minHeight: 0,
        minWidth: 0,
        width: "100%",
        height: "100%",
      }}
    />
  );
}
