import { z } from "zod";
import {
  TerminalAttachmentSemanticTargetSchemaZ,
  WorkspaceIdSchemaZ,
  type TerminalAttachmentSemanticTarget,
} from "@tmux-ide/contracts";

const RuntimeSessionIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^\$(?:0|[1-9][0-9]*)$/u);
const RuntimeWindowIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^@(?:0|[1-9][0-9]*)$/u);
const RuntimePaneIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^%(?:0|[1-9][0-9]*)$/u);

/** One daemon-authored row from a tmux/registry discovery pass. */
export const TrustedSemanticPaneSnapshotSchemaZ = z
  .object({
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: WorkspaceIdSchemaZ.nullable(),
    sessionId: RuntimeSessionIdSchemaZ,
    windowId: RuntimeWindowIdSchemaZ,
    runtimePaneId: RuntimePaneIdSchemaZ,
    windowPaneCount: z.number().int().positive(),
    sessionWindowCount: z.number().int().positive(),
  })
  .strict();
export type TrustedSemanticPaneSnapshot = z.infer<typeof TrustedSemanticPaneSnapshotSchemaZ>;

export interface SemanticPaneRuntimeProof {
  readonly sessionId: string;
  readonly windowId: string;
  readonly runtimePaneId: string;
  readonly paneCount: 1;
  readonly sessionWindowCount: number;
}

export interface SemanticPaneResolution {
  readonly target: TerminalAttachmentSemanticTarget;
  /** Stable while the trusted tmux proof is unchanged; increments on rebinding. */
  readonly bindingGeneration: number;
  readonly source: SemanticPaneRuntimeProof;
}

export type SemanticPaneCatalogErrorCode =
  | "discovery-failed"
  | "invalid-runtime-proof"
  | "workspace-not-found"
  | "pane-not-found"
  | "missing-semantic-stamp"
  | "duplicate-semantic-stamp"
  | "duplicate-runtime-pane-binding"
  | "not-single-pane-window";

export class SemanticPaneCatalogError extends Error {
  readonly code: SemanticPaneCatalogErrorCode;
  readonly target: TerminalAttachmentSemanticTarget;

  constructor(
    code: SemanticPaneCatalogErrorCode,
    target: TerminalAttachmentSemanticTarget,
    message: string,
  ) {
    super(message);
    this.name = "SemanticPaneCatalogError";
    this.code = code;
    this.target = target;
  }
}

export interface SemanticPaneCatalogOptions {
  /**
   * Trusted daemon boundary. Renderer data must never be adapted into these
   * rows; the implementation is expected to query tmux plus the workspace
   * registry directly.
   */
  readonly discover: () =>
    | readonly TrustedSemanticPaneSnapshot[]
    | Promise<readonly TrustedSemanticPaneSnapshot[]>;
}

interface GenerationState {
  fingerprint: string;
  generation: number;
}

export function semanticPaneTargetKey(target: TerminalAttachmentSemanticTarget): string {
  const parsed = TerminalAttachmentSemanticTargetSchemaZ.parse(target);
  return `${parsed.workspaceName}\0${parsed.semanticPaneId}`;
}

function proofFingerprint(row: TrustedSemanticPaneSnapshot): string {
  return [
    row.sessionId,
    row.windowId,
    row.runtimePaneId,
    String(row.windowPaneCount),
    String(row.sessionWindowCount),
  ].join("\0");
}

/**
 * Resolves semantic product identity to current daemon-trusted tmux truth.
 * The only caller-authored input is `{ workspaceName, semanticPaneId }`.
 */
export class SemanticPaneCatalog {
  readonly #discover: SemanticPaneCatalogOptions["discover"];
  readonly #generations = new Map<string, GenerationState>();

  constructor(options: SemanticPaneCatalogOptions) {
    this.#discover = options.discover;
  }

  async resolve(target: TerminalAttachmentSemanticTarget): Promise<SemanticPaneResolution> {
    const parsedTarget = TerminalAttachmentSemanticTargetSchemaZ.parse(target);
    let discovered: readonly TrustedSemanticPaneSnapshot[];
    try {
      discovered = await this.#discover();
    } catch {
      throw new SemanticPaneCatalogError(
        "discovery-failed",
        parsedTarget,
        "Trusted tmux pane discovery failed.",
      );
    }

    const rows: TrustedSemanticPaneSnapshot[] = [];
    for (const candidate of discovered) {
      const parsed = TrustedSemanticPaneSnapshotSchemaZ.safeParse(candidate);
      if (!parsed.success) {
        throw new SemanticPaneCatalogError(
          "invalid-runtime-proof",
          parsedTarget,
          "Trusted tmux discovery returned an invalid runtime proof.",
        );
      }
      rows.push(parsed.data);
    }

    if (rows.some((row) => row.semanticPaneId === null)) {
      throw new SemanticPaneCatalogError(
        "missing-semantic-stamp",
        parsedTarget,
        "Trusted tmux discovery contains an unstamped pane.",
      );
    }

    const workspaceRows = rows.filter((row) => row.workspaceName === parsedTarget.workspaceName);
    if (workspaceRows.length === 0) {
      throw new SemanticPaneCatalogError(
        "workspace-not-found",
        parsedTarget,
        "The requested workspace is not present in trusted tmux discovery.",
      );
    }

    const semanticCounts = new Map<string, number>();
    const runtimeCounts = new Map<string, number>();
    for (const row of rows) {
      runtimeCounts.set(row.runtimePaneId, (runtimeCounts.get(row.runtimePaneId) ?? 0) + 1);
      const semanticKey = semanticPaneTargetKey({
        workspaceName: row.workspaceName,
        semanticPaneId: row.semanticPaneId!,
      });
      semanticCounts.set(semanticKey, (semanticCounts.get(semanticKey) ?? 0) + 1);
    }
    if ([...semanticCounts.values()].some((count) => count !== 1)) {
      throw new SemanticPaneCatalogError(
        "duplicate-semantic-stamp",
        parsedTarget,
        "Semantic pane identities must be unique across trusted discovery.",
      );
    }
    if ([...runtimeCounts.values()].some((count) => count !== 1)) {
      throw new SemanticPaneCatalogError(
        "duplicate-runtime-pane-binding",
        parsedTarget,
        "A runtime pane cannot be bound to multiple semantic pane identities.",
      );
    }

    const matches = workspaceRows.filter(
      (row) => row.semanticPaneId === parsedTarget.semanticPaneId,
    );
    if (matches.length === 0) {
      throw new SemanticPaneCatalogError(
        "pane-not-found",
        parsedTarget,
        "The semantic pane is not present in trusted tmux discovery.",
      );
    }

    const row = matches[0]!;
    if (row.windowPaneCount !== 1) {
      throw new SemanticPaneCatalogError(
        "not-single-pane-window",
        parsedTarget,
        "Terminal attachment requires a trusted single-pane tmux window.",
      );
    }

    const key = semanticPaneTargetKey(parsedTarget);
    const fingerprint = proofFingerprint(row);
    const previous = this.#generations.get(key);
    const generation =
      previous === undefined
        ? 0
        : previous.fingerprint === fingerprint
          ? previous.generation
          : previous.generation + 1;
    this.#generations.set(key, { fingerprint, generation });

    return {
      target: parsedTarget,
      bindingGeneration: generation,
      source: {
        sessionId: row.sessionId,
        windowId: row.windowId,
        runtimePaneId: row.runtimePaneId,
        paneCount: 1,
        sessionWindowCount: row.sessionWindowCount,
      },
    };
  }
}
