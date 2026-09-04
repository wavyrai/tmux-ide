/** Pure, resident Home selection. Rendering and observation do not own selection lifetime. */
export interface HomeAgentSelectionSnapshot {
  readonly selectedKey: string | null;
  readonly scrollOffset: number;
}

interface SelectableHomeAgent {
  readonly key: string;
  readonly paneId: string | null;
}

export interface HomeAgentSelectionOwner {
  snapshot(): HomeAgentSelectionSnapshot;
  subscribe(listener: (snapshot: HomeAgentSelectionSnapshot) => void): () => void;
  setRows(rows: readonly SelectableHomeAgent[]): void;
  setViewport(visibleRows: number): void;
  select(key: string): void;
  move(delta: number): void;
  dispose(): void;
}

export function createHomeAgentSelectionOwner(): HomeAgentSelectionOwner {
  let rows: readonly SelectableHomeAgent[] = [];
  let visibleRows = 1;
  let state: HomeAgentSelectionSnapshot = Object.freeze({ selectedKey: null, scrollOffset: 0 });
  const listeners = new Set<(snapshot: HomeAgentSelectionSnapshot) => void>();
  let disposed = false;

  const publish = (selectedKey: string | null, offset = state.scrollOffset) => {
    if (disposed) return;
    const selectedIndex = rows.findIndex((row) => row.key === selectedKey);
    let scrollOffset = Math.max(0, Math.min(offset, Math.max(0, rows.length - visibleRows)));
    if (selectedIndex >= 0) {
      if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
      else if (selectedIndex >= scrollOffset + visibleRows)
        scrollOffset = selectedIndex - visibleRows + 1;
    }
    if (state.selectedKey === selectedKey && state.scrollOffset === scrollOffset) return;
    state = Object.freeze({ selectedKey, scrollOffset });
    for (const listener of listeners) listener(state);
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setRows(next) {
      if (disposed) return;
      const previousIndex = Math.max(
        0,
        rows.findIndex((row) => row.key === state.selectedKey),
      );
      rows = next;
      if (rows.some((row) => row.key === state.selectedKey && row.paneId !== null)) {
        publish(state.selectedKey);
        return;
      }
      const start = Math.min(previousIndex, Math.max(0, rows.length - 1));
      const after = rows.slice(start).find((row) => row.paneId !== null);
      const before = rows
        .slice(0, start)
        .reverse()
        .find((row) => row.paneId !== null);
      publish((after ?? before)?.key ?? null);
    },
    setViewport(value) {
      if (disposed) return;
      visibleRows = Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1);
      publish(state.selectedKey);
    },
    select(key) {
      if (!rows.some((row) => row.key === key && row.paneId !== null)) return;
      publish(key);
    },
    move(delta) {
      if (!delta || Number.isNaN(delta)) return;
      const direction = delta > 0 ? 1 : -1;
      const current = rows.findIndex((row) => row.key === state.selectedKey);
      const start = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : current + direction;
      let remaining = Math.min(rows.length, Math.abs(delta));
      let key = state.selectedKey;
      for (let index = start; index >= 0 && index < rows.length; index += direction) {
        if (rows[index]!.paneId !== null) {
          key = rows[index]!.key;
          if (--remaining <= 0) break;
        }
      }
      publish(key);
    },
    dispose() {
      disposed = true;
      listeners.clear();
      rows = [];
    },
  };
}
