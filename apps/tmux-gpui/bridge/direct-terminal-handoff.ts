import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TerminalAttachmentSemanticPaneIdSchemaZ } from "../../../packages/contracts/src/semantic-identity.ts";
import type { connectionSchema } from "./config.ts";
import { issueDirectTerminal } from "./direct-terminal.ts";

export const nativePaneSelectedSchema = z
  .object({
    type: z.literal("native-pane-selected"),
    id: z.uuid(),
    fromRequest: z.number().int().nonnegative().safe(),
    request: z.number().int().positive().safe(),
    pane: TerminalAttachmentSemanticPaneIdSchemaZ,
  })
  .strict()
  .refine(
    (value) => value.request > value.fromRequest,
    "Native selection must advance its request",
  );

export type DirectTerminalScope = {
  catalogOnly: boolean;
  id: string;
  request: number;
  config: z.infer<typeof connectionSchema>;
  origin: string;
  hostClientId: string;
};

type Capability = Awaited<ReturnType<typeof issueDirectTerminal>> & { catalogOnly?: boolean };
export type DirectTerminalEvent =
  | {
      type: "native-terminal-open";
      version: 1;
      id: string;
      request: number;
      liveSessionId: string;
      capability: Capability;
    }
  | { type: "native-terminal-close"; version: 1; id: string; request: number };

/** Owns only one-use capability issuance. Native owns the socket, replicas and controls.
 * `send` must preserve order and fail the connection on overflow; events must never coalesce.
 */
export function createDirectTerminalHandoff(
  send: (event: DirectTerminalEvent) => void,
  issue: typeof issueDirectTerminal = issueDirectTerminal,
  onScope: (scope: DirectTerminalScope | null) => void = () => {},
) {
  let current:
    | {
        id: string;
        request: number;
        controller: AbortController;
        panes: ReadonlySet<string> | null;
        scope: DirectTerminalScope | null;
      }
    | undefined;
  function retire() {
    const old = current;
    current = undefined;
    if (!old) return;
    old.controller.abort();
    onScope(null);
    send({ type: "native-terminal-close", version: 1, id: old.id, request: old.request });
  }
  return {
    retire,
    /** Navigation completion from Rust: an ACK-fenced selection or a same-pane refusal.
     * This updates metadata scope, not input authority. It never issues a descriptor,
     * opens a socket, or selects through HTTP.
     */
    advanceSelection(value: unknown): boolean {
      const parsed = nativePaneSelectedSchema.safeParse(value);
      if (!parsed.success) return false;
      const command = parsed.data;
      if (
        !current ||
        current.controller.signal.aborted ||
        current.id !== command.id ||
        current.request !== command.fromRequest ||
        !current.panes?.has(command.pane) ||
        !current.scope ||
        current.scope.catalogOnly
      )
        return false;
      current.request = command.request;
      current.scope = {
        ...current.scope,
        request: command.request,
        config: { ...current.scope.config, semanticPaneId: command.pane },
      };
      onScope(current.scope);
      return true;
    },
    async open(config: z.infer<typeof connectionSchema>, request: number, catalogOnly = false) {
      if (!Number.isSafeInteger(request) || request < 0) throw new Error("Invalid native request");
      retire();
      const issuedConfig = {
        ...config,
        scope: { ...config.scope },
        ...(config.visiblePaneIds ? { visiblePaneIds: [...config.visiblePaneIds] } : {}),
      };
      const ticket = {
        id: randomUUID(),
        request,
        controller: new AbortController(),
        panes: null as ReadonlySet<string> | null,
        scope: null as DirectTerminalScope | null,
      };
      current = ticket;
      try {
        const capability = await issue(
          issuedConfig,
          catalogOnly ? "read-only" : "interactive",
          ticket.controller.signal,
        );
        if (current !== ticket || ticket.controller.signal.aborted) return;
        ticket.panes = new Set(capability.descriptor.panes);
        ticket.scope = {
          catalogOnly,
          id: ticket.id,
          request,
          config: { ...issuedConfig, visiblePaneIds: [...capability.descriptor.panes] },
          origin: capability.origin,
          hostClientId: capability.hostClientId,
        };
        onScope(ticket.scope);
        send({
          type: "native-terminal-open",
          version: 1,
          id: ticket.id,
          request,
          liveSessionId: issuedConfig.liveSessionId,
          capability: catalogOnly ? { ...capability, catalogOnly: true } : capability,
        });
      } catch {
        if (current !== ticket || ticket.controller.signal.aborted) return;
        try {
          retire();
        } catch {
          /* The caller must close the failed ordered transport. */
        }
        throw new Error("Native terminal capability unavailable");
      }
    },
  };
}
