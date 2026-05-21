import type { JSX, ParentProps } from "solid-js";
import { ProjectQuickSwitcher } from "@/components/projects/ProjectQuickSwitcher";
import { CommandPalette } from "@/components/CommandPalette";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { useGlobalKeybindDispatcher } from "@/lib/keybinds";

/**
 * Root shell for the Solid dashboard.
 *
 * Mounts the always-on chrome:
 *   - `ProjectQuickSwitcher`  — the project-scoped Cmd+P palette.
 *   - `CommandPalette`        — the unified Cmd+K palette (G16-P4).
 *   - `KeyboardShortcuts`     — the Cmd+/ cheat-sheet overlay.
 *   - `useGlobalKeybindDispatcher` — single window.keydown listener
 *     that fires every `scope: "global"` binding in the registry.
 *     Surface components (the chrome.ts toggles, ProjectQuickSwitcher,
 *     the project route's view jumps, …) register through that
 *     registry so a binding lives in exactly one place.
 */
export function App(props: ParentProps): JSX.Element {
  useGlobalKeybindDispatcher();
  return (
    <div class="flex h-screen w-screen min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--fg)] font-sans antialiased">
      <ProjectQuickSwitcher />
      <CommandPalette />
      <KeyboardShortcuts />
      {props.children}
    </div>
  );
}
