import { applicationCommandDescription } from "./application-command-description.ts";

export interface ApplicationShortcut {
  category: string;
  label: string;
  keys: string;
}

/** Display metadata only. Context-specific keyboard owners remain authoritative. */
export const APPLICATION_SHORTCUTS: readonly ApplicationShortcut[] = [
  ...(["home", "terminals", "switch-session"] as const).map((command) => {
    const description = applicationCommandDescription(command);
    return { category: "Application", label: description.label, keys: description.shortcut! };
  }),
  { category: "Application", label: "Commands", keys: "F5" },
  { category: "Application", label: "Show / hide sidebar", keys: "F10" },
  { category: "Application", label: "Agent attention", keys: "F7" },
  { category: "Application", label: "Sidebar / Sessions when hidden", keys: "Ctrl+G" },
  { category: "Terminals", label: "Open link", keys: "Shift+click" },
  { category: "Terminals", label: "Select and copy text", keys: "Shift+drag" },
  { category: "Home", label: "Find an agent or workspace", keys: "/" },
  { category: "Home", label: "Cycle machine filter", keys: "f" },
  { category: "Home", label: "Toggle attention filter", keys: "a" },
  { category: "Home", label: "Open selected agent", keys: "Enter" },
  { category: "Command and session menus", label: "Search actions or sessions", keys: "Type" },
  { category: "Command and session menus", label: "Choose a result", keys: "↑ / ↓" },
  { category: "Command and session menus", label: "Activate selected result", keys: "Enter" },
  { category: "Command and session menus", label: "Search / navigation mode", keys: "Ctrl+Space" },
  { category: "Menu navigation mode", label: "Move selection", keys: "j / k" },
  { category: "Menu navigation mode", label: "First / last result", keys: "g / G" },
  { category: "Menu navigation mode", label: "Return to search", keys: "i" },
  {
    category: "Command and session menus",
    label: "Previous / next page",
    keys: "PageUp / PageDown",
  },
  {
    category: "Command and session menus",
    label: "Previous / next half page",
    keys: "Ctrl+U / Ctrl+D",
  },
  { category: "Sessions", label: "Local / all hosts", keys: "Ctrl+H" },
  { category: "Sessions", label: "Favorite session", keys: "Ctrl+F" },
  { category: "Sessions", label: "Browse windows without activating", keys: "Ctrl+← / Ctrl+→" },
  { category: "Sessions", label: "Show / hide preview", keys: "Ctrl+P" },
  { category: "Sessions", label: "Expand / restore preview", keys: "Ctrl+E" },
  { category: "Sessions", label: "New session", keys: "Ctrl+N" },
  { category: "Sessions", label: "Confirm close session", keys: "Ctrl+X" },
  { category: "Sessions", label: "Retry selected host", keys: "Ctrl+R" },
  ...(["shortcuts", "whats-new"] as const).map((command) => {
    const description = applicationCommandDescription(command);
    return { category: "Help in menus", label: description.label, keys: description.shortcut! };
  }),
  { category: "Help in menus", label: "Back / dismiss", keys: "Esc" },
];
