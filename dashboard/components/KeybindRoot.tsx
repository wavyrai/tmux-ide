"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useActions } from "@/lib/actions";
import { registerCoreActions } from "@/lib/registerCoreActions";
import { registerKeybindFromAction } from "@/lib/useKeybinds";
import { useLayoutState } from "@/lib/useLayoutState";
import { useSettings } from "@/lib/useSettings";
import { useSidebar } from "@/components/ui/sidebar";

function projectFromPath(pathname: string): string {
  const match = pathname.match(/^\/project\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : "default";
}

export function KeybindRoot() {
  const pathname = usePathname();
  const currentProject = projectFromPath(pathname);
  const { toggleTerminal, setActivitySection, newTab, closeTab, openWorkspaceTab } =
    useLayoutState();
  const { setTheme } = useTheme();
  const { themeId, setThemeId, keybinds } = useSettings();
  const actions = useActions();
  const { toggleSidebar } = useSidebar();

  useEffect(() => {
    return registerCoreActions({
      currentProject,
      layout: { toggleTerminal, setActivitySection, newTab, closeTab, openWorkspaceTab },
      toggleSidebar,
      toggleTheme: () => {
        const nextTheme = themeId === "light" ? "dark" : "light";
        setThemeId(nextTheme);
        setTheme(nextTheme);
      },
    });
  }, [
    closeTab,
    currentProject,
    newTab,
    openWorkspaceTab,
    setActivitySection,
    setTheme,
    setThemeId,
    themeId,
    toggleSidebar,
    toggleTerminal,
  ]);

  const keybindSignature = useMemo(
    () =>
      actions
        .map((action) => `${action.id}:${keybinds[action.id] ?? action.keybind ?? ""}`)
        .join("|"),
    [actions, keybinds],
  );

  useEffect(() => {
    const unregister = actions.flatMap((action) => {
      if (!action.keybind) return [];
      if (action.id === "toggle-sidebar") return [];
      return [registerKeybindFromAction(action)];
    });

    return () => {
      for (const cleanup of unregister) cleanup();
    };
  }, [actions, keybindSignature]);

  return null;
}
