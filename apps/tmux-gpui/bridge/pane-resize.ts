import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import {
  WorkspacePaneResizeResultSchemaZ,
  type WorkspacePaneResizeResult,
} from "../../../packages/contracts/src/workspace-multiplexer.ts";
import type { Layout } from "./topology.ts";

export const paneResizeSchema = z
  .object({
    type: z.literal("resize-pane"),
    request: z.number().int().positive().safe(),
    id: z.string().min(1).max(512),
    token: z.string().uuid(),
    axis: z.enum(["cols", "rows"]),
    cells: z.number().int().min(2).max(1000),
  })
  .strict()
  .refine((v) => v.axis !== "rows" || v.cells <= 500);
export type PaneResize = z.infer<typeof paneResizeSchema>;
type Region = { id: string; left: number; top: number; width: number; height: number };

/** Cached pre-resize canvas must never grant a gesture against newer topology. */
export function resizePresentationMatches(layout: Layout | undefined, regions: readonly Region[]) {
  return (
    !!layout?.semanticWindowId &&
    !layout.zoomed &&
    layout.panes.length >= 2 &&
    layout.panes.length === regions.length &&
    layout.panes.every((pane) => {
      const region = regions.find((r) => r.id === pane.pane);
      return (
        !!region &&
        region.left === pane.left &&
        region.top === pane.top &&
        region.width === pane.width &&
        region.height === pane.height
      );
    })
  );
}

/** Content revisions do not participate: output during a drag is not a topology change. */
export function createPaneResizeFence() {
  let signature: string | null = null;
  let token: string | null = null;
  return (layout: Layout | undefined, epoch: number): string | null => {
    const next =
      layout?.semanticWindowId && !layout.zoomed && layout.panes.length >= 2
        ? JSON.stringify([
            epoch,
            layout.semanticWindowId,
            layout.cols,
            layout.rows,
            layout.paneBorderStatus,
            layout.panes.map((p) => [p.pane, p.left, p.top, p.width, p.height]),
          ])
        : null;
    if (next !== signature) {
      signature = next;
      token = next === null ? null : randomUUID();
    }
    return token;
  };
}
export type ResizeTarget = Readonly<{
  token: string;
  generation: string;
  workspace: string;
  window: string;
  lifetime: string;
  statusRows: number;
}>;

/** Validated tmux readback, not proof that a matching layout/frame has arrived. */
export type PaneResizeReceipt = Readonly<WorkspacePaneResizeResult>;

/** Existing pane-stream semantic action; no raw tmux invocation or retry. */
export async function resizePane(
  runtime: Pick<
    PaneStreamRuntimeClient,
    "ownsConnectionAuthority" | "requestAuthority" | "submitIntent"
  >,
  current: () => ResizeTarget | null,
  command: PaneResize,
  suppliedOperationId?: string,
): Promise<PaneResizeReceipt | null> {
  const operationId = z
    .string()
    .uuid()
    .parse(suppliedOperationId ?? randomUUID());
  const input = paneResizeSchema.parse(command);
  const expected = current();
  if (!expected || expected.token !== input.token) return null;
  const same = (geometry: boolean) => {
    const now = current();
    return (
      !!now &&
      (!geometry || now.token === expected.token) &&
      now.generation === expected.generation &&
      now.workspace === expected.workspace &&
      now.window === expected.window &&
      now.lifetime === expected.lifetime
    );
  };
  if (!runtime.ownsConnectionAuthority("geometry") && !(await runtime.requestAuthority("geometry")))
    return null;
  if (!same(true) || !runtime.ownsConnectionAuthority("geometry")) return null;
  const result = WorkspacePaneResizeResultSchemaZ.safeParse(
    await runtime.submitIntent(operationId, {
      verb: "workspace.pane.resize",
      workspaceName: expected.workspace,
      semanticPaneId: input.id,
      axis: input.axis,
      cells: input.cells - (input.axis === "rows" ? expected.statusRows : 0),
    }),
  );
  // Geometry is expected to change after dispatch; pane/window/lifetime must not.
  if (
    !(
      same(false) &&
      result.success &&
      result.data.operationId === operationId &&
      result.data.daemonInstanceId === expected.generation &&
      result.data.workspaceName === expected.workspace &&
      result.data.semanticPaneId === input.id &&
      result.data.axis === input.axis &&
      ["applied", "unchanged"].includes(result.data.outcome)
    )
  )
    return null;
  return Object.freeze(result.data);
}
