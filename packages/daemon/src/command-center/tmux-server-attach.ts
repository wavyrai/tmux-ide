import { z } from "zod";

/**
 * One request that opens a session, reads its inventory and issues its stream
 * (attach-rtt). Before it the app sent three: open, inventory, issue. The app
 * still checks the answer: it applies its own window rule to the returned
 * inventory and uses the issued stream only when the daemon chose the same.
 *
 * `issue` is the body of an ordinary pane-stream issue request without the
 * workspace name, the panes and the window, which only the daemon knows here.
 */
export const TmuxServerAttachRequestSchemaZ = z
  .object({
    version: z.literal(1),
    preferredPane: z.string().min(1).max(128).nullable(),
    maxPanes: z.number().int().min(1).max(256),
    issue: z
      .object({
        expectedDaemonInstanceId: z.uuid(),
        stream: z.record(z.string(), z.unknown()),
      })
      .catchall(z.unknown()),
  })
  .strict();
export type TmuxServerAttachRequest = z.infer<typeof TmuxServerAttachRequestSchemaZ>;

export interface AttachInventory {
  readonly semanticPaneIds: readonly string[];
  readonly windows: readonly {
    readonly semanticWindowId: string;
    readonly active: boolean;
    readonly semanticPaneIds: readonly string[];
  }[];
}

export interface AttachSelection {
  /** The one window the stream carries, or null for the whole session. */
  readonly semanticWindowId: string | null;
  readonly panes: readonly string[];
  readonly selectedPane: string;
}

/**
 * The app's rule (browser_native_local_window.rs `scope`), here so the open
 * and the issue can be one request: a session that fits streams whole;
 * otherwise the window holding the preferred pane (else the active one) when
 * it fits, else the active one, else the first in tmux order that fits. No
 * selection when there is no pane or nothing fits: the app decides then.
 */
export function chooseAttachSelection(
  inventory: AttachInventory,
  preferredPane: string | null,
  maxPanes: number,
): AttachSelection | null {
  const panes = inventory.semanticPaneIds;
  if (panes.length === 0) return null;
  let semanticWindowId: string | null = null;
  let chosen = panes;
  if (panes.length > maxPanes) {
    const fits = (window: AttachInventory["windows"][number] | undefined) =>
      window !== undefined && window.semanticPaneIds.length <= maxPanes;
    const active = inventory.windows.find((window) => window.active);
    const wanted =
      (preferredPane !== null
        ? inventory.windows.find((window) => window.semanticPaneIds.includes(preferredPane))
        : undefined) ?? active;
    const window = [wanted, active].find(fits) ?? inventory.windows.find(fits);
    if (!window) return null;
    semanticWindowId = window.semanticWindowId;
    chosen = window.semanticPaneIds;
  }
  const selectedPane =
    preferredPane !== null && chosen.includes(preferredPane) ? preferredPane : chosen[0]!;
  return { semanticWindowId, panes: chosen, selectedPane };
}
