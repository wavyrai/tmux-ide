import {
  WindowSplitLayoutResourceSchemaZ,
  type WindowSplitLayoutResource,
} from "../../../packages/contracts/src/window-split-layout.ts";
import {
  WindowLinkTargetSchemaZ,
  type WindowLinkTarget,
} from "../../../packages/contracts/src/window-links.ts";
import type { Layout } from "./topology.ts";

/** A resource grants no pointer target until it agrees with the displayed canonical geometry. */
export function splitLayoutMatches(resource: WindowSplitLayoutResource, layout: Layout) {
  return (
    !layout.zoomed &&
    resource.window.expectedSemanticWindowId === layout.semanticWindowId &&
    resource.cols === layout.cols &&
    resource.rows === layout.rows &&
    resource.panes.length === layout.panes.length &&
    resource.panes.every((p) => {
      const displayed = layout.panes.find((row) => row.pane === p.semanticPaneId);
      return (
        displayed &&
        displayed.left === p.left &&
        displayed.top === p.top &&
        displayed.width === p.width &&
        displayed.height === p.height
      );
    })
  );
}

/** Single in-flight read per canonical geometry; old reads cannot republish retired handles. */
export function createSplitLayoutReader(options: {
  read: (target: WindowLinkTarget, signal: AbortSignal) => Promise<WindowSplitLayoutResource>;
  changed: () => void;
}) {
  let key: string | null = null;
  let abort: AbortController | null = null;
  let value: WindowSplitLayoutResource | null = null;
  let disposed = false;
  const clear = () => {
    abort?.abort();
    abort = null;
    value = null;
  };
  return {
    current: () => (value === null ? null : WindowSplitLayoutResourceSchemaZ.parse(value)),
    update(input: WindowLinkTarget | null, layout: Layout | undefined, lifetime: number) {
      if (disposed) return;
      const target = input ? WindowLinkTargetSchemaZ.parse(input) : null;
      const snapshot = layout ? structuredClone(layout) : null;
      const next =
        target &&
        snapshot &&
        !snapshot.zoomed &&
        snapshot.semanticWindowId === target.expectedSemanticWindowId
          ? JSON.stringify([
              target,
              lifetime,
              snapshot.cols,
              snapshot.rows,
              snapshot.paneBorderStatus,
              snapshot.panes
                .map((p) => [p.pane, p.left, p.top, p.width, p.height])
                .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            ])
          : null;
      if (next === key) return;
      key = next;
      clear();
      options.changed();
      if (!next || !target || !snapshot) return;
      const request = new AbortController();
      abort = request;
      void Promise.resolve()
        .then(() => options.read(target, request.signal))
        .then((raw) => {
          if (disposed || request.signal.aborted || abort !== request) return;
          const parsed = WindowSplitLayoutResourceSchemaZ.parse(raw);
          if (
            JSON.stringify(parsed.window) !== JSON.stringify(target) ||
            !splitLayoutMatches(parsed, snapshot)
          )
            return;
          value = parsed;
          options.changed();
        })
        .catch(() => {
          /* Unsupported or stale reads leave split targets unavailable; no retry loop. */
        });
    },
    dispose() {
      disposed = true;
      key = null;
      clear();
    },
  };
}
