import { ActivityBar } from "@/components/ActivityBar";
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
import { SidebarInset } from "@/components/ui/sidebar";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-1.5rem)] min-h-0 flex-col">
      <WorkspaceUrlSync />
      <EventBridge />
      <div className="flex min-h-0 flex-1">
        <ActivityBar className="hidden md:flex" testId="activity-bar-inline" />
        <AppSidebar />
        <SidebarInset>
          <WorkspaceTabsBar />
          {/*
            Active workspace tab renders here in normal flow (single child).
            Inactive tabs are unmounted; per-view persistence is the view's
            responsibility (see WorkspaceTabsManager). SidebarInset is itself
            `relative`, so FullScreenTerminal's `absolute inset-0` overlay
            pins to the inset and lifts above this tab content via z-20 —
            its xterm + WS state survives all workspace tab/route switches
            because the FullScreenTerminal subtree stays mounted in the shell
            layout regardless of the active tab.
          */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <WorkspaceTabsManager>{children}</WorkspaceTabsManager>
          </div>
          <FullScreenTerminal />
        </SidebarInset>
      </div>
      <ShellStatusBar />
      <CommandPalette />
      <ToastStack />
      <KeybindRoot />
    </div>
  );
}
