import type { WorkbenchDockTabId } from "../workspace/workbench-shell.ts";

/**
 * M59 product freeze.
 *
 * Home and Terminals are the only surfaces admitted by the default OpenTUI
 * product. The remaining source stays available for later, explicit cutovers,
 * but it must not enter navigation, bootstrap, terminal input, or reconnect.
 */
export const DEFAULT_PRODUCT_CANVAS_PANELS = ["home", "terminals"] as const;

export const QUARANTINED_PRODUCT_SURFACES = ["files", "changes", "missions", "activity"] as const;

export function isDefaultProductDockTool(_tabId: WorkbenchDockTabId): _tabId is never {
  return false;
}
