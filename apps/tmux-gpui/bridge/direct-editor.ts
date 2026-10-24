import { z } from "zod";
import { openSelectedPaneEditor } from "./local-editor.ts";
import type { OwnerActionBinding } from "./direct-owner-actions.ts";
const scope = {
  version: z.literal(1),
  id: z.uuid(),
  request: z.number().int().nonnegative().safe(),
  operationId: z.uuid(),
};
const openSchema = z
  .object({
    ...scope,
    type: z.literal("native-editor-open"),
    sequence: z.number().int().positive().safe(),
    presenceRevision: z.number().int().nonnegative().safe(),
    pane: z.string().min(1).max(128),
    generation: z.uuid(),
    incarnation: z.string().min(1).max(256),
  })
  .strict();
const cancelSchema = z.object({ ...scope, type: z.literal("native-editor-cancel") }).strict();
type Options = Parameters<typeof openSelectedPaneEditor>[0];
export type EditorBinding = OwnerActionBinding & {
  proof: Options["proof"];
  read: Options["read"];
  current: (presenceRevision: number) => boolean;
};
export type EditorResult = {
  type: "native-editor-result";
  version: 1;
  id: string;
  request: number;
  operationId: string;
  sequence: number;
  status: "opened" | "unavailable" | "stale" | "failed" | "busy";
};
/** Native validates the displayed token and selected lifetime before issuing this
 * one-use read. Owner credentials, cwd, terminal rows and launch arguments stay here.
 */
export function createDirectEditor(
  send: (result: EditorResult) => void,
  open: typeof openSelectedPaneEditor = openSelectedPaneEditor,
) {
  let bound:
    | { binding: EditorBinding; highest: number; used: Set<string>; pending?: string }
    | undefined;
  const retire = () => {
    bound = undefined;
  };
  return {
    bind(binding: EditorBinding) {
      retire();
      bound = { binding, highest: 0, used: new Set() };
    },
    retire,
    async handle(value: unknown): Promise<void> {
      const cancel = cancelSchema.safeParse(value);
      if (cancel.success) {
        if (
          bound?.binding.id === cancel.data.id &&
          bound.binding.request === cancel.data.request &&
          bound.pending === cancel.data.operationId
        )
          bound.pending = undefined;
        return;
      }
      const parsed = openSchema.safeParse(value);
      if (!parsed.success || !bound) return;
      const cmd = parsed.data,
        owner = bound,
        b = owner.binding;
      if (
        b.catalogOnly ||
        cmd.id !== b.id ||
        cmd.request !== b.request ||
        cmd.generation !== b.config.scope.generation ||
        cmd.pane !== b.config.semanticPaneId ||
        !b.current(cmd.presenceRevision) ||
        cmd.sequence <= owner.highest ||
        owner.used.has(cmd.operationId) ||
        owner.used.size >= 128
      )
        return;
      owner.highest = cmd.sequence;
      owner.used.add(cmd.operationId);
      const result = (status: EditorResult["status"]) => ({
        type: "native-editor-result" as const,
        version: 1 as const,
        id: cmd.id,
        request: cmd.request,
        operationId: cmd.operationId,
        sequence: cmd.sequence,
        status,
      });
      if (owner.pending) {
        send(result("busy"));
        return;
      }
      owner.pending = cmd.operationId;
      const current = () =>
        bound === owner && owner.pending === cmd.operationId && b.current(cmd.presenceRevision);
      let status: EditorResult["status"];
      try {
        const message = await open({
          proof: b.proof,
          current,
          read: async (signal) => {
            if (!current()) throw new Error("Editor selection changed");
            const response = await b.read(signal);
            if (
              !current() ||
              response.server.serverId !== b.config.scope.serverId ||
              response.server.generation !== cmd.generation ||
              response.context.generation !== cmd.generation ||
              response.context.workspaceName !== b.config.workspaceName ||
              response.context.liveSessionId !== b.config.liveSessionId ||
              response.context.semanticPaneId !== cmd.pane
            )
              throw new Error("Editor context scope changed");
            return response;
          },
        });
        status =
          message === "Folder open request sent to VS Code"
            ? "opened"
            : message === "Open folder requires verified local daemon discovery"
              ? "unavailable"
              : message === "Editor selection changed — select the pane and try again"
                ? "stale"
                : "failed";
      } catch {
        status = "failed";
      }
      if (!current()) return;
      owner.pending = undefined;
      send(result(status));
    },
  };
}
