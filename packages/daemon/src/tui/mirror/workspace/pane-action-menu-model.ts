/** One pane-action vocabulary for labels, accelerators and runtime dispatch. */
export type PaneMenuActionId =
  | "select-text"
  | "rename-pane"
  | "split-right"
  | "split-down"
  | "close-pane";

export const PANE_ACTION_MENU_ITEMS = Object.freeze([
  { id: "select-text", label: "Select text…", shortcut: "", key: null },
  { id: "rename-pane", label: "Rename pane…", shortcut: "R", key: "r" },
  { id: "split-right", label: "Split pane right", shortcut: "→", key: "right" },
  { id: "split-down", label: "Split pane down", shortcut: "D", key: "d" },
  { id: "close-pane", label: "Close pane…", shortcut: "X", key: "x" },
] satisfies readonly {
  id: PaneMenuActionId;
  label: string;
  shortcut: string;
  key: string | null;
}[]);

export type PaneMenuKeyHandler = (
  name: string,
  event?: {
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly eventType?: string;
    readonly repeated?: boolean;
  },
) => boolean;
