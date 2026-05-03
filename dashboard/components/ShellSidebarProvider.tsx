"use client";

import { getEffectiveKeybind, useSettings } from "@/lib/useSettings";
import { SidebarProvider } from "@/components/ui/sidebar";

export function ShellSidebarProvider({ children }: { children: React.ReactNode }) {
  const { keybinds } = useSettings();
  const keybind = keybinds["toggle-sidebar"] ?? getEffectiveKeybind("toggle-sidebar", "Mod+b");

  return (
    <SidebarProvider keyboardShortcut={keybind} className="min-h-screen flex-col">
      {children}
    </SidebarProvider>
  );
}
