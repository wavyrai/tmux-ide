"use client";

import { openCommandPalette } from "@/components/CommandPalette";
import { registerAction } from "@/lib/actions";
import {
  closeTab,
  ensureDefaultTerminal,
  getNavigationStateLive,
  openTerminalTab,
} from "@/lib/navigation";
import type { LayoutActions } from "@/lib/useLayoutState";

interface RegisterCoreActionsInput {
  currentProject: string;
  layout: Pick<
    LayoutActions,
    "toggleTerminal" | "setActivitySection" | "openWorkspaceTab"
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
      description: "Open or focus the project's default terminal tab",
      keywords: ["terminal", "panel", "shell"],
      keybind: "Mod+j",
      category: "Terminal",
      run: () => {
        const sessionName = activeSessionFor(currentProject);
        if (!sessionName) return;
        ensureDefaultTerminal(sessionName);
      },
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
      description: "Create a fresh shell tab for the current project",
      keywords: ["terminal", "tab", "new", "shell"],
      keybind: "Mod+Shift+t",
      category: "Terminal",
      run: () => {
        const sessionName = activeSessionFor(currentProject);
        if (!sessionName) return;
        openTerminalTab(sessionName, { title: "shell" });
      },
    }),
    registerAction({
      id: "close-active-tab",
      label: "Close active tab",
      description: "Close the active main tab",
      keywords: ["terminal", "tab", "close"],
      keybind: "Mod+w",
      category: "View",
      isAvailable: () => getNavigationStateLive().activeTabId !== null,
      run: () => {
        const activeTabId = getNavigationStateLive().activeTabId;
        if (activeTabId) closeTab(activeTabId);
      },
    }),
  ];

  return () => {
    for (const cleanup of unregister) cleanup();
  };
}

function activeSessionFor(currentProject: string): string | null {
  const navSession = getNavigationStateLive().sessionName;
  if (navSession) return navSession;
  // Fallback to the URL-derived current project when navigation hasn't
  // been hydrated yet (e.g. CommandPalette firing on first paint).
  if (currentProject && currentProject !== "default") return currentProject;
  return null;
}

