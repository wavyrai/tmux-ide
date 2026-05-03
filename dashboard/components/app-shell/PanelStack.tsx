"use client";

/**
 * PanelStack
 *
 * Horizontal flex container for content panels with drag-to-resize sashes
 * between them.
 *
 * - Single panel: fills 100% width, no sash rendered.
 * - Two or more panels: each panel gets `flex: <proportion> 1 0px` with
 *   `min-width: PANEL_MIN_WIDTH`. The container scrolls horizontally when
 *   panels would shrink below their min-width.
 *
 * Sashes render between adjacent panels and call `onResize` with the new
 * proportions. The container preserves the combined proportion of the two
 * adjacent panels, so other panels are unaffected.
 */

import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PANEL_GAP, PANEL_MIN_WIDTH } from "@/lib/panel-constants";
import { PanelResizeSash, type PanelResizeUpdate } from "./PanelResizeSash";

export interface PanelStackEntry {
  id: string;
  /** Flex-grow weight (typically a ratio in 0..1, but any positive number works) */
  proportion: number;
  content: ReactNode;
}

export interface PanelStackResizeUpdate {
  leftIndex: number;
  rightIndex: number;
  leftProportion: number;
  rightProportion: number;
}

interface PanelStackProps {
  panels: PanelStackEntry[];
  onResize?: (update: PanelStackResizeUpdate) => void;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function PanelStack({
  panels,
  onResize,
  className,
  style,
  testId,
}: PanelStackProps) {
  const [isResizing, setIsResizing] = useState(false);

  const handleSashResize = useCallback(
    (update: PanelResizeUpdate) => {
      onResize?.(update);
    },
    [onResize],
  );

  const handleResizeStart = useCallback(() => setIsResizing(true), []);
  const handleResizeEnd = useCallback(() => setIsResizing(false), []);

  if (panels.length === 0) {
    return (
      <div
        data-slot="panel-stack"
        data-testid={testId}
        className={cn("flex h-full min-w-0 flex-1", className)}
        style={style}
      />
    );
  }

  const isSingle = panels.length === 1;

  return (
    <div
      data-slot="panel-stack"
      data-testid={testId}
      className={cn("flex h-full min-w-0 flex-1", className)}
      style={{
        overflowX: "auto",
        overflowY: "hidden",
        ...style,
      }}
    >
      <div
        className="flex h-full"
        style={{ gap: PANEL_GAP, flexGrow: 1, minWidth: 0 }}
      >
        {panels.map((entry, index) => {
          const isFirst = index === 0;
          const showSash = !isSingle && !isFirst;
          const prev = showSash ? panels[index - 1] : undefined;

          const slotStyle: CSSProperties = isSingle
            ? { flexGrow: 1, minWidth: 0 }
            : {
                flexGrow: entry.proportion,
                flexShrink: 1,
                flexBasis: 0,
                minWidth: PANEL_MIN_WIDTH,
              };

          return (
            <PanelSlot
              key={entry.id}
              id={entry.id}
              style={slotStyle}
              isResizing={isResizing}
              sash={
                showSash && prev ? (
                  <PanelResizeSash
                    leftIndex={index - 1}
                    rightIndex={index}
                    leftProportion={prev.proportion}
                    rightProportion={entry.proportion}
                    onResize={handleSashResize}
                    onResizeStart={handleResizeStart}
                    onResizeEnd={handleResizeEnd}
                    testId={`panel-resize-sash-${index - 1}-${index}`}
                  />
                ) : null
              }
            >
              {entry.content}
            </PanelSlot>
          );
        })}
      </div>
    </div>
  );
}

interface PanelSlotProps {
  id: string;
  style: CSSProperties;
  isResizing: boolean;
  sash: ReactNode;
  children: ReactNode;
}

function PanelSlot({ id, style, isResizing, sash, children }: PanelSlotProps) {
  return (
    <>
      {sash}
      <div
        data-slot="panel-stack-slot"
        data-panel-id={id}
        className={cn(
          "relative h-full overflow-hidden",
          !isResizing && "transition-[flex-grow] duration-150 ease-out",
        )}
        style={style}
      >
        {children}
      </div>
    </>
  );
}
