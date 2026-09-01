/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Menu, type MenuItem } from "../ui/index.ts";

export type PaneMenuActionId =
  | "select-text"
  | "rename-pane"
  | "split-right"
  | "split-down"
  | "close-pane";

export interface PaneActionMenuItem {
  readonly id: PaneMenuActionId;
  readonly label: string;
  readonly shortcut: string;
}

export const PANE_ACTION_MENU_ITEMS: readonly PaneActionMenuItem[] = Object.freeze([
  Object.freeze({ id: "select-text", label: "Select text…", shortcut: "Enter" }),
  Object.freeze({ id: "rename-pane", label: "Rename pane…", shortcut: "R" }),
  Object.freeze({ id: "split-right", label: "Split pane right", shortcut: "→" }),
  Object.freeze({ id: "split-down", label: "Split pane down", shortcut: "D" }),
  Object.freeze({ id: "close-pane", label: "Close pane…", shortcut: "X" }),
]);

export interface PaneActionMenuProps {
  readonly theme: SemanticThemeSnapshot;
  readonly paneTitle: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly active?: boolean;
  readonly selectedId: PaneMenuActionId;
  readonly closeArmed: boolean;
  readonly onDismiss?: () => void;
  readonly onActionIntent: (id: PaneMenuActionId) => void;
}

function presentation(closeArmed: boolean): readonly MenuItem[] {
  return PANE_ACTION_MENU_ITEMS.map((item) => ({
    id: item.id,
    label: item.id === "close-pane" && closeArmed ? "Confirm close pane" : item.label,
    shortcut: item.shortcut,
    danger: item.id === "close-pane" && closeArmed,
  }));
}

/** Pane-scoped menu compound. Command execution remains owned by the workspace runtime. */
export function PaneActionMenu(props: PaneActionMenuProps) {
  return (
    <Menu
      theme={props.theme}
      left={props.left}
      top={props.top}
      width={props.width}
      viewportWidth={props.viewportWidth}
      viewportHeight={props.viewportHeight}
      active={props.active}
      title={props.paneTitle}
      selectedId={props.selectedId}
      items={presentation(props.closeArmed)}
      onDismiss={props.onDismiss}
      onSelect={(id) => props.onActionIntent(id as PaneMenuActionId)}
    />
  );
}
