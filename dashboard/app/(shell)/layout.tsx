import { AppSidebar } from "@/components/AppSidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { EventBridge } from "@/components/EventBridge";
import { KeybindRoot } from "@/components/KeybindRoot";
import { FullScreenTerminal } from "@/components/FullScreenTerminal";
import { ShellStatusBar } from "@/components/StatusBar";
import { ToastStack } from "@/components/ToastStack";
import { WorkspaceTabsBar } from "@/components/WorkspaceTabsBar";
import { WorkspaceTabsManager } from "@/components/WorkspaceTabsManager";
import { WorkspaceUrlSync } from "@/components/WorkspaceUrlSync";
import { NavigatorSlot, SecondaryTabsSlot } from "@/components/app-shell";
import { SidebarInset } from "@/components/ui/sidebar";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col">
      <WorkspaceUrlSync />
      <EventBridge />
      <div className="flex min-h-0 flex-1">
        {/* AppSidebar — primary navigation. Shows the sessions / skills /
            settings list. Stays visible across all routes; the per-view
            contextual content (kanban filters, plan list, mission tree)
            lives in the navigator slot to its right. */}
        <AppSidebar />
        {/* Right column — workspace tabs + view tabs span the full width
            above the navigator+content row, so the project tabs and the
            in-project sub-tabs feel like a single coherent header strip
            rather than column-bound widgets. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <WorkspaceTabsBar />
          <SecondaryTabsSlot />
          <div className="flex min-h-0 min-w-0 flex-1">
            {/* Navigator column. Renders only when a view registers content
                via NavigatorPortal (KanbanBoard, MissionView, PlansView,
                SettingsView). Hidden when no portal is active so the
                sidebar stays the user's stable home. */}
            <NavigatorSlot />
            <SidebarInset>
              {/*
                Active workspace tab renders here in normal flow (single
                child). Inactive tabs are unmounted; per-view persistence
                is the view's responsibility (see WorkspaceTabsManager).
                SidebarInset is `relative`, so FullScreenTerminal's
                `absolute inset-0` overlay pins to the inset (covering the
                tab content but NOT the workspace/view tab strip above) —
                its xterm + WS state survives all workspace tab/route
                switches because the FullScreenTerminal subtree stays
                mounted in the shell layout regardless of the active tab.
              */}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <WorkspaceTabsManager>{children}</WorkspaceTabsManager>
              </div>
              <FullScreenTerminal />
            </SidebarInset>
          </div>
        </div>
      </div>
      <ShellStatusBar />
      <CommandPalette />
      <ToastStack />
      <KeybindRoot />
    </div>
  );
}
