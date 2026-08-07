import { z } from "zod";
import {
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticTargetSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
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

/**
 * One daemon-authored row from a tmux/registry discovery pass.
 *
 * `windowStamp` is the durable `@tmux_ide_window_id` value (m41 attach-1). It is
 * optional so that discovery paths which do not yet query the window option keep
 * producing byte-identical rows; an absent stamp reads as "unstamped window".
 */
export const TrustedSemanticPaneSnapshotSchemaZ = z
  .object({
    workspaceName: WorkspaceIdSchemaZ,
    semanticPaneId: TerminalAttachmentSemanticPaneIdSchemaZ.nullable(),
    windowStamp: TerminalAttachmentSemanticWindowIdSchemaZ.nullable().optional(),
    sessionId: RuntimeSessionIdSchemaZ,
    windowId: RuntimeWindowIdSchemaZ,
    runtimePaneId: RuntimePaneIdSchemaZ,
    windowPaneCount: z.number().int().positive(),
    sessionWindowCount: z.number().int().positive(),
  })
  .strict();
export type TrustedSemanticPaneSnapshot = z.infer<typeof TrustedSemanticPaneSnapshotSchemaZ>;

/**
 * Resolution names a single pane on the wire but proves the WHOLE window it
 * lives in (m41 attach-1). `windowStamp` is the window's durable identity,
 * `windowPaneCount` is no longer pinned to 1, and `windowPaneIndex` is the
 * resolved pane's discovery-order place inside that window. `windowStamp` is
 * null only for a legacy single-pane window that carries no durable stamp.
 */
export interface SemanticPaneRuntimeProof {
  readonly sessionId: string;
  readonly windowId: string;
  readonly runtimePaneId: string;
  readonly windowStamp: string | null;
  readonly windowPaneCount: number;
  readonly windowPaneIndex: number;
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
  // Retained for wire compatibility only. m41 attach-1 stopped emitting this
  // from the catalog: a multi-pane window is no longer a catalog-level fault.
  | "not-single-pane-window"
  // A multi-pane window is attachable only once it carries a durable window
  // stamp; an unstamped multi-pane window fails closed here.
  | "missing-window-stamp"
  // The panes of one runtime window disagree on their durable window stamp.
  | "window-stamp-inconsistent"
  // One durable window stamp is claimed by two distinct runtime windows.
  | "duplicate-window-stamp";

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

function proofFingerprint(proof: SemanticPaneRuntimeProof): string {
  return [
    proof.sessionId,
    proof.windowId,
    proof.runtimePaneId,
    proof.windowStamp ?? "",
    String(proof.windowPaneCount),
    String(proof.windowPaneIndex),
    String(proof.sessionWindowCount),
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
    return (await this.resolveMany([target]))[0]!;
  }

  /** Resolves a pane set from one trusted discovery snapshot. */
  async resolveMany(
    targets: readonly TerminalAttachmentSemanticTarget[],
  ): Promise<readonly SemanticPaneResolution[]> {
    const parsedTargets = z
      .array(TerminalAttachmentSemanticTargetSchemaZ)
      .min(1)
      .max(4_096)
      .parse(targets);
    const diagnosticTarget = parsedTargets[0]!;
    let discovered: readonly unknown[];
    try {
      discovered = await this.#discover();
    } catch {
      throw new SemanticPaneCatalogError(
        "discovery-failed",
        diagnosticTarget,
        "Trusted tmux pane discovery failed.",
      );
    }

    const analysis = analyzeTrustedSemanticPaneCatalog(discovered);
    const rows = analysis.rows;
    if (analysis.invalidRuntimeProof) {
      throw new SemanticPaneCatalogError(
        "invalid-runtime-proof",
        diagnosticTarget,
        "Trusted tmux discovery returned an invalid runtime proof.",
      );
    }

    if (analysis.missingSemanticStamp) {
      throw new SemanticPaneCatalogError(
        "missing-semantic-stamp",
        diagnosticTarget,
        "Trusted tmux discovery contains an unstamped pane.",
      );
    }

    if (analysis.duplicateSemanticStamp) {
      throw new SemanticPaneCatalogError(
        "duplicate-semantic-stamp",
        diagnosticTarget,
        "Semantic pane identities must be unique across trusted discovery.",
      );
    }
    if (analysis.duplicateRuntimePaneBinding) {
      throw new SemanticPaneCatalogError(
        "duplicate-runtime-pane-binding",
        diagnosticTarget,
        "A runtime pane cannot be bound to multiple semantic pane identities.",
      );
    }

    return parsedTargets.map((parsedTarget) => {
      const workspaceRows = rows.filter((row) => row.workspaceName === parsedTarget.workspaceName);
      if (workspaceRows.length === 0) {
        throw new SemanticPaneCatalogError(
          "workspace-not-found",
          parsedTarget,
          "The requested workspace is not present in trusted tmux discovery.",
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

      const source = this.#proveWindow(matches[0]!, rows, parsedTarget);
      const key = semanticPaneTargetKey(parsedTarget);
      const fingerprint = proofFingerprint(source);
      const previous = this.#generations.get(key);
      const generation =
        previous === undefined
          ? 0
          : previous.fingerprint === fingerprint
            ? previous.generation
            : previous.generation + 1;
      this.#generations.set(key, { fingerprint, generation });
      return { target: parsedTarget, bindingGeneration: generation, source };
    });
  }

  /**
   * Proves the WHOLE tmux window the resolved pane lives in (m41 attach-1).
   *
   * attach-1 widened the catalog from a single-pane gate to a durable window
   * identity: the previous `windowPaneCount !== 1` throw is gone, and a
   * multi-pane window resolves once it carries a valid, unique
   * `@tmux_ide_window_id` stamp shared by every one of its panes. m41 attach-2
   * then made the transport itself window-capable (grouped-tmux plan input,
   * native-runtime geometry, the pty launcher and the view executor all dropped
   * their `window_panes == 1` gates and the view client attaches size-passive).
   * The application-shell attachability projection still gates end-to-end app
   * behavior until m41 attach-4 widens it.
   */
  #proveWindow(
    row: TrustedSemanticPaneSnapshot,
    rows: readonly TrustedSemanticPaneSnapshot[],
    target: TerminalAttachmentSemanticTarget,
  ): SemanticPaneRuntimeProof {
    // Runtime window identity. Grouped/linked sessions share one window id, so
    // keying by windowId keeps a linked window a single logical window.
    const windowRows = rows.filter((candidate) => candidate.windowId === row.windowId);
    const stampedRows = windowRows.filter((candidate) => (candidate.windowStamp ?? null) !== null);
    const distinctStamps = new Set(stampedRows.map((candidate) => candidate.windowStamp!));

    if (distinctStamps.size > 1) {
      throw new SemanticPaneCatalogError(
        "window-stamp-inconsistent",
        target,
        "The panes of a trusted tmux window disagree on their durable window stamp.",
      );
    }
    if (row.windowPaneCount > 1) {
      if (distinctStamps.size === 0) {
        throw new SemanticPaneCatalogError(
          "missing-window-stamp",
          target,
          "A multi-pane tmux window is attachable only once it carries a durable window stamp.",
        );
      }
      if (stampedRows.length !== windowRows.length) {
        throw new SemanticPaneCatalogError(
          "window-stamp-inconsistent",
          target,
          "Every pane of a multi-pane tmux window must carry the same durable window stamp.",
        );
      }
    }

    const windowStamp = distinctStamps.size === 1 ? [...distinctStamps][0]! : null;
    if (windowStamp !== null) {
      const windowIds = new Set(
        rows
          .filter((candidate) => (candidate.windowStamp ?? null) === windowStamp)
          .map((candidate) => candidate.windowId),
      );
      if (windowIds.size > 1) {
        throw new SemanticPaneCatalogError(
          "duplicate-window-stamp",
          target,
          "A durable window stamp must identify exactly one trusted tmux window.",
        );
      }
    }

    // Discovery-order place of the resolved pane inside its window. Real cell
    // geometry is owned by m41 attach-2; this ordinal is deliberately not it.
    const windowPaneIndex = windowRows.findIndex(
      (candidate) => candidate.runtimePaneId === row.runtimePaneId,
    );

    return {
      sessionId: row.sessionId,
      windowId: row.windowId,
      runtimePaneId: row.runtimePaneId,
      windowStamp,
      windowPaneCount: row.windowPaneCount,
      windowPaneIndex,
      sessionWindowCount: row.sessionWindowCount,
    };
  }
}
