import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WorkspaceSessionCreateArgumentsSchemaZ } from "../../../packages/contracts/src/fleet-lifecycle.ts";

export const sessionCreateSchema = z
  .object({
    type: z.literal("create-session"),
    request: z.number().int().nonnegative().safe(),
    name: WorkspaceSessionCreateArgumentsSchemaZ.shape.displayName,
  })
  .strict();
type State = Readonly<{
  phase: "idle" | "pending" | "failed";
  error: string | null;
  revision: number;
}>;
const idle = (revision: number): State => Object.freeze({ phase: "idle", error: null, revision });
const failed = (revision: number): State =>
  Object.freeze({
    revision,
    phase: "failed",
    error: "Session creation could not be confirmed. Refresh sessions before trying again.",
  });

/** One mutation at a time, no retry. Navigation may retire its UI but not replay it. */
export function createSessionOwner() {
  let state: State = idle(0);
  return {
    publication: (): State => state,
    reset() {
      if (state.phase !== "pending") state = idle(state.revision);
    },
    start(input: {
      name: string;
      current: () => boolean;
      create: (operationId: string, name: string) => Promise<unknown>;
      refresh: () => Promise<void>;
      changed: () => void;
    }): Promise<void> | undefined {
      const name = WorkspaceSessionCreateArgumentsSchemaZ.shape.displayName.parse(input.name);
      if (state.phase !== "idle" || !input.current() || state.revision === Number.MAX_SAFE_INTEGER)
        return;
      state = Object.freeze({ phase: "pending", error: null, revision: state.revision + 1 });
      input.changed();
      const operationId = randomUUID();
      return (async () => {
        try {
          await input.create(operationId, name);
          if (input.current()) await input.refresh();
          state = idle(state.revision);
        } catch {
          // Neither an HTTP error nor a disconnected response proves rollback.
          state = input.current() ? failed(state.revision) : idle(state.revision);
        } finally {
          input.changed();
        }
      })();
    },
  };
}
