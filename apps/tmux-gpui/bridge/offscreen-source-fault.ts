import type { Layout } from "./topology.ts";

/** Only authoritative, unambiguous membership can make a source fault local to
 * another tab. Missing/zoom-hidden/unknown membership remains a stream failure. */
export function isOffscreenSourceFault(
  layouts: readonly Layout[],
  selectedPane: string,
  faultPane: string,
): boolean {
  if (selectedPane === faultPane) return false;
  const windows = new Set<string>();
  const owners = new Map<string, string>();
  for (const layout of layouts) {
    if (!layout.semanticWindowId || windows.has(layout.semanticWindowId)) return false;
    windows.add(layout.semanticWindowId);
    for (const pane of layout.panes) {
      if (!pane.pane || owners.has(pane.pane)) return false;
      owners.set(pane.pane, layout.semanticWindowId);
    }
  }
  const selectedWindow = owners.get(selectedPane);
  const faultWindow = owners.get(faultPane);
  return !!selectedWindow && !!faultWindow && selectedWindow !== faultWindow;
}

export type SourceFaultReason = "state-too-large" | "source-closed" | "protocol-violation";

/** The selected pane is read at decision time: an in-window reselect retargets the helper. */
export function createSourceFaultFence(
  selectedPane: () => string,
  layouts: () => readonly Layout[],
) {
  const retired = new Map<string, SourceFaultReason>();
  return {
    isolate(pane: string, reason: SourceFaultReason): boolean {
      if (
        reason === "protocol-violation" ||
        !isOffscreenSourceFault(layouts(), selectedPane(), pane)
      )
        return false;
      retired.set(pane, reason);
      return true;
    },
    currentFailure(): SourceFaultReason | null {
      for (const [pane, reason] of retired) {
        if (!isOffscreenSourceFault(layouts(), selectedPane(), pane)) return reason;
      }
      return null;
    },
  };
}
