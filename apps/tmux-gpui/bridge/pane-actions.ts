import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PaneStreamRuntimeClient } from "../../../packages/daemon-client/src/pane-stream-client.ts";
import {
  WorkspaceMultiplexerNameSchemaZ,
  WorkspaceRenameResultSchemaZ,
  WorkspacePaneZoomToggleResultSchemaZ,
} from "../../../packages/contracts/src/workspace-multiplexer.ts";
import type { Layout } from "./topology.ts";
const base = {
  type: z.literal("pane-action"),
  request: z.number().int().positive().safe(),
  id: z.string().min(1).max(512),
  token: z.string().uuid(),
};
export const paneActionSchema = z.discriminatedUnion("action", [
  z
    .object({ ...base, action: z.literal("rename"), name: WorkspaceMultiplexerNameSchemaZ })
    .strict(),
  z
    .object({ ...base, action: z.literal("zoom"), desired: z.enum(["zoomed", "unzoomed"]) })
    .strict(),
]);
export type PaneAction = z.infer<typeof paneActionSchema>;
export const paneActionsSchema = z
  .object({ token: z.string().uuid(), id: z.string().min(1).max(512), zoomed: z.boolean() })
  .strict();
export function createPaneActionFence() {
  let signature: string | null = null;
  let token: string | null = null;
  return {
    invalidate() {
      signature = null;
      token = null;
    },
    current(layout: Layout | undefined, pane: string, lifetime: string | null | undefined) {
      const selected = layout?.panes.find((p) => p.pane === pane);
      const next =
        selected && layout?.semanticWindowId && lifetime
          ? JSON.stringify([
              lifetime,
              layout.semanticWindowId,
              layout.cols,
              layout.rows,
              layout.zoomed,
              layout.paneBorderStatus,
              layout.panes.map((p) => [p.pane, p.left, p.top, p.width, p.height]),
              selected.displayName,
            ])
          : null;
      if (next !== signature) {
        signature = next;
        token = next === null ? null : randomUUID();
      }
      return token ? { token, id: pane, zoomed: layout!.zoomed } : null;
    },
  };
}
export type PaneActionTarget = Readonly<{
  token: string;
  id: string;
  generation: string;
  workspace: string;
  window: string;
  lifetime: string;
}>;
/** One helper lifetime. Consume before any async dispatch, never retry an uncertain result. */
export function createPaneActionExecutor() {
  let consumed: string | null = null;
  return async (
    runtime: Pick<
      PaneStreamRuntimeClient,
      "ownsConnectionAuthority" | "requestAuthority" | "submitIntent"
    >,
    current: () => PaneActionTarget | null,
    command: PaneAction,
  ): Promise<boolean> => {
    const input = paneActionSchema.parse(command);
    const expected = current();
    if (
      !expected ||
      expected.id !== input.id ||
      expected.token !== input.token ||
      consumed === input.token ||
      !runtime.ownsConnectionAuthority("input")
    )
      return false;
    consumed = input.token;
    const same = (includeToken: boolean) => {
      const now = current();
      return (
        !!now &&
        now.id === expected.id &&
        (!includeToken || now.token === expected.token) &&
        now.generation === expected.generation &&
        now.workspace === expected.workspace &&
        now.window === expected.window &&
        now.lifetime === expected.lifetime
      );
    };
    if (
      input.action === "zoom" &&
      !runtime.ownsConnectionAuthority("geometry") &&
      !(await runtime.requestAuthority("geometry"))
    )
      return false;
    if (
      !same(true) ||
      !runtime.ownsConnectionAuthority("input") ||
      (input.action === "zoom" && !runtime.ownsConnectionAuthority("geometry"))
    )
      return false;
    const operationId = randomUUID();
    const raw = await runtime.submitIntent(
      operationId,
      input.action === "rename"
        ? {
            verb: "workspace.rename",
            workspaceName: expected.workspace,
            scope: "pane",
            semanticPaneId: input.id,
            name: input.name,
          }
        : {
            verb: "workspace.pane.zoom.toggle",
            workspaceName: expected.workspace,
            semanticPaneId: input.id,
            desired: input.desired,
          },
    );
    const parsed =
      input.action === "rename"
        ? WorkspaceRenameResultSchemaZ.safeParse(raw)
        : WorkspacePaneZoomToggleResultSchemaZ.safeParse(raw);
    if (!same(false) || !parsed.success) return false;
    const result = parsed.data;
    return (
      result.operationId === operationId &&
      result.daemonInstanceId === expected.generation &&
      result.workspaceName === expected.workspace &&
      ["applied", "unchanged"].includes(result.outcome) &&
      (input.action === "rename"
        ? result.verb === "workspace.rename" &&
          result.scope === "pane" &&
          result.name === input.name
        : result.verb === "workspace.pane.zoom.toggle" &&
          result.semanticPaneId === input.id &&
          result.zoomed === (input.desired === "zoomed"))
    );
  };
}
