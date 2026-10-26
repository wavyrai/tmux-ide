import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  WorkspaceCatalogLiveSessionIdSchemaZ,
} from "@tmux-ide/contracts";
import type { LiveSessionSummary } from "../command-center/discovery.ts";
import type { WorkspaceTerminalInventoryRuntime } from "../terminal/attachments/native-runtime.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

export const NativeSurfaceLocationSchema = z
  .object({
    socketPath: z
      .string()
      .min(1)
      .max(4096)
      .refine((p) => isAbsolute(p) && !/[\0\r\n\t]/u.test(p)),
    serverPid: z
      .string()
      .max(16)
      .regex(/^[1-9][0-9]*$/u),
    sessionId: z
      .string()
      .max(32)
      .regex(/^\$(?:0|[1-9][0-9]*)$/u),
    runtimePaneId: z
      .string()
      .max(32)
      .regex(/^%(?:0|[1-9][0-9]*)$/u),
  })
  .strict();
export type NativeSurfaceLocation = z.infer<typeof NativeSurfaceLocationSchema>;

interface Options {
  generation: string;
  assertOpen(): void;
  run(args: readonly string[], signal: AbortSignal): Promise<string>;
  registry: Pick<WorkspaceRegistry, "get">;
  catalog(): Promise<LiveSessionSummary[]>;
  inventory: Pick<WorkspaceTerminalInventoryRuntime, "discoverTerminalInventory">;
}

/** Resolve inherited tmux location only through the current generation's pinned owner. */
export function createNativeSurfaceContextResolver(options: Options) {
  const generation = z.uuid().parse(options.generation);
  return async (input: NativeSurfaceLocation, cancellation?: AbortSignal) => {
    const target = NativeSurfaceLocationSchema.parse(input);
    const signal = AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(cancellation ? [cancellation] : []),
    ]);
    const assertCurrent = () => {
      options.assertOpen();
      signal.throwIfAborted();
    };
    const unavailable = (): never => {
      throw new Error("Native surface source unavailable");
    };
    const observe = async () => {
      assertCurrent();
      const proof = await options.run(
        [
          "display-message",
          "-p",
          "-t",
          target.runtimePaneId,
          "#{socket_path}\t#{pid}\t#{session_id}\t#{pane_id}",
        ],
        signal,
      );
      assertCurrent();
      if (
        proof.trimEnd() !==
        [target.socketPath, target.serverPid, target.sessionId, target.runtimePaneId].join("\t")
      )
        unavailable();
      const snapshot = await options.inventory.discoverTerminalInventory(signal);
      assertCurrent();
      if (
        snapshot.catalog.invalidRuntimeProof ||
        snapshot.catalog.duplicateSemanticStamp ||
        snapshot.catalog.duplicateRuntimePaneBinding
      )
        unavailable();
      const matches = snapshot.panes.filter(
        (pane) =>
          pane.runtimePaneId === target.runtimePaneId && pane.sessionId === target.sessionId,
      );
      if (matches.length !== 1) return unavailable();
      const pane = { ...matches[0]! };
      const semantic = TerminalAttachmentSemanticPaneIdSchemaZ.parse(pane.semanticPaneId);
      const workspace = options.registry.get(pane.workspaceName);
      if (!workspace || workspace.sessionName !== pane.sessionName) return unavailable();
      const sessions = (await options.catalog()).filter(
        (row) => row.sessionName === pane.sessionName,
      );
      assertCurrent();
      if (sessions.length !== 1 || options.registry.get(pane.workspaceName) !== workspace)
        return unavailable();
      const live = WorkspaceCatalogLiveSessionIdSchemaZ.parse(sessions[0]!.liveSessionId);
      return {
        context: {
          generation,
          workspaceName: pane.workspaceName,
          liveSessionId: live,
          pane: semantic,
        },
        identity: [
          pane.sessionId,
          pane.windowId,
          pane.runtimePaneId,
          pane.windowStamp ?? null,
          pane.nativePaneBirthId ?? null,
        ],
      };
    };
    const before = await observe();
    const after = await observe();
    if (JSON.stringify(before) !== JSON.stringify(after)) return unavailable();
    assertCurrent();
    return Object.freeze(after.context);
  };
}
