import { createRenderEffect, createSignal } from "solid-js";
import {
  PANE_ACTION_MENU_ITEMS,
  type PaneMenuActionId,
  type PaneMenuKeyHandler,
} from "../workspace/pane-action-menu-model.ts";

export interface ApplicationPaneMenuState {
  readonly paneId: string;
  readonly displayName: string;
  readonly left: number;
  readonly top: number;
  readonly selectedId: PaneMenuActionId;
  readonly closeArmed: boolean;
  readonly rendererEpoch: number;
}

/** Local overlay state only. The root still owns physical keyboard/paste ingress,
 * and the workspace supplies exact targets and executes admitted actions. */
export function createApplicationPaneMenuOwner(options: {
  readonly rendererEpoch: () => number;
  readonly paneVisible: (paneId: string) => boolean;
  readonly onAction: (paneId: string, action: PaneMenuActionId, displayName: string) => void;
}) {
  const [stored, setStored] = createSignal<ApplicationPaneMenuState | null>(null);
  const state = () => {
    const menu = stored();
    return menu &&
      menu.rendererEpoch === options.rendererEpoch() &&
      options.paneVisible(menu.paneId)
      ? menu
      : null;
  };
  createRenderEffect(() => {
    if (stored() && !state()) setStored(null);
  });
  const dismiss = () => setStored(null);
  const highlight = (selectedId: PaneMenuActionId) => {
    const menu = state();
    if (menu && menu.selectedId !== selectedId)
      setStored({ ...menu, selectedId, closeArmed: false });
  };
  const activate = (id: PaneMenuActionId) => {
    const menu = state();
    if (!menu) return;
    if (id === "close-pane" && !menu.closeArmed) {
      setStored({ ...menu, selectedId: id, closeArmed: true });
      return;
    }
    dismiss();
    options.onAction(menu.paneId, id, menu.displayName);
  };
  const handleKey: PaneMenuKeyHandler = (name, event) => {
    const menu = state();
    if (!menu) return false;
    // A menu owns all input, but modified/released/repeated keys must never
    // accidentally trigger an accelerator or complete a destructive action.
    if (
      event?.ctrl ||
      event?.meta ||
      (event?.eventType && event.eventType !== "press") ||
      event?.repeated
    )
      return true;
    const index = PANE_ACTION_MENU_ITEMS.findIndex((item) => item.id === menu.selectedId);
    if (name === "escape") dismiss();
    else if (name === "up" || name === "k" || name === "down" || name === "j") {
      const delta = name === "up" || name === "k" ? -1 : 1;
      const next = (index + delta + PANE_ACTION_MENU_ITEMS.length) % PANE_ACTION_MENU_ITEMS.length;
      highlight(PANE_ACTION_MENU_ITEMS[next]!.id);
    } else if (name === "enter" || name === "return") activate(menu.selectedId);
    else {
      const item = PANE_ACTION_MENU_ITEMS.find((item) => item.key === name);
      if (item) activate(item.id);
    }
    return true;
  };
  return {
    state,
    dismiss,
    highlight,
    activate,
    handleKey,
    ownsInput: () => state() !== null,
    open(input: Omit<ApplicationPaneMenuState, "rendererEpoch" | "closeArmed" | "selectedId">) {
      if (!options.paneVisible(input.paneId)) return;
      setStored({
        ...input,
        selectedId: "select-text",
        closeArmed: false,
        rendererEpoch: options.rendererEpoch(),
      });
    },
  };
}
