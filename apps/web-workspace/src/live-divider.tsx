import { useEffect, useRef, type CSSProperties } from "react";
import type { WebWorkspaceClient } from "../../desktop-renderer/src/runtime/web-workspace-client";
import { createPaneResizeRequests } from "./pane-resize-requests";

/** Adjust native tmux cells; the canonical layout remains the only rendered geometry. */
export function LiveDivider({
  client,
  pane,
  axis,
  cells,
  maximum,
  cellPixels,
  enabled,
  style,
  onError,
}: {
  client: WebWorkspaceClient;
  pane: string;
  axis: "cols" | "rows";
  cells: number;
  maximum: number;
  cellPixels: number;
  enabled: boolean;
  style: CSSProperties;
  onError: (message: string) => void;
}) {
  const current = useRef({ cells, maximum, cellPixels, enabled, onError });
  current.current = { cells, maximum, cellPixels, enabled, onError };
  const queue = useRef<ReturnType<typeof createPaneResizeRequests> | null>(null);
  const drag = useRef<{ start: number; cells: number; pixels: number } | null>(null);
  const generation = client.getSnapshot().generation;
  useEffect(() => {
    const binding = client.getSnapshot();
    const resize = createPaneResizeRequests(
      () => current.current,
      async (cols) => {
        const snapshot = client.getSnapshot();
        if (
          snapshot.generation !== binding.generation ||
          snapshot.target?.workspaceName !== binding.target?.workspaceName ||
          snapshot.target?.daemon.instanceId !== binding.target?.daemon.instanceId
        )
          return false;
        if (!current.current.enabled || !client.ownsRuntimeAuthority?.("input")) return false;
        const target = snapshot.target;
        if (!target) return false;
        client.noteActivity("input");
        await client.dispatch({
          kind: "semantic-intent",
          intent: {
            verb: "workspace.pane.resize",
            workspaceName: target.workspaceName,
            semanticPaneId: pane,
            axis,
            cells: cols,
          },
        });
        return true;
      },
      () => {
        drag.current = null;
        current.current.onError("Pane resizing stopped. Check input control and try again.");
      },
    );
    queue.current = resize;
    return () => {
      resize.dispose();
      queue.current = null;
      drag.current = null;
    };
  }, [client, pane, axis, enabled, generation]);
  useEffect(() => {
    queue.current?.observe(cells);
  }, [cells]);
  const request = (value: number) => {
    if (!current.current.enabled) return;
    current.current.onError("");
    queue.current?.request(value);
  };
  const move = (position: number) => {
    const start = drag.current;
    if (start) request(start.cells + Math.round((position - start.start) / start.pixels));
  };
  return (
    <div
      data-slot="live-divider"
      className="live-divider"
      data-axis={axis}
      style={style}
      role="separator"
      aria-label={axis === "cols" ? "Resize pane columns" : "Resize pane rows"}
      aria-orientation={axis === "cols" ? "vertical" : "horizontal"}
      aria-valuemin={2}
      aria-valuemax={maximum}
      aria-valuenow={cells}
      aria-valuetext={`${cells} ${axis === "cols" ? "columns" : "rows"}`}
      aria-disabled={!enabled}
      tabIndex={enabled ? 0 : -1}
      title={
        enabled ? "Drag to resize · arrow keys for one cell" : "Take input control to resize panes"
      }
      onBlur={() => {
        drag.current = null;
        queue.current?.reset();
      }}
      onPointerDown={(e) => {
        if (!enabled || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        queue.current?.reset();
        drag.current = {
          start: axis === "cols" ? e.clientX : e.clientY,
          cells,
          pixels: cellPixels,
        };
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          move(axis === "cols" ? e.clientX : e.clientY);
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        move(axis === "cols" ? e.clientX : e.clientY);
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        queue.current?.reset();
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onKeyDown={(e) => {
        if (!enabled) return;
        if (e.key === "Escape") {
          drag.current = null;
          queue.current?.reset();
          return;
        }
        const delta =
          e.key === (axis === "cols" ? "ArrowRight" : "ArrowDown")
            ? 1
            : e.key === (axis === "cols" ? "ArrowLeft" : "ArrowUp")
              ? -1
              : 0;
        if (delta) {
          e.preventDefault();
          current.current.onError("");
          queue.current?.step(delta * (e.shiftKey ? 5 : 1));
        }
      }}
    />
  );
}
