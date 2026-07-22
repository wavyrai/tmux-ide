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
  readonly discover: () => readonly unknown[] | Promise<readonly unknown[]>;
}

export interface TrustedSemanticPaneCatalogAnalysis {
  readonly rows: readonly TrustedSemanticPaneSnapshot[];
  readonly invalidRuntimeProof: boolean;
  readonly missingSemanticStamp: boolean;
  readonly duplicateSemanticStamp: boolean;
  readonly duplicateRuntimePaneBinding: boolean;
}

/**
 * Pure trust analysis shared by attachment resolution and terminal inventory.
 * It deliberately reports every global fault so each consumer can preserve its
 * own user-facing precedence without ever weakening the catalog invariants.
 */
export function analyzeTrustedSemanticPaneCatalog(
  candidates: readonly unknown[],
): TrustedSemanticPaneCatalogAnalysis {
  const rows: TrustedSemanticPaneSnapshot[] = [];
  let invalidRuntimeProof = false;
  for (const candidate of candidates) {
    const parsed = TrustedSemanticPaneSnapshotSchemaZ.safeParse(candidate);
    if (!parsed.success) {
      invalidRuntimeProof = true;
      continue;
    }
    rows.push(parsed.data);
  }

  const semanticCounts = new Map<string, number>();
  const runtimeCounts = new Map<string, number>();
  for (const row of rows) {
    runtimeCounts.set(row.runtimePaneId, (runtimeCounts.get(row.runtimePaneId) ?? 0) + 1);
    if (row.semanticPaneId !== null) {
      const semanticKey = `${row.workspaceName}\0${row.semanticPaneId}`;
      semanticCounts.set(semanticKey, (semanticCounts.get(semanticKey) ?? 0) + 1);
    }
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    invalidRuntimeProof,
    missingSemanticStamp: rows.some((row) => row.semanticPaneId === null),
    duplicateSemanticStamp: [...semanticCounts.values()].some((count) => count !== 1),
    duplicateRuntimePaneBinding: [...runtimeCounts.values()].some((count) => count !== 1),
  });
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
    let discovered: readonly unknown[];
    try {
      discovered = await this.#discover();
    } catch {
      throw new SemanticPaneCatalogError(
        "discovery-failed",
        parsedTarget,
        "Trusted tmux pane discovery failed.",
      );
    }

    const analysis = analyzeTrustedSemanticPaneCatalog(discovered);
    const rows = analysis.rows;
    if (analysis.invalidRuntimeProof) {
      throw new SemanticPaneCatalogError(
        "invalid-runtime-proof",
        parsedTarget,
        "Trusted tmux discovery returned an invalid runtime proof.",
      );
    }

    if (analysis.missingSemanticStamp) {
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

    if (analysis.duplicateSemanticStamp) {
      throw new SemanticPaneCatalogError(
        "duplicate-semantic-stamp",
        parsedTarget,
        "Semantic pane identities must be unique across trusted discovery.",
      );
    }
    if (analysis.duplicateRuntimePaneBinding) {
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
