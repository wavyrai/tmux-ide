/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { Menu, type MenuItem } from "../ui/index.ts";
export { PANE_ACTION_MENU_ITEMS, type PaneMenuActionId } from "./pane-action-menu-model.ts";
import { PANE_ACTION_MENU_ITEMS, type PaneMenuActionId } from "./pane-action-menu-model.ts";

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
  readonly onHighlight?: (id: PaneMenuActionId) => void;
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
      footer={
        props.closeArmed ? "X / Enter confirm · Esc cancel" : "↑↓ choose · Enter run · Esc back"
      }
      selectedId={props.selectedId}
      items={presentation(props.closeArmed)}
      onDismiss={props.onDismiss}
      onHighlight={(id) => props.onHighlight?.(id as PaneMenuActionId)}
      onSelect={(id) => props.onActionIntent(id as PaneMenuActionId)}
    />
  );
}
