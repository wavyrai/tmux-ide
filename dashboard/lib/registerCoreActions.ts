"use client";

import { openCommandPalette } from "@/components/CommandPalette";
import { registerAction } from "@/lib/actions";
import type { LayoutActions, LayoutQueries } from "@/lib/useLayoutState";

interface RegisterCoreActionsInput {
  currentProject: string;
  layout: Pick<
    LayoutActions & LayoutQueries,
    | "toggleTerminal"
    | "setActivitySection"
    | "newTab"
    | "closeTab"
    | "getActiveTabId"
  >;
  toggleTheme(): void;
}

export function registerCoreActions({
  currentProject,
  layout,
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
      id: "switch-to-sessions",
      label: "Switch to sessions",
      description: "Show session navigation in the sidebar",
      keywords: ["activity", "sessions", "sidebar"],
      category: "Activity",
      run: () => layout.setActivitySection("sessions"),
    }),
    registerAction({
      id: "switch-to-settings",
      label: "Switch to settings",
      description: "Show settings in the sidebar",
      keywords: ["activity", "settings", "sidebar"],
      category: "Activity",
      run: () => layout.setActivitySection("settings"),
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
      isAvailable: () => layout.getActiveTabId(currentProject) !== null,
      run: () => {
        const activeTabId = layout.getActiveTabId(currentProject);
        if (activeTabId) layout.closeTab(activeTabId);
      },
    }),
  ];

  return () => {
    for (const cleanup of unregister) cleanup();
  };
}
