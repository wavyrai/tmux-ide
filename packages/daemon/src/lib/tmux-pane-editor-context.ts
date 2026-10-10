import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  WorkspaceCatalogLiveSessionIdSchemaZ,
  WorkspaceIdSchemaZ,
  WorkspacePaneCwdSchemaZ,
  type WorkspacePaneCwd,
} from "@tmux-ide/contracts";
import type { LiveSessionSummary } from "../command-center/discovery.ts";
import type {
  NativeTerminalInventoryPaneSnapshot,
  WorkspaceTerminalInventoryRuntime,
} from "../terminal/attachments/native-runtime.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";
import { materializePaneCwd, normalizePaneCwd } from "./workspace-state.ts";

const TargetSchema = z
  .object({
    generation: z.uuid(),
    workspaceName: WorkspaceIdSchemaZ,
    liveSessionId: WorkspaceCatalogLiveSessionIdSchemaZ,
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ,
  })
  .strict();

export type PaneEditorContextTarget = z.infer<typeof TargetSchema>;

/** Local observation only; never a transferable authorization to launch an editor. */
export interface PaneEditorContextObservation extends PaneEditorContextTarget {
  readonly cwd: WorkspacePaneCwd;
  readonly directory: string;
}

interface Options {
  readonly generation: string;
  readonly assertOpen: () => void;
  readonly registry: Pick<WorkspaceRegistry, "get">;
  readonly catalog: () => Promise<LiveSessionSummary[]>;
  readonly inventory: Pick<WorkspaceTerminalInventoryRuntime, "discoverTerminalInventory">;
}

/** Constructed only by the direct, generation-fenced local tmux server owner. */
export function createPaneEditorContextResolver(options: Options) {
  const generation = z.uuid().parse(options.generation);
  return async (
    input: PaneEditorContextTarget,
    cancellation?: AbortSignal,
  ): Promise<PaneEditorContextObservation> => {
    const target = TargetSchema.parse(input);
    // A supplied signal selects a fresh inventory read, not an existing flight.
    const signal = cancellation
      ? AbortSignal.any([cancellation, AbortSignal.timeout(5_000)])
      : AbortSignal.timeout(5_000);
    const unavailable = (): never => {
      throw new Error("Selected pane editor context is unavailable");
    };
    const assertOwner = () => {
      options.assertOpen();
      signal.throwIfAborted();
      if (target.generation !== generation) unavailable();
    };
    assertOwner();
    const workspace = options.registry.get(target.workspaceName);
    if (!workspace) return unavailable();
    const { sessionName, projectDir } = workspace;
    if (!isAbsolute(projectDir)) return unavailable();
    const assertScope = () => {
      assertOwner();
      const current = options.registry.get(target.workspaceName);
      if (
        current !== workspace ||
        current.sessionName !== sessionName ||
        current.projectDir !== projectDir
      )
        unavailable();
    };
    const checkCatalog = async () => {
      assertScope();
      const sessions = await options.catalog();
      assertScope();
      const matches = sessions.filter((session) => session.liveSessionId === target.liveSessionId);
      if (matches.length !== 1 || matches[0]!.sessionName !== sessionName) unavailable();
    };
    const readPane = async (): Promise<NativeTerminalInventoryPaneSnapshot> => {
      assertScope();
      const snapshot = await options.inventory.discoverTerminalInventory(signal);
      assertScope();
      const analysis = snapshot.catalog;
      if (
        analysis.invalidRuntimeProof ||
        analysis.duplicateSemanticStamp ||
        analysis.duplicateRuntimePaneBinding
      )
        unavailable();
      const matches = snapshot.panes.filter(
        (pane) =>
          pane.workspaceName === target.workspaceName &&
          pane.semanticPaneId === target.semanticPaneId,
      );
      if (matches.length !== 1) return unavailable();
      const pane = matches[0]!;
      if (pane.sessionName !== sessionName || !pane.dir || !isAbsolute(pane.dir)) unavailable();
      // Detach observations from mutable discovery/test adapters before another await.
      return { ...pane };
    };
    await checkCatalog();
    assertScope();
    const before = await readPane();
    assertScope();
    await checkCatalog();
    assertScope();
    // Discovery already fences topology internally. This second read additionally
    // refuses a cwd/binding change during resolution; it never retries a selection.
    const after = await readPane();
    assertScope();
    for (const key of [
      "sessionId",
      "windowId",
      "runtimePaneId",
      "windowStamp",
      "nativePaneBirthId",
      "dir",
    ] as const)
      if ((before[key] ?? null) !== (after[key] ?? null)) unavailable();
    // No saved layout fallback: projectDir only expresses the live cwd as a
    // typed project-relative value when the existing containment policy permits it.
    const absolute = WorkspacePaneCwdSchemaZ.parse({ kind: "absolute", path: resolve(after.dir) });
    const relative = WorkspacePaneCwdSchemaZ.safeParse(normalizePaneCwd(after.dir, projectDir));
    const cwd =
      relative.success && materializePaneCwd(relative.data, projectDir) === absolute.path
        ? relative.data
        : absolute;
    const directory = materializePaneCwd(cwd, projectDir);
    // Portable project-relative paths accept both separator styles. A literal
    // backslash on POSIX must not silently name a different local directory.
    if (!directory || directory !== absolute.path) return unavailable();
    return Object.freeze({ ...target, cwd: Object.freeze(cwd), directory });
  };
}
