import type { Layout } from "./topology.ts";
import type { TerminalReplicaSnapshot } from "../../../packages/contracts/src/index.ts";
import { contentRect } from "./window-canvas.ts";

/** tmux reflows panes sequentially; withhold mixed window sizes for at most 100ms. */
export function createLiveWindowSettle(options: {
  stopped(): boolean;
  surfaces: Map<string, TerminalReplicaSnapshot>;
  publish(): void;
}) {
  let since: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    since = null;
  }
  return {
    cancel,
    hold(layout: Layout | undefined) {
      const skewed =
        !options.stopped() &&
        !!layout &&
        layout.panes.every((p) => !!p.pane && options.surfaces.has(p.pane)) &&
        layout.panes.some((p) => {
          const frame = options.surfaces.get(p.pane!)!;
          return frame.cols !== p.width || frame.rows !== contentRect(layout, p).rows;
        });
      if (!skewed) {
        cancel();
        return false;
      }
      since ??= performance.now();
      const remaining = 100 - (performance.now() - since);
      if (remaining <= 0) return false;
      timer ??= setTimeout(() => {
        timer = undefined;
        if (!options.stopped()) options.publish();
      }, remaining);
      return true;
    },
  };
}
