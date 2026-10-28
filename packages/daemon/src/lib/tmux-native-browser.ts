import { PaneEditorContextTargetSchemaZ, NativeBrowserCommandSchemaZ } from "@tmux-ide/contracts";
import { z } from "zod";
import type { LiveSessionSummary } from "../command-center/discovery.ts";
import type { WorkspaceTerminalInventoryRuntime } from "../terminal/attachments/native-runtime.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import { decodeTmuxArgument } from "../terminal/protocol/session-descriptor-discovery.ts";
import {
  NativeBrowserEndpointSchema,
  NativeBrowserUnavailable,
  nativeBrowserRpc,
} from "./native-browser-rpc.ts";

export const NativeBrowserRequestSchema = z
  .object({
    target: PaneEditorContextTargetSchemaZ,
    command: NativeBrowserCommandSchemaZ.nullable(),
  })
  .strict();
export function createNativeBrowserResolver(options: {
  generation: string;
  assertOpen(): void;
  registry: Pick<WorkspaceRegistry, "get">;
  catalog(): Promise<LiveSessionSummary[]>;
  inventory: Pick<WorkspaceTerminalInventoryRuntime, "discoverTerminalInventory">;
  run(args: readonly string[], signal: AbortSignal): Promise<string>;
}) {
  let readers = 0;
  return async (input: unknown, cancellation: AbortSignal) => {
    const { target, command } = NativeBrowserRequestSchema.parse(input);
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(2500)]);
    const workspace = options.registry.get(target.workspaceName);
    const assertCurrent = () => {
      options.assertOpen();
      signal.throwIfAborted();
      if (
        target.generation !== options.generation ||
        !workspace ||
        options.registry.get(target.workspaceName) !== workspace
      )
        throw new NativeBrowserUnavailable();
    };
    assertCurrent();
    if (readers >= 8) throw new NativeBrowserUnavailable();
    readers++;
    try {
      const sessions = await options.catalog();
      assertCurrent();
      const matching = sessions.filter((s) => s.liveSessionId === target.liveSessionId);
      if (matching.length !== 1 || matching[0]!.sessionName !== workspace!.sessionName)
        throw new NativeBrowserUnavailable();
      const snapshot = await options.inventory.discoverTerminalInventory(signal);
      assertCurrent();
      if (
        snapshot.catalog.invalidRuntimeProof ||
        snapshot.catalog.duplicateSemanticStamp ||
        snapshot.catalog.duplicateRuntimePaneBinding
      )
        throw new NativeBrowserUnavailable();
      const matches = snapshot.panes.filter(
        (p) =>
          p.workspaceName === target.workspaceName &&
          p.semanticPaneId === target.semanticPaneId &&
          p.sessionName === workspace!.sessionName,
      );
      if (matches.length !== 1) throw new NativeBrowserUnavailable();
      const pane = { ...matches[0]! };
      if (!pane.nativePaneBirthId || !/^%[0-9]+$/u.test(pane.runtimePaneId))
        throw new NativeBrowserUnavailable();
      const observe = async () => {
        const raw = await options.run(
          [
            "display-message",
            "-p",
            "-t",
            pane.runtimePaneId,
            "#{qa:@tmux_ide_pane_id}\t#{qa:pane_birth_id}\t#{qa:@tmux_ide_browser_control}",
          ],
          signal,
        );
        assertCurrent();
        if (raw.length > 8192) throw new NativeBrowserUnavailable();
        const [semantic, birth, endpoint] = raw.trimEnd().split("\t").map(decodeTmuxArgument);
        if (semantic !== target.semanticPaneId || birth !== pane.nativePaneBirthId)
          throw new NativeBrowserUnavailable();
        const parsed = NativeBrowserEndpointSchema.parse(JSON.parse(endpoint ?? "null"));
        if (parsed.pane !== pane.runtimePaneId) throw new NativeBrowserUnavailable();
        return parsed;
      };
      const endpoint = await observe();
      const result = await nativeBrowserRpc(endpoint, command, signal);
      assertCurrent();
      const current = await observe();
      if (JSON.stringify(current) !== JSON.stringify(endpoint))
        throw new NativeBrowserUnavailable();
      return result;
    } finally {
      readers--;
    }
  };
}
