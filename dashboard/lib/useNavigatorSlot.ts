"use client";

import type { ReactNode } from "react";

/**
 * @deprecated Compatibility shim retained while Agents 2/3 migrate the
 * feature folders that still call `<NavigatorPortal>`. The shell now
 * picks the navigator directly from `NavigationState` via
 * `<AppShell />`, so portal registrations are silently dropped.
 *
 * Removal plan: once `components/views/**` no longer imports
 * `NavigatorPortal`, delete this module + its test fixtures.
 */

/**
 * @deprecated No-op replacement for the previous portal-store hook.
 * AppShell selects the navigator from NavigationState now.
 */
export function useNavigatorSlot(): ReactNode {
  return null;
}

interface NavigatorPortalProps {
  children: ReactNode;
}

/**
 * @deprecated The shell no longer renders portal-registered navigators.
 * Call sites can keep mounting `<NavigatorPortal>{...}</NavigatorPortal>`
 * for now — children are simply not rendered. AppShell picks the
 * navigator from NavigationState instead.
 */
export function NavigatorPortal({ children: _children }: NavigatorPortalProps) {
  return null;
}

/**
 * @deprecated Test-only reset retained so existing test fixtures keep
 * compiling. The shim has no internal state, so this is a no-op.
 */
export function __resetNavigatorSlotForTests(): void {
  // intentional no-op
}
