import { WindowLinkTargetSchemaZ } from "../../../packages/contracts/src/window-links.ts";
import { z } from "zod";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import { DesktopWorkspaceNameSchemaZ } from "../../../packages/contracts/src/desktop-workspace-name.ts";
import {
  WindowSplitLayoutResourceSchemaZ,
  WindowSplitResizeTargetSchemaZ,
} from "../../../packages/contracts/src/window-split-layout.ts";
import {
  WorkspaceWindowSplitResizeResultSchemaZ,
  type WorkspaceWindowSplitResizeResult,
} from "../../../packages/contracts/src/workspace-multiplexer.ts";

const snapshotSchema = z
  .object({
    generation: z.uuid(),
    workspace: DesktopWorkspaceNameSchemaZ,
    lifetime: z.string().min(1).max(512),
    window: WindowLinkTargetSchemaZ,
    resource: WindowSplitLayoutResourceSchemaZ.nullable(),
  })
  .strict();
export type SplitResizeSnapshot = z.infer<typeof snapshotSchema>;
export const splitResizeCommandSchema = z
  .object({
    target: WindowSplitResizeTargetSchemaZ,
    axis: z.enum(["cols", "rows"]),
  })
  .strict();
export type SplitResizeCommand = z.infer<typeof splitResizeCommandSchema>;

/** One semantic submission. A receipt is not proof that its new frame has arrived. */
export async function resizeSplit(
  runtime: Pick<
    PaneStreamRuntimeClient,
    "ownsConnectionAuthority" | "requestAuthority" | "submitIntent"
  >,
  current: () => SplitResizeSnapshot | null,
  command: SplitResizeCommand,
  suppliedOperationId: string,
): Promise<Readonly<WorkspaceWindowSplitResizeResult> | null> {
  try {
    // Schema parsing detaches nested data before any asynchronous boundary.
    const input = splitResizeCommandSchema.parse(command);
    const operationId = z.uuid().parse(suppliedOperationId);
    const expected = snapshotSchema.parse(current());
    const sameWindow = (snapshot: SplitResizeSnapshot) =>
      JSON.stringify(snapshot.window) === JSON.stringify(input.target.window);
    const targetCurrent = (snapshot: SplitResizeSnapshot) =>
      sameWindow(snapshot) &&
      snapshot.resource !== null &&
      JSON.stringify(snapshot.resource.window) === JSON.stringify(snapshot.window) &&
      snapshot.resource.layoutId === input.target.layoutId &&
      snapshot.resource.splits.some(
        (split) => split.splitId === input.target.splitId && split.axis === input.axis,
      );
    const same = (geometry: boolean) => {
      const now = snapshotSchema.safeParse(current());
      return (
        now.success &&
        now.data.generation === expected.generation &&
        now.data.workspace === expected.workspace &&
        now.data.lifetime === expected.lifetime &&
        sameWindow(now.data) &&
        (!geometry || targetCurrent(now.data))
      );
    };
    if (!targetCurrent(expected)) return null;
    if (
      !runtime.ownsConnectionAuthority("geometry") &&
      !(await runtime.requestAuthority("geometry"))
    )
      return null;
    if (!same(true) || !runtime.ownsConnectionAuthority("geometry")) return null;
    const result = WorkspaceWindowSplitResizeResultSchemaZ.safeParse(
      await runtime.submitIntent(operationId, {
        verb: "workspace.window.split.resize",
        workspaceName: expected.workspace,
        target: input.target,
      }),
    );
    // Layout handles may retire as geometry settles; scope, lifetime and window cannot change.
    // A historical receipt does not renew geometry authority.
    if (
      !same(false) ||
      !result.success ||
      result.data.operationId !== operationId ||
      result.data.daemonInstanceId !== expected.generation ||
      result.data.workspaceName !== expected.workspace ||
      result.data.axis !== input.axis ||
      JSON.stringify(result.data.target) !== JSON.stringify(input.target) ||
      !["applied", "unchanged", "replayed"].includes(result.data.outcome)
    )
      return null;
    return Object.freeze(result.data);
  } catch {
    // Authority/transport/schema failures are terminal for this attempt. Never replay.
    return null;
  }
}
