import { createViewportQueue } from "./viewport-queue";

/** Accumulate input without optimistically changing the canonical pane geometry. */
export function createPaneResizeRequests(
  read: () => { cells: number; maximum: number },
  send: (cells: number) => Promise<boolean>,
  onError: () => void,
) {
  let requested: number | null = null;
  let canonical = read().cells;
  const queue = createViewportQueue(
    ({ cols }) => send(cols),
    () => {
      requested = null;
      onError();
    },
  );
  function request(value: number) {
    requested = Math.max(2, Math.min(read().maximum, Math.round(value)));
    queue.request({ cols: requested, rows: 1 });
  }
  return {
    request,
    step(delta: number) {
      request((requested ?? read().cells) + delta);
    },
    observe(cells: number) {
      if (requested === null && cells !== canonical) queue.reset();
      canonical = cells;
      // Intermediate layout echoes must not erase newer queued keyboard input.
      if (requested === cells) requested = null;
    },
    reset() {
      requested = null;
      queue.reset();
    },
    dispose() {
      requested = null;
      queue.dispose();
    },
  };
}
