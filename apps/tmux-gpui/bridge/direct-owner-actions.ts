import { z } from "zod";
import { createTmuxServerClient } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "../../../packages/contracts/src/semantic-identity.ts";
import { connectionSchema } from "./config.ts";
import { matchesCreation, newAgentSchema, newWindowReceiptSchema } from "./new-window.ts";

const common = {
  type: z.literal("native-owner-action"),
  version: z.literal(1),
  id: z.uuid(),
  request: z.number().int().nonnegative().safe(),
  sequence: z.number().int().positive().safe(),
  operationId: z.uuid(),
  liveSessionId: z.string().min(1).max(512),
  generation: z.uuid(),
  pane: TerminalAttachmentSemanticPaneIdSchemaZ,
};
export const nativeOwnerActionSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("new-window") }).strict(),
  z.object({ ...common, action: z.literal("new-agent"), ...newAgentSchema.shape }).strict(),
]);
export type OwnerActionBinding = {
  catalogOnly?: boolean;
  id: string;
  request: number;
  config: z.infer<typeof connectionSchema>;
  origin: string;
  hostClientId: string;
};
export type OwnerActionResult = {
  type: "native-owner-action-result";
  version: 1;
  id: string;
  request: number;
  sequence: number;
  operationId: string;
} & (
  | { status: "created"; receipt: z.infer<typeof newWindowReceiptSchema> }
  | { status: "failed" | "busy" }
);

/** Owner HTTP only. Rust must hold its captured input+geometry grants and barrier
 * before submitting this trusted pipe command. This broker grants no authority,
 * never retries mutations, and never opens a terminal or preview subscription.
 * A created receipt requires a fresh catalog read before opening its new pane.
 */
export function createDirectOwnerActions(
  send: (result: OwnerActionResult) => void,
  requestFetch: typeof fetch = fetch,
) {
  let current:
    | (OwnerActionBinding & { highest: number; operations: Set<string>; pending?: AbortController })
    | undefined;
  function retire() {
    const previous = current;
    current = undefined;
    previous?.pending?.abort();
  }
  return {
    retire,
    bind(binding: OwnerActionBinding) {
      retire();
      if (
        !z.uuid().safeParse(binding.id).success ||
        !Number.isSafeInteger(binding.request) ||
        binding.request < 0 ||
        binding.origin !== "tmux-ide://app" ||
        !/^gpui:[0-9a-f-]{36}$/u.test(binding.hostClientId)
      )
        throw new Error("Invalid native owner scope");
      current = {
        ...binding,
        config: connectionSchema.parse(binding.config),
        highest: 0,
        operations: new Set(),
      };
    },
    busy() {
      return !!current?.pending;
    },
    async handle(value: unknown): Promise<boolean> {
      const parsed = nativeOwnerActionSchema.safeParse(value);
      if (!parsed.success) return false;
      const command = parsed.data,
        bound = current;
      if (
        !bound ||
        bound.catalogOnly ||
        command.id !== bound.id ||
        command.request !== bound.request ||
        command.sequence <= bound.highest ||
        bound.operations.has(command.operationId) ||
        bound.operations.size >= 256 ||
        command.liveSessionId !== bound.config.liveSessionId ||
        command.generation !== bound.config.scope.generation ||
        command.pane !== bound.config.semanticPaneId
      )
        return false;
      bound.highest = command.sequence;
      bound.operations.add(command.operationId);
      const envelope = {
        type: "native-owner-action-result" as const,
        version: 1 as const,
        id: command.id,
        request: command.request,
        sequence: command.sequence,
        operationId: command.operationId,
      };
      if (bound.pending) {
        send({ ...envelope, status: "busy" });
        return true;
      }
      const controller = new AbortController();
      bound.pending = controller;
      const config = bound.config;
      const client = createTmuxServerClient(
        {
          baseUrl: config.baseUrl,
          ownerToken: config.ownerToken,
          origin: bound.origin,
          hostClientId: bound.hostClientId,
          fetch: (url, init) =>
            requestFetch(url, {
              ...init,
              signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
            }),
        },
        config.scope,
      );
      let result: OwnerActionResult = { ...envelope, status: "failed" };
      try {
        const agent =
          command.action === "new-agent"
            ? { name: command.name, harness: command.harness }
            : undefined;
        const raw = await client.createPane(
          command.operationId,
          {
            workspaceName: config.workspaceName,
            ...(agent
              ? {
                  kind: "agent" as const,
                  displayTitle: agent.name,
                  harnessProfileId: agent.harness,
                  role: "implementer" as const,
                }
              : { kind: "terminal" as const }),
            placement: { kind: "window" },
          },
          config.liveSessionId,
        );
        const receipt = newWindowReceiptSchema.parse(raw);
        if (
          receipt.operationId !== command.operationId ||
          receipt.daemonInstanceId !== config.scope.generation ||
          receipt.outcome !== "created" ||
          receipt.resource.workspaceName !== config.workspaceName ||
          receipt.resource.semanticPaneId === command.pane ||
          !matchesCreation(receipt.resource, agent)
        )
          throw new Error("Native owner receipt scope");
        result = { ...envelope, status: "created", receipt };
      } catch {
        /* Owner credentials and remote error contents never cross the pipe. */
      } finally {
        client.dispose();
      }
      if (current !== bound || bound.pending !== controller || controller.signal.aborted)
        return true;
      bound.pending = undefined;
      send(result);
      return true;
    },
  };
}
