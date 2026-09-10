import { useEffect, useRef, useState, type RefObject } from "react";
import type { WebWorkspaceClient } from "../../../desktop-renderer/src/runtime/web-workspace-client";
import type { PaneStreamLayoutEvent } from "../../../desktop-renderer/src/terminal/pane-stream-transport";
import { createViewportQueue } from "../viewport-queue";
import { fitSessionCells } from "../window-geometry";

export function useSessionViewport(
  client: WebWorkspaceClient,
  body: RefObject<HTMLDivElement | null>,
  layouts: readonly PaneStreamLayoutEvent[],
  cell: { width: number; height: number },
  cellsMeasured: boolean,
) {
  const [fitPending, setFitPending] = useState(false);
  const [fitError, setFitError] = useState("");
  const [autoFit, setAutoFit] = useState(true);
  const measurement = useRef({ layouts, cell, autoFit, cellsMeasured });
  measurement.current = { layouts, cell, autoFit, cellsMeasured };
  const requestFit = useRef<() => void>(() => {});
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    const queue = createViewportQueue(
      async (cells) => {
        if (
          !measurement.current.autoFit ||
          document.visibilityState !== "visible" ||
          !document.hasFocus()
        )
          return true;
        setFitPending(true);
        try {
          client.setPresence("foreground");
          client.noteActivity("geometry");
          const result = await client.fitViewport(cells.cols, cells.rows);
          if (!disposed && result !== "ok") {
            setFitError(
              result === "geometry-authority-conflict"
                ? "Another client controls sizing. Select Fit session to try again."
                : "The connection changed. Select Fit session to try again.",
            );
          }
          return result === "ok";
        } catch {
          if (!disposed) setFitError("Automatic sizing paused. Select Fit session to try again.");
          return false;
        } finally {
          if (!disposed) setFitPending(false);
        }
      },
      () => {
        if (!disposed) {
          measurement.current.autoFit = false;
          setAutoFit(false);
        }
      },
    );
    const measure = () => {
      if (
        !body.current ||
        !measurement.current.cellsMeasured ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      )
        return;
      const { layouts, cell } = measurement.current;
      const header =
        body.current.querySelector(".live-pane-header")?.getBoundingClientRect().height ?? 26;
      const cells = fitSessionCells(
        layouts,
        { width: body.current.clientWidth, height: body.current.clientHeight },
        cell,
        header,
      );
      if (cells) queue.request(cells);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (measurement.current.autoFit) measure();
      });
    };
    requestFit.current = () => {
      queue.reset();
      setFitError("");
      measure();
    };
    const presence = () => {
      queue.reset();
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    if (body.current) observer.observe(body.current);
    window.addEventListener("focus", presence);
    window.addEventListener("blur", presence);
    document.addEventListener("visibilitychange", presence);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      queue.dispose();
      observer.disconnect();
      window.removeEventListener("focus", presence);
      window.removeEventListener("blur", presence);
      document.removeEventListener("visibilitychange", presence);
      requestFit.current = () => {};
    };
  }, [client]);
  const fitKey = layouts
    .map((l) =>
      [
        l.semanticWindowId,
        l.zoomed,
        new Set(l.panes.filter((p) => !l.zoomed || p.active).map((p) => p.top)).size,
      ].join(":"),
    )
    .join("|");
  useEffect(() => {
    if (autoFit) requestFit.current();
  }, [cell.width, cell.height, fitKey, autoFit, cellsMeasured]);
  function fit() {
    measurement.current.autoFit = true;
    setAutoFit(true);
    requestFit.current();
  }

  return {
    fitPending,
    fitError,
    autoFit,
    fit,
    setAutoFit(enabled: boolean) {
      measurement.current.autoFit = enabled;
      setAutoFit(enabled);
    },
  };
}
