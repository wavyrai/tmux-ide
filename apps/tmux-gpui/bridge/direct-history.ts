import { z } from "zod";
import {
  HistoryAnchorRequestSchemaZ,
  HistoryAnchorResponseSchemaZ,
} from "../../../packages/contracts/src/terminal-history-anchor.ts";
import { requestHistoryAnchor } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { connectionSchema } from "./config.ts";

const commandSchema = z
  .object({
    type: z.literal("native-history"),
    version: z.literal(1),
    id: z.uuid(),
    request: z.number().int().nonnegative().safe(),
    operationId: z.number().int().nonnegative().safe(),
    body: z.string().max(16 * 1024),
  })
  .strict();
export type DirectHistoryCommand = z.infer<typeof commandSchema>;
export type DirectHistoryResult = {
  type: "native-history-result";
  version: 1;
  id: string;
  request: number;
  operationId: number;
} & ({ status: "ok"; body: string } | { status: "unsupported" | "failed" });
export type DirectHistoryBinding = {
  id: string;
  request: number;
  config: z.infer<typeof connectionSchema>;
  origin: string;
  hostClientId: string;
};

/** Metadata-only owner broker. Ordered `send` failures must close the parent transport.
 * Rust owns row identity, scrollback, anchor admission and final response decoding.
 */
export function createDirectHistory(
  send: (event: DirectHistoryResult) => void,
  read: typeof requestHistoryAnchor = requestHistoryAnchor,
) {
  let current:
    | (DirectHistoryBinding & {
        highestOperation: number;
        pending?: AbortController;
      })
    | undefined;
  function retire() {
    const old = current;
    current = undefined;
    old?.pending?.abort();
  }
  return {
    retire,
    bind(binding: DirectHistoryBinding) {
      retire();
      if (
        !z.uuid().safeParse(binding.id).success ||
        !Number.isSafeInteger(binding.request) ||
        binding.request < 0 ||
        binding.origin !== "tmux-ide://app" ||
        !/^gpui:[0-9a-f-]{36}$/u.test(binding.hostClientId)
      )
        throw new Error("Invalid native history scope");
      current = {
        ...binding,
        config: connectionSchema.parse(binding.config),
        highestOperation: -1,
      };
    },
    async handle(value: unknown): Promise<boolean> {
      const parsed = commandSchema.safeParse(value);
      if (!parsed.success) return false;
      const command = parsed.data,
        bound = current;
      if (
        !bound ||
        command.id !== bound.id ||
        command.request !== bound.request ||
        command.operationId <= bound.highestOperation
      )
        return false;
      bound.highestOperation = command.operationId;
      bound.pending?.abort();
      const controller = new AbortController();
      bound.pending = controller;
      let result: { status: "ok"; body: string } | { status: "unsupported" | "failed" };
      try {
        if (Buffer.byteLength(command.body) > 16 * 1024) throw new Error("History request bound");
        const input = HistoryAnchorRequestSchemaZ.parse(JSON.parse(command.body));
        const config = bound.config;
        if (
          input.liveSessionId !== config.liveSessionId ||
          input.proof.workspaceName !== config.workspaceName ||
          input.proof.generation !== config.scope.generation ||
          !(config.visiblePaneIds ?? [config.semanticPaneId]).includes(input.proof.semanticPaneId)
        )
          throw new Error("History request scope");
        const response = await read(
          { ...config, origin: bound.origin, hostClientId: bound.hostClientId, timeoutMs: 2000 },
          config.scope,
          input,
          controller.signal,
        );
        if (response === null) result = { status: "unsupported" };
        else {
          const verified = HistoryAnchorResponseSchemaZ.parse(response);
          if (
            verified.server.serverId !== config.scope.serverId ||
            verified.server.generation !== config.scope.generation ||
            (verified.result.status === "captured" && input.operation.kind !== "capture") ||
            (verified.result.status === "resolved" &&
              (input.operation.kind !== "resolve" ||
                Object.entries(input.proof).some(
                  ([key, value]) =>
                    verified.result.status === "resolved" &&
                    verified.result.proof[key as keyof typeof verified.result.proof] !== value,
                )))
          )
            throw new Error("History response scope");
          const body = JSON.stringify(verified);
          if (Buffer.byteLength(body) > 4096) throw new Error("History response bound");
          result = { status: "ok", body };
        }
      } catch {
        // Never expose owner credentials, URLs, server exception text or request contents.
        result = { status: "failed" };
      }
      if (current !== bound || bound.pending !== controller || controller.signal.aborted)
        return true;
      bound.pending = undefined;
      send({
        type: "native-history-result",
        version: 1,
        id: command.id,
        request: command.request,
        operationId: command.operationId,
        ...result,
      });
      return true;
    },
  };
}
