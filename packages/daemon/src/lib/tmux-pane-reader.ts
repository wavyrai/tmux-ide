import { basename, dirname } from "node:path";
import {
  PaneReaderAssetRequestSchemaZ,
  PaneReaderAssetResponseSchemaZ,
  PaneReaderRequestSchemaZ,
  PaneReaderResponseSchemaZ,
  type PaneEditorContextTarget,
  type PaneReaderAssetResponse,
  type PaneReaderResponse,
} from "@tmux-ide/contracts";
import type { LiveSessionSummary } from "../command-center/discovery.ts";
import type { WorkspaceTerminalInventoryRuntime } from "../terminal/attachments/native-runtime.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import { decodeTmuxArgument } from "../terminal/protocol/session-descriptor-discovery.ts";
import { readerOption, type ReaderOption } from "../terminal/protocol/reader-option.ts";
import { readReaderAssetPage, readReaderPage } from "./pane-reader-files.ts";

/** Any identity, liveness or option failure. Carries no path or detail. */
export class PaneReaderUnavailable extends Error {
  constructor() {
    super("The reader pane is unavailable");
  }
}

export interface PaneReaderResolver {
  read(input: unknown, cancellation: AbortSignal): Promise<PaneReaderResponse>;
  asset(input: unknown, cancellation: AbortSignal): Promise<PaneReaderAssetResponse>;
}

/**
 * Serves only the file named by the target pane's `@tmux_ide_reader` option,
 * for a pane whose identity is proven again before and after the read, and
 * whose reader process is alive.
 */
export function createPaneReaderResolver(options: {
  generation: string;
  assertOpen(): void;
  registry: Pick<WorkspaceRegistry, "get">;
  catalog(): Promise<LiveSessionSummary[]>;
  inventory: Pick<WorkspaceTerminalInventoryRuntime, "discoverTerminalInventory">;
  run(args: readonly string[], signal: AbortSignal): Promise<string>;
  alive?: (pid: number) => boolean;
}): PaneReaderResolver {
  let readers = 0;
  const withReader = async <T>(
    target: PaneEditorContextTarget,
    cancellation: AbortSignal,
    work: (reader: ReaderOption) => T,
  ): Promise<T> => {
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
        throw new PaneReaderUnavailable();
    };
    assertCurrent();
    if (readers >= 8) throw new PaneReaderUnavailable();
    readers++;
    try {
      const sessions = await options.catalog();
      assertCurrent();
      const matching = sessions.filter((s) => s.liveSessionId === target.liveSessionId);
      if (matching.length !== 1 || matching[0]!.sessionName !== workspace!.sessionName)
        throw new PaneReaderUnavailable();
      const snapshot = await options.inventory.discoverTerminalInventory(signal);
      assertCurrent();
      if (
        snapshot.catalog.invalidRuntimeProof ||
        snapshot.catalog.duplicateSemanticStamp ||
        snapshot.catalog.duplicateRuntimePaneBinding
      )
        throw new PaneReaderUnavailable();
      const matches = snapshot.panes.filter(
        (p) =>
          p.workspaceName === target.workspaceName &&
          p.semanticPaneId === target.semanticPaneId &&
          p.sessionName === workspace!.sessionName,
      );
      if (matches.length !== 1) throw new PaneReaderUnavailable();
      const pane = { ...matches[0]! };
      if (!pane.nativePaneBirthId || !/^%[0-9]+$/u.test(pane.runtimePaneId))
        throw new PaneReaderUnavailable();
      const observe = async (): Promise<ReaderOption> => {
        const raw = await options.run(
          [
            "display-message",
            "-p",
            "-t",
            pane.runtimePaneId,
            "#{qa:@tmux_ide_pane_id}\t#{qa:pane_birth_id}\t#{qa:@tmux_ide_reader}",
          ],
          signal,
        );
        assertCurrent();
        if (raw.length > 16_384) throw new PaneReaderUnavailable();
        const [semantic, birth, option] = raw.trimEnd().split("\t").map(decodeTmuxArgument);
        if (semantic !== target.semanticPaneId || birth !== pane.nativePaneBirthId)
          throw new PaneReaderUnavailable();
        const reader = readerOption(option ?? "", options.alive);
        if (!reader) throw new PaneReaderUnavailable();
        return reader;
      };
      const reader = await observe();
      const result = work(reader);
      const current = await observe();
      if (current.path !== reader.path) throw new PaneReaderUnavailable();
      return result;
    } finally {
      readers--;
    }
  };
  return {
    read: async (input, cancellation) => {
      const request = PaneReaderRequestSchemaZ.parse(input);
      return withReader(request.target, cancellation, (reader) =>
        PaneReaderResponseSchemaZ.parse({
          version: 1,
          name: reader.name,
          folder: basename(dirname(reader.path)),
          ...readReaderPage(reader.path, request.have, request.page),
        }),
      );
    },
    asset: async (input, cancellation) => {
      const request = PaneReaderAssetRequestSchemaZ.parse(input);
      return withReader(request.target, cancellation, (reader) =>
        PaneReaderAssetResponseSchemaZ.parse({
          version: 1,
          ...readReaderAssetPage(reader.path, request.src, request.page),
        }),
      );
    },
  };
}
