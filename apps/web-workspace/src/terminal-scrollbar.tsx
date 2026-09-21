import * as stylex from "@stylexjs/stylex";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
export interface Scrollback {
  offset: number;
  rows: number;
  total: number;
}
const styles = stylex.create({
  thumb: {
    backdropFilter: "blur(12px)",
    backgroundColor: "color-mix(in srgb, var(--control-ink) 55%, transparent)",
    borderRadius: 6,
    left: 3,
    position: "absolute",
    width: 6,
  },
  track: {
    borderRadius: 8,
    bottom: 14,
    cursor: "default",
    opacity: { ":focus-visible": 1, ":hover": 1, default: 0 },
    outlineOffset: 1,
    position: "absolute",
    right: 3,
    top: 7,
    touchAction: "none",
    transition: "opacity 160ms",
    width: 12,
    zIndex: 12,
  },
  visible: { opacity: 1 },
});
export function TerminalScrollbar({
  id,
  target,
  state,
  onScroll,
}: {
  id: string;
  target: RefObject<HTMLDivElement | null>;
  state: Scrollback;
  onScroll: (offset: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(0);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const reveal = useCallback(() => {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 900);
  }, []);
  useEffect(() => {
    const element = target.current;
    element?.addEventListener("wheel", reveal, { passive: true });
    return () => {
      element?.removeEventListener("wheel", reveal);
      clearTimeout(timer.current);
    };
  }, [target, reveal]);
  const hasHistory = state.total > 0;
  useEffect(() => {
    if (!(hasHistory && track.current)) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(track.current);
    return () => observer.disconnect();
  }, [hasHistory]);
  const previousOffset = useRef(state.offset);
  useEffect(() => {
    if (previousOffset.current !== state.offset) {
      reveal();
    }
    previousOffset.current = state.offset;
  }, [state.offset, reveal]);
  if (state.total <= 0) {
    return null;
  }
  const thumbHeight = Math.min(
    height,
    Math.max(24, (height * state.rows) / (state.total + state.rows)),
  );
  const travel = Math.max(1, height - thumbHeight);
  const offset = dragOffset ?? state.offset;
  const top = (1 - Math.min(1, offset / state.total)) * travel;
  const move = (clientY: number) => {
    const trackElement = track.current;
    if (!trackElement) {
      return;
    }
    const rect = trackElement.getBoundingClientRect();
    const progress = Math.max(
      0,
      Math.min(1, (clientY - rect.top - (drag.current ?? thumbHeight / 2)) / travel),
    );
    const next = Math.round(state.total * (1 - progress));
    setDragOffset(next);
    onScroll(next);
    reveal();
  };
  return (
    <div
      ref={track}
      {...stylex.props(styles.track, (visible || dragOffset !== null) && styles.visible)}
      aria-controls={id}
      aria-label="Terminal history"
      aria-orientation="vertical"
      aria-valuemax={state.total}
      aria-valuemin={0}
      aria-valuenow={state.total - Math.min(state.total, offset)}
      onKeyDown={(e) => {
        const next =
          e.key === "Home"
            ? state.total
            : e.key === "End"
              ? 0
              : e.key === "ArrowUp"
                ? state.offset + 3
                : e.key === "ArrowDown"
                  ? state.offset - 3
                  : e.key === "PageUp"
                    ? state.offset + state.rows
                    : e.key === "PageDown"
                      ? state.offset - state.rows
                      : null;
        if (next !== null) {
          e.preventDefault();
          e.stopPropagation();
          onScroll(Math.max(0, Math.min(state.total, next)));
          reveal();
        }
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragOffset(null);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.focus();
        const rect = e.currentTarget.getBoundingClientRect();
        drag.current = e.target === e.currentTarget ? thumbHeight / 2 : e.clientY - rect.top - top;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          move(e.clientY);
        }
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        drag.current = null;
        setDragOffset(null);
        reveal();
      }}
      role="scrollbar"
      tabIndex={0}
    >
      <span {...stylex.props(styles.thumb)} style={{ height: thumbHeight, top }} />
    </div>
  );
}
