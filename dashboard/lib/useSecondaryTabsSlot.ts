"use client";

import type { ReactNode } from "react";

/**
 * @deprecated Compatibility shim retained while Agents 2/3 migrate the
 * feature folders that still call `<SecondaryTabsPortal>`. AppShell
 * now renders project view tabs from NavigationState directly, so any
 * portal registrations here are dropped.
 *
 * Removal plan: once `components/views/**` no longer imports
 * `SecondaryTabsPortal`, delete this module.
 */

/** @deprecated No-op replacement for the previous portal-store hook. */
export function useSecondaryTabsSlot(): ReactNode {
  return null;
}

/**
 * @deprecated The shell no longer renders portal-registered secondary
 * tabs. Call sites can keep mounting `<SecondaryTabsPortal>{...}</...>`
 * for now — children are simply not rendered.
 */
export function SecondaryTabsPortal({ children: _children }: { children: ReactNode }) {
  return null;
}
