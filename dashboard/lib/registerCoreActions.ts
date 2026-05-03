"use client";

import { openCommandPalette } from "@/components/CommandPalette";
import { registerAction } from "@/lib/actions";
import { getActiveTabIdLive, type LayoutActions } from "@/lib/useLayoutState";

interface RegisterCoreActionsInput {
  currentProject: string;
  layout: Pick<
    LayoutActions,
    "toggleTerminal" | "setActivitySection" | "newTab" | "closeTab" | "openWorkspaceTab"
  >;
  toggleSidebar(): void;
  toggleTheme(): void;
}

export function registerCoreActions({
  currentProject,
  layout,
  toggleSidebar,
  toggleTheme,
}: RegisterCoreActionsInput): () => void {
  const unregister = [
    registerAction({
      id: "toggle-terminal",
      label: "Toggle terminal",
      description: "Open or close full-screen terminal mode",
      keywords: ["terminal", "panel", "shell"],
      keybind: "Mod+j",
      category: "Terminal",
      run: layout.toggleTerminal,
    }),
    registerAction({
      id: "open-palette",
      label: "Open command palette",
      description: "Search and run tmux-ide commands",
      keywords: ["command", "palette", "search"],
      keybind: "Mod+k",
      category: "General",
      run: openCommandPalette,
    }),
    registerAction({
      id: "toggle-sidebar",
      label: "Toggle sidebar",
      description: "Expand or collapse the contextual sidebar",
      keywords: ["sidebar", "navigation", "collapse"],
      keybind: "Mod+b",
      category: "View",
      run: toggleSidebar,
    }),
    registerAction({
      id: "switch-to-sessions",
      label: "Switch to sessions",
      description: "Show session navigation in the sidebar",
      keywords: ["activity", "sessions", "sidebar"],
      category: "Activity",
      run: () => layout.setActivitySection("sessions"),
    }),
    registerAction({
      id: "switch-to-settings",
      label: "Open settings",
      description: "Open the Settings workspace",
      keywords: ["activity", "settings", "sidebar"],
      category: "Activity",
      run: () => {
        layout.openWorkspaceTab("settings", null, "Settings");
        layout.setActivitySection("settings");
      },
    }),
    registerAction({
      id: "switch-to-skills",
      label: "Switch to skills",
      description: "Show project skills in the sidebar",
      keywords: ["activity", "skills", "sidebar"],
      category: "Activity",
      run: () => layout.setActivitySection("skills"),
    }),
    registerAction({
      id: "open-notifications",
      label: "Open notifications",
      description: "Show event history notifications",
      keywords: ["notifications", "events", "history"],
      keybind: "Mod+Shift+n",
      category: "View",
      run: () => {
        layout.openWorkspaceTab("notifications", null, "Notifications");
        layout.setActivitySection("sessions");
      },
    }),
    registerAction({
      id: "toggle-theme",
      label: "Toggle theme",
      description: "Switch between light and dark theme",
      keywords: ["view", "theme", "dark", "light"],
      keybind: "Mod+Shift+l",
      category: "View",
      run: toggleTheme,
    }),
    registerAction({
      id: "new-terminal-tab",
      label: "New terminal tab",
      description: "Create a terminal tab for the current project",
      keywords: ["terminal", "tab", "new"],
      keybind: "Mod+Shift+t",
      category: "Terminal",
      run: () => layout.newTab(currentProject),
    }),
    registerAction({
      id: "close-active-tab",
      label: "Close active terminal tab",
      description: "Close the active terminal tab for the current project",
      keywords: ["terminal", "tab", "close"],
      keybind: "Mod+w",
      scope: { section: "terminal" },
      category: "Terminal",
      isAvailable: () => getActiveTabIdLive(currentProject) !== null,
      run: () => {
        const activeTabId = getActiveTabIdLive(currentProject);
        if (activeTabId) layout.closeTab(activeTabId);
      },
    }),
  ];

  return () => {
    for (const cleanup of unregister) cleanup();
  };
}
