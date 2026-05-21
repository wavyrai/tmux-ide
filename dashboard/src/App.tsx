import { onCleanup, onMount, type JSX, type ParentProps } from "solid-js";
import { ProjectQuickSwitcher } from "@/components/projects/ProjectQuickSwitcher";
import { CommandPalette, openCommandPalette } from "@/components/CommandPalette";
import { openKeyboardShortcuts, KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { registerKeybinds, useGlobalKeybindDispatcher } from "@/lib/keybinds";

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
  // Cmd+K and Cmd+/ must work on every route (Welcome, project, settings).
  // Registering them at the project route only left them dead on / and elsewhere.
  onMount(() => {
    const dispose = registerKeybinds(
      {
        id: "palette.open",
        label: "Command palette",
        group: "Global",
        scope: "global",
        combo: { key: "k" },
        altCombo: { key: "p", shift: true },
        run: () => openCommandPalette(),
      },
      {
        id: "shortcuts.open",
        label: "Show keyboard shortcuts",
        group: "Global",
        scope: "global",
        combo: { key: "/" },
        run: () => openKeyboardShortcuts(),
      },
    );
    onCleanup(dispose);
  });
  return (
    <div class="flex h-screen w-screen min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--fg)] font-sans antialiased">
      <ProjectQuickSwitcher />
      <CommandPalette />
      <KeyboardShortcuts />
      {props.children}
    </div>
  );
}
