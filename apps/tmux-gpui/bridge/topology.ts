import { z } from "zod";
import { PaneStreamLayoutFrameSchemaZ } from "../../../packages/contracts/src/pane-stream.ts";
export const topologySchema = z.array(PaneStreamLayoutFrameSchemaZ).max(256);
export type Layout = z.infer<typeof PaneStreamLayoutFrameSchemaZ>;
const label = (value: string | null | undefined, fallback: string) => {
  const clean = value?.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() || fallback;
  let result = "";
  let bytes = 0;
  for (const character of clean) {
    const length = Buffer.byteLength(character);
    if (bytes + length > 512) break;
    result += character;
    bytes += length;
  }
  return result;
};

export function paneChoices(ids: readonly string[], layouts: readonly Layout[]) {
  const remaining = new Set(ids);
  const choices: { id: string; label: string; windowId?: string; windowLabel?: string }[] = [];
  for (const window of layouts) {
    if (!window.semanticWindowId) continue;
    for (const pane of window.panes) {
      if (!pane.pane || !remaining.delete(pane.pane)) continue;
      choices.push({
        id: pane.pane,
        label: label(pane.displayName, pane.pane),
        windowId: window.semanticWindowId,
        windowLabel: label(window.windowName, "Window"),
      });
    }
  }
  for (const id of remaining) choices.push({ id, label: id });
  return choices;
}

// Advisory initial navigation only: never invent an active window or pane.
export function preferredPane(ids: readonly string[], layouts: readonly Layout[]): string | null {
  const current = layouts.filter((window) => window.currentWindow);
  if (current.length !== 1 || !current[0].semanticWindowId) return null;
  const active = current[0].panes.filter((pane) => pane.active);
  if (active.length !== 1 || !active[0].pane || !ids.includes(active[0].pane)) return null;
  const id = active[0].pane;
  return layouts.flatMap((window) => window.panes).filter((pane) => pane.pane === id).length === 1
    ? id
    : null;
}
