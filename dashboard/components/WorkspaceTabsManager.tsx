"use client";

import type { ReactNode } from "react";
import { Folder } from "lucide-react";
import { usePathname } from "next/navigation";
import { NotificationsView } from "@/components/views/NotificationsView";
import { SettingsView } from "@/components/views/SettingsView";
import { SkillView } from "@/components/views/SkillView";
import { useLayoutState, type WorkspaceTab } from "@/lib/useLayoutState";

function hrefForWorkspaceTab(tab: WorkspaceTab): string {
  if (
    tab.kind === "settings" ||
    tab.kind === "notifications" ||
    tab.kind === "skill" ||
    !tab.projectName
  )
    return "/";
  return `/project/${encodeURIComponent(tab.projectName)}`;
}

interface WorkspaceTabsManagerProps {
  children?: ReactNode;
}

// Renders ONLY the active workspace tab in normal flow. Inactive tabs are
// unmounted — per-view state persistence (scroll, form state) is the view's
// responsibility via persist primitives. The `<section key={tab.id}>` causes
// React to re-mount on tab switch, which retriggers the fade-in animation.
//
// The terminal overlay (FullScreenTerminal) is a sibling of this component
// inside the shell layout; its xterm + WS state survives independently of
// workspace tab rendering.
export function WorkspaceTabsManager({ children }: WorkspaceTabsManagerProps) {
  const pathname = usePathname();
  const { workspaceTabs, activeWorkspaceTabId } = useLayoutState();

  if (workspaceTabs.length === 0) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-[var(--dim)]">
        <Folder aria-hidden="true" size={28} strokeWidth={1.5} />
        <span>select a session from the sidebar</span>
      </div>
    );
  }

  const activeTab =
    workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];

  if (!activeTab) return null;

  const routeMatches =
    activeTab.kind === "project" && pathname === hrefForWorkspaceTab(activeTab);

  return (
    <section
      key={activeTab.id}
      data-testid="workspace-tab-panel"
      data-active="true"
      data-tab-id={activeTab.id}
      className="flex min-h-0 min-w-0 flex-1 flex-col motion-safe:animate-[workspace-panel-fade_150ms_ease-out]"
    >
      {activeTab.kind === "notifications" ? (
        <NotificationsView />
      ) : activeTab.kind === "settings" ? (
        <SettingsView />
      ) : activeTab.kind === "skill" && activeTab.projectName && activeTab.ref ? (
        <SkillView sessionName={activeTab.projectName} skillName={activeTab.ref} />
      ) : routeMatches ? (
        children
      ) : (
        <div className="flex h-full flex-1 items-center justify-center text-[var(--dim)]">
          {activeTab.title}
        </div>
      )}
    </section>
  );
}
