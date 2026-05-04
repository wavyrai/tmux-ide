"use client";

import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { NAVIGATOR_WIDTH, PANEL_SPRING } from "@/lib/panel-constants";
import { useNavigatorSlot } from "@/lib/useNavigatorSlot";

function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return narrow;
}

interface NavigatorSlotProps {
  /**
   * Mobile breakpoint check — when hidden, the slot collapses to nothing.
   * The shell layout passes `hidden md:block` styling around the slot to
   * collapse it on small screens; explicit `hidden=true` is reserved for
   * keyboard-driven collapse.
   */
  hidden?: boolean;
  /**
   * Fallback subtree rendered when no view has registered a navigator via
   * NavigatorPortal. With this set, the navigator column is permanently
   * present on desktop.
   */
  fallback?: ReactNode;
  className?: string;
}

/**
 * Renders the active navigator (registered via <NavigatorPortal>) in a
 * fixed-width column. Falls back to `fallback` when no portal has
 * registered. Animates collapse with a motion spring so opening/closing
 * the navigator stays fluid.
 */
export function NavigatorSlot({ hidden, fallback, className }: NavigatorSlotProps) {
  const node = useNavigatorSlot();
  const isNarrow = useIsNarrow();
  const content = node ?? fallback ?? null;

  if (!content || hidden || isNarrow) return null;

  return (
    <motion.div
      data-testid="navigator-slot"
      data-slot="panel"
      className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r border-[var(--border-weak)] bg-[var(--bg)] ${className ?? ""}`}
      initial={false}
      animate={{ width: NAVIGATOR_WIDTH }}
      transition={PANEL_SPRING}
      style={{ width: NAVIGATOR_WIDTH }}
    >
      {content}
    </motion.div>
  );
}
