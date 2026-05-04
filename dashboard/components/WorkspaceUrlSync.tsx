"use client";

import { useEffect } from "react";
import { isSessions, useNavigation } from "@/lib/navigation";
import { useLayoutState } from "@/lib/useLayoutState";

/**
 * Auto-open a workspace tab whenever NavigationState lands on a session.
 * Workspace tabs (the persisted "recently opened" row) are still managed
 * via `useLayoutState`; NavigationState is the trigger.
 *
 * This component is no longer the source of truth for "what view is
 * active" — it just keeps the workspace tab cache in sync with the URL.
 */
export function WorkspaceUrlSync() {
  const nav = useNavigation();
  const { openWorkspaceTab } = useLayoutState();

  useEffect(() => {
    if (!isSessions(nav) || !nav.sessionName) return;
    openWorkspaceTab("project", nav.sessionName, nav.sessionName);
  }, [nav, openWorkspaceTab]);

  return null;
}
