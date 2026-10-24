import { z } from "zod";
import { createTmuxServerClient } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { WindowLinkTargetSchemaZ } from "../../../packages/contracts/src/window-links.ts";
import { WindowSplitLayoutResourceSchemaZ } from "../../../packages/contracts/src/window-split-layout.ts";
import { connectionSchema } from "./config.ts";
import type { OwnerActionBinding } from "./direct-owner-actions.ts";
export const nativeSplitLayoutSchema = z
  .object({
    type: z.literal("native-split-layout"),
    version: z.literal(1),
    id: z.uuid(),
    request: z.number().int().nonnegative().safe(),
    sequence: z.number().int().positive().safe(),
    window: WindowLinkTargetSchemaZ,
  })
  .strict();
export type SplitLayoutResult = {
  type: "native-split-layout-result";
  version: 1;
  id: string;
  request: number;
  sequence: number;
} & (
  | { status: "ok"; resource: z.infer<typeof WindowSplitLayoutResourceSchemaZ> }
  | { status: "failed" }
);
/** Metadata-only canonical ancestry read. Rust rechecks geometry/lifetime on arrival. */
export function createDirectSplitLayout(
  send: (event: SplitLayoutResult) => void,
  requestFetch: typeof fetch = fetch,
) {
  let current: (OwnerActionBinding & { highest: number; pending?: AbortController }) | undefined;
  function retire() {
    const old = current;
    current = undefined;
    old?.pending?.abort();
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
        throw Error("Invalid native split scope");
      current = { ...binding, config: connectionSchema.parse(binding.config), highest: 0 };
    },
    async handle(value: unknown): Promise<boolean> {
      const parsed = nativeSplitLayoutSchema.safeParse(value);
      if (!parsed.success) return false;
      const command = parsed.data,
        bound = current;
      if (
        !bound ||
        bound.catalogOnly ||
        command.id !== bound.id ||
        command.request !== bound.request ||
        command.sequence <= bound.highest ||
        command.window.liveSessionId !== bound.config.liveSessionId
      )
        return false;
      bound.highest = command.sequence;
      bound.pending?.abort();
      const controller = new AbortController();
      bound.pending = controller;
      const client = createTmuxServerClient(
        {
          ...bound.config,
          origin: bound.origin,
          hostClientId: bound.hostClientId,
          fetch: (url, init) =>
            requestFetch(url, {
              ...init,
              signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]),
            }),
        },
        bound.config.scope,
      );
      const envelope = {
        type: "native-split-layout-result" as const,
        version: 1 as const,
        id: command.id,
        request: command.request,
        sequence: command.sequence,
      };
      let result: SplitLayoutResult = { ...envelope, status: "failed" };
      try {
        const response = await client.windowSplitLayout(
          bound.config.workspaceName,
          command.window,
          controller.signal,
        );
        const resource = WindowSplitLayoutResourceSchemaZ.parse(response.resource);
        if (
          JSON.stringify(resource.window) !== JSON.stringify(command.window) ||
          Buffer.byteLength(JSON.stringify(resource)) > 256 * 1024
        )
          throw Error("Native split metadata mismatch");
        result = { ...envelope, status: "ok", resource };
      } catch {
        /* fixed redacted failure only */
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
