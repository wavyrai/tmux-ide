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
        <ActivityBar testId="activity-bar-inline" />
        <AppSidebar />
        <SidebarInset>
          <WorkspaceTabsBar />
          <div className="relative min-h-0 flex-1">
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
