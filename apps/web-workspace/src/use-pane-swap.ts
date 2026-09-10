import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { WebWorkspaceClient } from "../../desktop-renderer/src/runtime/web-workspace-client";

export function usePaneSwap(
  client: WebWorkspaceClient,
  scope: string,
  enabled: boolean,
  onError: (message: string) => void,
) {
  const [source, setSource] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const drag = useRef<{
    pane: string;
    pointer: number;
    x: number;
    y: number;
    active: boolean;
    fence: string;
  } | null>(null);
  const generation = client.getSnapshot().generation;
  const fence = useRef("");
  fence.current = JSON.stringify([scope, generation, enabled]);
  const armedFence = useRef("");
  const busy = useRef(false);
  const targetRef = useRef<string | null>(null);
  const clear = () => {
    drag.current = null;
    armedFence.current = "";
    targetRef.current = null;
    setSource(null);
    setTarget(null);
  };
  useEffect(() => {
    clear();
  }, [scope, generation, enabled]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", clear);
    };
  }, []);
  async function swap(from: string, to: string, original: string) {
    clear();
    if (from === to || !enabled || busy.current || !client.ownsRuntimeAuthority?.("input")) return;
    if (original !== fence.current) return;
    const workspace = client.getSnapshot().target?.workspaceName;
    if (!workspace) return;
    busy.current = true;
    setPending(true);
    onError("");
    try {
      if (fence.current !== original) return;
      client.noteActivity("input");
      await client.dispatch({
        kind: "semantic-intent",
        intent: {
          verb: "workspace.pane.swap",
          workspaceName: workspace,
          sourceSemanticPaneId: from,
          targetSemanticPaneId: to,
        },
      });
    } catch {
      if (fence.current === original)
        onError("Could not swap panes. Check input control and try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function hit(event: ReactPointerEvent<HTMLButtonElement>) {
    const grid = event.currentTarget.closest(".live-window-grid");
    const pane = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-semantic-pane]");
    return pane && grid?.contains(pane) ? (pane.dataset.semanticPane ?? null) : null;
  }
  return {
    source,
    target,
    pending,
    handle(pane: string) {
      return {
        onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
          if (!enabled || busy.current || event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pane,
            pointer: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            active: false,
            fence: fence.current,
          };
        },
        onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
          const start = drag.current;
          if (!start || start.pointer !== event.pointerId) return;
          if (!start.active && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5)
            return;
          start.active = true;
          setSource(start.pane);
          const over = hit(event);
          targetRef.current = over !== start.pane ? over : null;
          setTarget(targetRef.current);
        },
        onPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
          const start = drag.current;
          if (!start || start.pointer !== event.pointerId) return;
          const over = hit(event);
          clear();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (start.active && over) void swap(start.pane, over, start.fence);
        },
        onPointerCancel: clear,
        onLostPointerCapture: clear,
        onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
          if (!enabled || busy.current || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          if (source && source !== pane) void swap(source, pane, armedFence.current);
          else {
            clear();
            armedFence.current = fence.current;
            setSource(source === pane ? null : pane);
          }
        },
      };
    },
  };
}
