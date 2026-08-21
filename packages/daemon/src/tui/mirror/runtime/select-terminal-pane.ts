import type { WorkspaceClientDispatch } from "@tmux-ide/daemon-client/workspace-client-types";

interface PaneSelectionClient {
  ownsRuntimeAuthority?(authority: "input"): boolean;
  requestAuthority(authority: "input"): Promise<unknown | null>;
  dispatch(command: WorkspaceClientDispatch): Promise<unknown>;
}

export type PaneSelectionReceipt = Readonly<{
  applied: boolean;
  operationId: string | null;
  semanticPaneId: string;
}>;

export type PaneSelectionFailure = Readonly<{
  stage: "authority-request" | "pre-dispatch" | "dispatch" | "post-dispatch" | "receipt";
  reason:
    | "authority-rejected"
    | "generation-replaced"
    | "operation-timeout"
    | "transport-rejected"
    | "receipt-invalid";
  backendReason?:
    | "pane_inventory_not_ready"
    | "pane_identity_changed_before_select"
    | "pane_not_active";
}>;

export interface LivePaneSelectionTarget {
  readonly status: "live";
  readonly daemonGeneration: string;
  readonly workspaceName: string;
  readonly client: PaneSelectionClient;
}

/** Acquire controller authority before issuing the canonical pane-select intent. */
export async function selectTerminalPane(
  expected: LivePaneSelectionTarget,
  current: () => LivePaneSelectionTarget | null,
  semanticPaneId: string,
  operationId?: string,
  onFailure?: (failure: PaneSelectionFailure) => void,
): Promise<PaneSelectionReceipt | null> {
  const fail = (failure: PaneSelectionFailure): null => {
    try {
      onFailure?.(failure);
    } catch {
      // Diagnostic failure reporting cannot own pane selection.
    }
    return null;
  };
  const transportFailure = (stage: PaneSelectionFailure["stage"], error: unknown): null => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
    const backendReason = [
      "pane_inventory_not_ready",
      "pane_identity_changed_before_select",
      "pane_not_active",
    ].includes(code ?? "")
      ? (code as PaneSelectionFailure["backendReason"])
      : undefined;
    return fail({
      stage,
      reason: code === "operation-timeout" ? "operation-timeout" : "transport-rejected",
      ...(backendReason ? { backendReason } : {}),
    });
  };
  const isCurrent = (): boolean => {
    const active = current();
    return (
      active?.status === "live" &&
      active.client === expected.client &&
      active.daemonGeneration === expected.daemonGeneration &&
      active.workspaceName === expected.workspaceName
    );
  };
  try {
    const ownsInput = expected.client.ownsRuntimeAuthority?.("input") === true;
    if (!ownsInput) {
      let lease: unknown | null;
      try {
        lease = await expected.client.requestAuthority("input");
      } catch (error) {
        return transportFailure("authority-request", error);
      }
      if (!lease) return fail({ stage: "authority-request", reason: "authority-rejected" });
      if (!isCurrent()) return fail({ stage: "authority-request", reason: "generation-replaced" });
    }
    if (!isCurrent()) return fail({ stage: "pre-dispatch", reason: "generation-replaced" });
    let result: unknown;
    try {
      result = await expected.client.dispatch({
        kind: "semantic-intent",
        ...(operationId ? { operationId } : {}),
        intent: {
          verb: "workspace.pane.select",
          workspaceName: expected.workspaceName,
          semanticPaneId,
        },
      });
    } catch (error) {
      return transportFailure("dispatch", error);
    }
    if (!isCurrent()) return fail({ stage: "post-dispatch", reason: "generation-replaced" });
    const wrapper = result as Record<string, unknown>;
    const exact = wrapper.result as Record<string, unknown> | undefined;
    if (
      wrapper.kind !== "semantic-intent" ||
      typeof wrapper.operationId !== "string" ||
      !exact ||
      exact.operationId !== wrapper.operationId ||
      exact.verb !== "workspace.pane.select" ||
      exact.semanticPaneId !== semanticPaneId ||
      exact.workspaceName !== expected.workspaceName ||
      exact.daemonInstanceId !== expected.daemonGeneration ||
      (operationId !== undefined && wrapper.operationId !== operationId) ||
      !["applied", "unchanged"].includes(String(exact.outcome))
    )
      return fail({ stage: "receipt", reason: "receipt-invalid" });
    return Object.freeze({
      applied: exact.outcome === "applied",
      operationId: wrapper.operationId,
      semanticPaneId,
    });
  } catch (error) {
    return transportFailure("dispatch", error);
  }
}
