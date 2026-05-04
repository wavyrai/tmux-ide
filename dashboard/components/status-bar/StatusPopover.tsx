"use client";

import { Popover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";

interface StatusPopoverProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /**
   * The trigger element. Wired through Base UI's `render=` so the
   * popup anchors to it and the popover state controls its data-state.
   * Pass a single JSX element (typically a button).
   */
  trigger: ReactElement;
}

/**
 * Status-bar popovers (agents/skills/missions/milestones).
 *
 * Built on Base UI's Popover so it portals to document.body, escapes the
 * status-bar's overflow:hidden parent, gets a high z-index by default,
 * and exposes proper aria + outside-click + escape behavior. Mirrors the
 * project switcher's popover style for consistency.
 */
export function StatusPopover({ open, onClose, children, trigger }: StatusPopoverProps) {
  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} side="top" align="start" className="z-[80]">
          <Popover.Popup
            data-testid="status-popover"
            className="z-[80] max-h-72 min-w-64 max-w-[min(28rem,calc(100vw-2rem))] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-strong)] p-2 text-[11px] text-[var(--fg)] shadow-2xl outline-none transition-[transform,opacity] duration-150 ease-smooth data-closed:opacity-0 data-open:opacity-100 motion-reduce:transition-none"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
