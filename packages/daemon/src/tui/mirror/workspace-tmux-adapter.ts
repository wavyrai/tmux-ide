import {
  WORKSPACE_SEMANTIC_PANE_OPTION,
  WorkspaceIdSchemaZ,
  WorkspaceObservationSchemaZ,
  type WorkspaceObservation,
  type WorkspacePaneBinding,
  type WorkspacePaneRect,
  type WorkspaceWorkbenchState,
} from "@tmux-ide/contracts";

const RUNTIME_PANE_ID = /^%[0-9]+$/u;
const DEFAULT_GENERATION_ATTEMPTS = 32;

/** Raw tmux facts. A pane stamp remains untrusted until reconciliation. */
export interface WorkspaceTmuxPaneSnapshot {
  runtimePaneId: string;
  semanticPaneId: string | null;
  role: string | null;
  type: string | null;
  currentCommand: string | null;
  cwd: string | null;
  title: string | null;
  rect: WorkspacePaneRect;
  active: boolean;
}

export type WorkspaceTmuxDiagnosticCode =
  | "INVALID_RUNTIME_PANE"
  | "DUPLICATE_RUNTIME_PANE"
  | "MISSING_SEMANTIC_STAMP"
  | "INVALID_SEMANTIC_STAMP"
  | "DUPLICATE_SEMANTIC_STAMP"
  | "STALE_RUNTIME_BINDING_IGNORED"
  | "SEMANTIC_ID_GENERATION_FAILED"
  | "SEMANTIC_STAMP_BACK_FAILED"
  | "LIVE_METADATA_NORMALIZED";

export interface WorkspaceTmuxDiagnostic {
  code: WorkspaceTmuxDiagnosticCode;
  runtimePaneId: string | null;
  semanticPaneId: string | null;
  message: string;
  /** True when this pane cannot safely enter a durable workspace observation. */
  degraded: boolean;
}

export interface WorkspaceTmuxStampEffect {
  kind: "set-pane-option";
  runtimePaneId: string;
  option: typeof WORKSPACE_SEMANTIC_PANE_OPTION;
  value: string;
}

export interface ReconciledWorkspaceTmuxPane extends WorkspaceTmuxPaneSnapshot {
  semanticPaneId: string;
  identitySource: "stamp" | "generated";
  requiresStampBack: boolean;
}

export interface WorkspaceTmuxReconciliationPlan {
  panes: readonly ReconciledWorkspaceTmuxPane[];
  stampEffects: readonly WorkspaceTmuxStampEffect[];
  diagnostics: readonly WorkspaceTmuxDiagnostic[];
  degraded: boolean;
}

export interface WorkspaceTmuxStampOutcome {
  runtimePaneId: string;
  ok: boolean;
  error?: string | null;
}

export interface WorkspaceTmuxReconciliation {
  panes: readonly ReconciledWorkspaceTmuxPane[];
  diagnostics: readonly WorkspaceTmuxDiagnostic[];
  degraded: boolean;
}

export interface PlanWorkspaceTmuxReconciliationInput {
  panes: readonly WorkspaceTmuxPaneSnapshot[];
  generateSemanticPaneId: () => string;
  /** Persisted bindings are diagnostics only; they are never identity input. */
  previousBindings?: Readonly<Record<string, WorkspacePaneBinding>>;
  maxGenerationAttempts?: number;
}

/**
 * Pure identity reconciliation. `%pane_id` is accepted only as a live address.
 * Every missing, invalid, or duplicated semantic stamp receives a new semantic
 * id and an explicit pane-local stamp-back effect. For duplicates, every copy
 * is replaced so reconciliation never chooses a winner from tmux ordering.
 */
export function planWorkspaceTmuxReconciliation(
  input: PlanWorkspaceTmuxReconciliationInput,
): WorkspaceTmuxReconciliationPlan {
  const diagnostics: WorkspaceTmuxDiagnostic[] = [];
  const panes: WorkspaceTmuxPaneSnapshot[] = [];
  const runtimeIds = new Set<string>();

  for (const pane of input.panes) {
    if (!RUNTIME_PANE_ID.test(pane.runtimePaneId)) {
      diagnostics.push(
        diagnostic(
          "INVALID_RUNTIME_PANE",
          null,
          pane.semanticPaneId,
          `Ignored invalid live tmux pane address ${JSON.stringify(pane.runtimePaneId)}.`,
          true,
        ),
      );
      continue;
    }
    if (runtimeIds.has(pane.runtimePaneId)) {
      diagnostics.push(
        diagnostic(
          "DUPLICATE_RUNTIME_PANE",
          pane.runtimePaneId,
          pane.semanticPaneId,
          `Ignored duplicate live tmux pane address ${pane.runtimePaneId}.`,
          true,
        ),
      );
      continue;
    }
    runtimeIds.add(pane.runtimePaneId);
    panes.push(pane);
  }

  const validStampCounts = new Map<string, number>();
  for (const pane of panes) {
    if (!validSemanticPaneId(pane.semanticPaneId)) continue;
    validStampCounts.set(pane.semanticPaneId, (validStampCounts.get(pane.semanticPaneId) ?? 0) + 1);
  }

  // Reserve every observed valid value, including duplicates. Duplicate panes
  // must all move to newly generated identities rather than arbitrarily keeping
  // one value based on tmux list order.
  const claimedSemanticIds = new Set(validStampCounts.keys());
  const priorByRuntime = previousBindingsByRuntime(input.previousBindings);
  const reconciled: ReconciledWorkspaceTmuxPane[] = [];
  const stampEffects: WorkspaceTmuxStampEffect[] = [];
  const maxAttempts = normalizeAttempts(input.maxGenerationAttempts);

  for (const pane of panes) {
    const rawStamp = pane.semanticPaneId;
    const stampIsValid = validSemanticPaneId(rawStamp);
    const stampIsUnique = stampIsValid && validStampCounts.get(rawStamp) === 1;
    const priorSemanticId = priorByRuntime.get(pane.runtimePaneId) ?? null;

    if (priorSemanticId && priorSemanticId !== (stampIsUnique ? rawStamp : null)) {
      diagnostics.push(
        diagnostic(
          "STALE_RUNTIME_BINDING_IGNORED",
          pane.runtimePaneId,
          priorSemanticId,
          `Ignored persisted binding ${priorSemanticId} -> ${pane.runtimePaneId}; runtime pane ids are reusable addresses, not identity.`,
          false,
        ),
      );
    }

    if (stampIsUnique) {
      reconciled.push({
        ...pane,
        semanticPaneId: rawStamp,
        identitySource: "stamp",
        requiresStampBack: false,
      });
      continue;
    }

    if (rawStamp === null || rawStamp.length === 0) {
      diagnostics.push(
        diagnostic(
          "MISSING_SEMANTIC_STAMP",
          pane.runtimePaneId,
          null,
          `Pane ${pane.runtimePaneId} has no semantic identity stamp; a fresh id will be stamped back.`,
          false,
        ),
      );
    } else if (!stampIsValid) {
      diagnostics.push(
        diagnostic(
          "INVALID_SEMANTIC_STAMP",
          pane.runtimePaneId,
          rawStamp,
          `Pane ${pane.runtimePaneId} has an invalid semantic identity stamp; a fresh id will be stamped back.`,
          false,
        ),
      );
    } else {
      diagnostics.push(
        diagnostic(
          "DUPLICATE_SEMANTIC_STAMP",
          pane.runtimePaneId,
          rawStamp,
          `Pane ${pane.runtimePaneId} shares semantic identity ${rawStamp}; every duplicate will be restamped.`,
          false,
        ),
      );
    }

    const generated = generateUnclaimedSemanticPaneId(
      input.generateSemanticPaneId,
      claimedSemanticIds,
      maxAttempts,
    );
    if (!generated) {
      diagnostics.push(
        diagnostic(
          "SEMANTIC_ID_GENERATION_FAILED",
          pane.runtimePaneId,
          rawStamp,
          `Could not generate a valid unique semantic identity for ${pane.runtimePaneId}.`,
          true,
        ),
      );
      continue;
    }

    claimedSemanticIds.add(generated);
    reconciled.push({
      ...pane,
      semanticPaneId: generated,
      identitySource: "generated",
      requiresStampBack: true,
    });
    stampEffects.push({
      kind: "set-pane-option",
      runtimePaneId: pane.runtimePaneId,
      option: WORKSPACE_SEMANTIC_PANE_OPTION,
      value: generated,
    });
  }

  return {
    panes: reconciled,
    stampEffects,
    diagnostics,
    degraded: diagnostics.some((item) => item.degraded),
  };
}

/**
 * Pure effect acknowledgement. Generated ids become observable only after the
 * caller confirms the corresponding tmux stamp succeeded. Missing and failed
 * acknowledgements degrade explicitly and exclude that pane from persistence.
 */
export function finalizeWorkspaceTmuxReconciliation(
  plan: WorkspaceTmuxReconciliationPlan,
  outcomes: readonly WorkspaceTmuxStampOutcome[],
): WorkspaceTmuxReconciliation {
  const byRuntime = new Map(outcomes.map((outcome) => [outcome.runtimePaneId, outcome]));
  const diagnostics = [...plan.diagnostics];
  const panes: ReconciledWorkspaceTmuxPane[] = [];

  for (const pane of plan.panes) {
    if (!pane.requiresStampBack) {
      panes.push(pane);
      continue;
    }
    const outcome = byRuntime.get(pane.runtimePaneId);
    if (outcome?.ok) {
      panes.push(pane);
      continue;
    }
    const reason = outcome?.error?.trim();
    diagnostics.push(
      diagnostic(
        "SEMANTIC_STAMP_BACK_FAILED",
        pane.runtimePaneId,
        pane.semanticPaneId,
        `Could not stamp semantic identity ${pane.semanticPaneId} onto ${pane.runtimePaneId}${reason ? `: ${reason}` : "."}`,
        true,
      ),
    );
  }

  return {
    panes,
    diagnostics,
    degraded: diagnostics.some((item) => item.degraded),
  };
}

export interface WorkspaceObservationFromTmuxInput {
  checkoutKey: string;
  projectRoot: string;
  observedAt: string;
  sessionName: string | null;
  windowIndex: number | null;
  windowName: string | null;
  focusedRuntimePaneId: string | null;
  workbench: WorkspaceWorkbenchState;
}

export interface WorkspaceTmuxObservationProjection {
  observation: WorkspaceObservation;
  diagnostics: readonly WorkspaceTmuxDiagnostic[];
  degraded: boolean;
}

/**
 * Pure projection from acknowledged tmux truth into the durable contract.
 * Arbitrary legal tmux metadata is NUL-cleaned and bounded before validation,
 * so a long title/path/window name can never crash workspace capture.
 */
export function workspaceObservationFromTmux(
  reconciliation: WorkspaceTmuxReconciliation,
  input: WorkspaceObservationFromTmuxInput,
): WorkspaceTmuxObservationProjection {
  const diagnostics = [...reconciliation.diagnostics];
  const focused =
    reconciliation.panes.find((pane) => pane.runtimePaneId === input.focusedRuntimePaneId) ??
    reconciliation.panes.find((pane) => pane.active) ??
    null;

  const observation = WorkspaceObservationSchemaZ.parse({
    checkoutKey: input.checkoutKey,
    projectRoot: input.projectRoot,
    observedAt: input.observedAt,
    sessionName: normalizedLiveText(
      input.sessionName,
      256,
      "session name",
      null,
      null,
      diagnostics,
    ),
    windowIndex: input.windowIndex,
    windowName: normalizedLiveText(input.windowName, 256, "window name", null, null, diagnostics),
    panes: reconciliation.panes.map((pane) => {
      const role = workspaceRole(pane);
      return {
        semanticPaneId: pane.semanticPaneId,
        runtimePaneId: pane.runtimePaneId,
        role,
        harness:
          role === "agent"
            ? normalizedLiveText(
                commandBasename(pane.currentCommand),
                80,
                "harness",
                pane.runtimePaneId,
                pane.semanticPaneId,
                diagnostics,
              )
            : null,
        title: normalizedLiveText(
          pane.title,
          80,
          "pane title",
          pane.runtimePaneId,
          pane.semanticPaneId,
          diagnostics,
        ),
        command: normalizedLiveText(
          pane.currentCommand,
          512,
          "pane command",
          pane.runtimePaneId,
          pane.semanticPaneId,
          diagnostics,
        ),
        cwd: normalizedLiveText(
          pane.cwd,
          4096,
          "pane cwd",
          pane.runtimePaneId,
          pane.semanticPaneId,
          diagnostics,
        ),
        rect: pane.rect,
        active: pane.active,
      };
    }),
    focusedPaneId: focused?.semanticPaneId ?? null,
    workbench: input.workbench,
  });
  return {
    observation,
    diagnostics,
    degraded: diagnostics.some((item) => item.degraded),
  };
}

function validSemanticPaneId(value: string | null): value is string {
  return value !== null && WorkspaceIdSchemaZ.safeParse(value).success;
}

function normalizeAttempts(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : DEFAULT_GENERATION_ATTEMPTS;
}

function generateUnclaimedSemanticPaneId(
  generate: () => string,
  claimed: ReadonlySet<string>,
  maxAttempts: number,
): string | null {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generate();
    if (validSemanticPaneId(candidate) && !claimed.has(candidate)) return candidate;
  }
  return null;
}

function previousBindingsByRuntime(
  bindings: Readonly<Record<string, WorkspacePaneBinding>> | undefined,
): Map<string, string> {
  const byRuntime = new Map<string, string>();
  for (const binding of Object.values(bindings ?? {})) {
    if (RUNTIME_PANE_ID.test(binding.runtimePaneId)) {
      byRuntime.set(binding.runtimePaneId, binding.semanticPaneId);
    }
  }
  return byRuntime;
}

function workspaceRole(pane: WorkspaceTmuxPaneSnapshot): "agent" | "shell" {
  const role = pane.role?.toLowerCase();
  const type = pane.type?.toLowerCase();
  return type === "agent" ||
    role === "agent" ||
    role === "lead" ||
    role === "teammate" ||
    role === "planner"
    ? "agent"
    : "shell";
}

function commandBasename(command: string | null): string | null {
  const executable = command?.trim().split(/\s+/u)[0];
  if (!executable) return null;
  return executable.split(/[/\\]/u).at(-1) ?? null;
}

function normalizedLiveText(
  value: string | null,
  maxLength: number,
  field: string,
  runtimePaneId: string | null,
  semanticPaneId: string | null,
  diagnostics: WorkspaceTmuxDiagnostic[],
): string | null {
  if (value === null || value.length === 0) return null;
  const normalized = value.replaceAll("\0", "").slice(0, maxLength);
  if (normalized !== value) {
    diagnostics.push(
      diagnostic(
        "LIVE_METADATA_NORMALIZED",
        runtimePaneId,
        semanticPaneId,
        `Normalized ${field} to the durable workspace contract limit (${maxLength} characters, no NUL bytes).`,
        true,
      ),
    );
  }
  return normalized.length > 0 ? normalized : null;
}

function diagnostic(
  code: WorkspaceTmuxDiagnosticCode,
  runtimePaneId: string | null,
  semanticPaneId: string | null,
  message: string,
  degraded: boolean,
): WorkspaceTmuxDiagnostic {
  return { code, runtimePaneId, semanticPaneId, message, degraded };
}
