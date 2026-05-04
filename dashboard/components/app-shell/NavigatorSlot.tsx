"use client";

import type { ReactNode } from "react";

/**
 * @deprecated NavigatorSlot is no longer used by the shell layout.
 * `AppShell` renders the navigator inline based on `NavigationState`.
 *
 * This export remains so the existing test fixture
 * (`__tests__/NavigatorSlot.test.tsx`) keeps compiling — the test only
 * verifies that the shim returns null when there's no portal node and
 * does not render anything otherwise.
 */
interface NavigatorSlotProps {
  hidden?: boolean;
  fallback?: ReactNode;
  className?: string;
}

export function NavigatorSlot(_props: NavigatorSlotProps = {}) {
  // Intentionally renders nothing. Real navigators live inside AppShell.
  return null;
}
