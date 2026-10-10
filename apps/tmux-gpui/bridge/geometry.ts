import { z } from "zod";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";

export const resizeSchema = z
  .object({
    kind: z.literal("resize"),
    data: z
      .object({
        cols: z.number().int().min(2).max(1000),
        rows: z.number().int().min(2).max(500),
      })
      .strict(),
  })
  .strict();

/** Never resize an implicit active window or assume a queued request was applied. */
export async function resizeWindow(
  runtime: Pick<
    PaneStreamRuntimeClient,
    "ownsConnectionAuthority" | "requestAuthority" | "fitViewport"
  >,
  currentWindow: () => string | null,
  value: unknown,
): Promise<boolean> {
  const { cols, rows } = resizeSchema.parse(value).data;
  const window = currentWindow();
  if (!window) return false;
  if (!runtime.ownsConnectionAuthority("geometry")) {
    if (!(await runtime.requestAuthority("geometry"))) return false;
  }
  if (!runtime.ownsConnectionAuthority("geometry") || currentWindow() !== window) return false;
  return (await runtime.fitViewport(cols, rows, window)) === "ok";
}

/** Invalidate the former owner before accepting geometry for a moved pane. */
export function windowForLayout(
  current: string | null,
  paneId: string,
  layout: { semanticWindowId: string | null; panes: readonly { pane: string | null }[] },
): string | null {
  if (layout.panes.some((pane) => pane.pane === paneId)) return layout.semanticWindowId;
  return layout.semanticWindowId === current ? null : current;
}
