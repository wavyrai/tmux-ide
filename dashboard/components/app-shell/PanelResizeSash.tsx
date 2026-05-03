"use client";

/**
 * PanelResizeSash
 *
 * A thin drag handle between adjacent content panels in the panel stack.
 *
 * - Drag to resize the two adjacent panels (preserving their combined proportion)
 * - Double-click to reset both panels to equal share of their combined proportion
 * - Enforces PANEL_MIN_WIDTH on both sides during drag
 * - Measures sibling panel widths from the DOM on drag start (no width props needed)
 */

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  PANEL_MIN_WIDTH,
  PANEL_SASH_FLEX_MARGIN,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
} from "@/lib/panel-constants";

export interface PanelResizeUpdate {
  leftIndex: number;
  rightIndex: number;
  leftProportion: number;
  rightProportion: number;
}

interface PanelResizeSashProps {
  /** Index of the panel to the left of this sash (in the panels array) */
  leftIndex: number;
  /** Index of the panel to the right of this sash (in the panels array) */
  rightIndex: number;
  /** Current proportion of the left panel */
  leftProportion: number;
  /** Current proportion of the right panel */
  rightProportion: number;
  /** Fired with the new proportions while dragging or on double-click */
  onResize: (update: PanelResizeUpdate) => void;
  /** Fired when a drag starts (e.g. to disable transitions) */
  onResizeStart?: () => void;
  /** Fired when a drag ends */
  onResizeEnd?: () => void;
  /** Optional class for the visible line element */
  className?: string;
  testId?: string;
}

export function PanelResizeSash({
  leftIndex,
  rightIndex,
  leftProportion,
  rightProportion,
  onResize,
  onResizeStart,
  onResizeEnd,
  className,
  testId,
}: PanelResizeSashProps) {
  const sashRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startLeftWidthRef = useRef(0);
  const startRightWidthRef = useRef(0);
  const combinedProportionRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      const sashEl = sashRef.current;
      if (!sashEl) return;

      // Measure sibling panel widths from the DOM. The sash is rendered between
      // its left and right panel siblings, so previous/next sibling are the panels.
      const leftPanel = sashEl.previousElementSibling as HTMLElement | null;
      const rightPanel = sashEl.nextElementSibling as HTMLElement | null;
      if (!leftPanel || !rightPanel) return;

      startXRef.current = e.clientX;
      startLeftWidthRef.current = leftPanel.getBoundingClientRect().width;
      startRightWidthRef.current = rightPanel.getBoundingClientRect().width;
      combinedProportionRef.current = leftProportion + rightProportion;

      onResizeStart?.();

      const handleMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startXRef.current;
        const combinedWidth =
          startLeftWidthRef.current + startRightWidthRef.current;

        // Compute new pixel widths, clamped to PANEL_MIN_WIDTH
        let newLeftWidth = startLeftWidthRef.current + delta;
        let newRightWidth = startRightWidthRef.current - delta;

        if (newLeftWidth < PANEL_MIN_WIDTH) {
          newLeftWidth = PANEL_MIN_WIDTH;
          newRightWidth = combinedWidth - PANEL_MIN_WIDTH;
        }
        if (newRightWidth < PANEL_MIN_WIDTH) {
          newRightWidth = PANEL_MIN_WIDTH;
          newLeftWidth = combinedWidth - PANEL_MIN_WIDTH;
        }

        // Convert pixel ratio to proportions, preserving the combined proportion
        const combined = combinedProportionRef.current;
        const total = newLeftWidth + newRightWidth;
        if (total <= 0) return;
        const leftP = (newLeftWidth / total) * combined;
        const rightP = combined - leftP;

        onResize({
          leftIndex,
          rightIndex,
          leftProportion: leftP,
          rightProportion: rightP,
        });
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        onResizeEnd?.();
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [leftIndex, rightIndex, leftProportion, rightProportion, onResize, onResizeStart, onResizeEnd],
  );

  const handleDoubleClick = useCallback(() => {
    const combined = leftProportion + rightProportion;
    const half = combined / 2;
    onResize({
      leftIndex,
      rightIndex,
      leftProportion: half,
      rightProportion: half,
    });
  }, [leftIndex, rightIndex, leftProportion, rightProportion, onResize]);

  return (
    <div
      ref={sashRef}
      data-slot="panel-resize-sash"
      data-testid={testId}
      role="separator"
      aria-orientation="vertical"
      className="relative flex h-full w-0 shrink-0 cursor-col-resize justify-center"
      style={{ margin: `0 ${PANEL_SASH_FLEX_MARGIN}px` }}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {/* Hit area — wider than visible line for easier grabbing */}
      <div
        className="absolute inset-y-0 flex cursor-col-resize justify-center"
        style={{
          left: -PANEL_SASH_HALF_HIT_WIDTH,
          right: -PANEL_SASH_HALF_HIT_WIDTH,
        }}
      >
        <div
          className={cn(
            "absolute left-1/2 -translate-x-1/2 bg-[var(--border-weak)] transition-colors hover:bg-[var(--accent)]",
            className,
          )}
          style={{
            width: PANEL_SASH_LINE_WIDTH,
            top: PANEL_STACK_VERTICAL_OVERFLOW,
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
          }}
        />
      </div>
    </div>
  );
}
