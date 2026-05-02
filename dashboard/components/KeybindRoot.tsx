"use client";

import { useEffect, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useActions } from "@/lib/actions";
import { registerCoreActions } from "@/lib/registerCoreActions";
import { registerKeybindFromAction } from "@/lib/useKeybinds";
import { useLayoutState } from "@/lib/useLayoutState";

function projectFromPath(pathname: string): string {
  const match = pathname.match(/^\/project\/([^/]+)/);
  return match ? decodeURIComponent(match[1]!) : "default";
}

export function KeybindRoot() {
  const pathname = usePathname();
  const currentProject = projectFromPath(pathname);
  const {
    toggleTerminal,
    setActivitySection,
    newTab,
    closeTab,
    getActiveTabId,
  } = useLayoutState();
  const { resolvedTheme, setTheme } = useTheme();
  const actions = useActions();

  useEffect(() => {
    return registerCoreActions({
      currentProject,
      layout: {
        toggleTerminal,
        setActivitySection,
        newTab,
        closeTab,
        getActiveTabId,
      },
      toggleTheme: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    });
  }, [
    closeTab,
    currentProject,
    getActiveTabId,
    newTab,
    resolvedTheme,
    setActivitySection,
    setTheme,
    toggleTerminal,
  ]);

  const keybindSignature = useMemo(
    () => actions.map((action) => `${action.id}:${action.keybind ?? ""}`).join("|"),
    [actions],
  );

  useEffect(() => {
    const unregister = actions.flatMap((action) => {
      if (!action.keybind) return [];
      return [registerKeybindFromAction(action)];
    });

    return () => {
      for (const cleanup of unregister) cleanup();
    };
  }, [actions, keybindSignature]);

  return null;
}
