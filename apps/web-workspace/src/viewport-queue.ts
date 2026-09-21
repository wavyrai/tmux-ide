export interface ViewportCells {
  cols: number;
  rows: number;
}

/** One resize in flight, at most one latest replacement; never replay after failure. */
export function createViewportQueue(
  send: (cells: ViewportCells) => Promise<boolean>,
  onError: () => void,
) {
  let disposed = false;
  let running = false;
  let pending: ViewportCells | null = null;
  let applied = "";
  let epoch = 0;
  const key = (cells: ViewportCells) => `${cells.cols}:${cells.rows}`;
  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        const next = pending;
        const attempt = epoch;
        pending = null;
        if (key(next) === applied) continue;
        let ok = false;
        try {
          ok = await send(next);
        } catch {
          ok = false;
        }
        if (disposed) return;
        if (attempt !== epoch) continue;
        if (!ok) {
          pending = null;
          applied = "";
          onError();
          return;
        }
        applied = key(next);
      }
    } finally {
      running = false;
    }
  }
  return {
    request(cells: ViewportCells) {
      if (disposed) return;
      pending = cells;
      void drain();
    },
    reset() {
      epoch++;
      pending = null;
      applied = "";
    },
    dispose() {
      disposed = true;
      pending = null;
    },
  };
}
