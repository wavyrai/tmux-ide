export type WorkbenchDockNavigationTabId = "files" | "changes" | "missions" | "activity";

export interface WorkbenchDockNavigationTab {
  readonly id: WorkbenchDockNavigationTabId;
  readonly disabled: boolean;
}

export interface WorkbenchDockNavigationEvent {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

/**
 * Shared automatic-activation policy for horizontal dock-tab navigation.
 *
 * Browser key names and OpenTUI key names intentionally converge here so an
 * arrow key selects the same enabled tab and emits the same host activation in
 * both renderers. Home/End follow the same automatic-activation policy on the
 * DOM host; h/l remain terminal-only aliases.
 */
export function workbenchDockNavigationTarget(
  tabs: readonly WorkbenchDockNavigationTab[],
  active: WorkbenchDockNavigationTabId,
  event: WorkbenchDockNavigationEvent,
): WorkbenchDockNavigationTabId | null {
  if (event.ctrl || event.meta || event.shift) return null;
  const enabled = tabs.filter((tab) => !tab.disabled);
  if (enabled.length === 0) return null;

  const key = event.name.toLowerCase();
  if (key === "home") return enabled[0]!.id;
  if (key === "end") return enabled[enabled.length - 1]!.id;

  const direction =
    key === "left" || key === "arrowleft" || key === "h"
      ? -1
      : key === "right" || key === "arrowright" || key === "l"
        ? 1
        : 0;
  if (direction === 0) return null;

  const currentIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === active),
  );
  for (let step = 1; step <= tabs.length; step += 1) {
    const index = (currentIndex + direction * step + tabs.length) % tabs.length;
    const candidate = tabs[index]!;
    if (!candidate.disabled) return candidate.id;
  }
  return active;
}
