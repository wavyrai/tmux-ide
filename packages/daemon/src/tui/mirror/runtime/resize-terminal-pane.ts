import type { WorkspaceClientDispatch } from "@tmux-ide/daemon-client/workspace-client-types";

interface PaneResizeClient {
  ownsRuntimeAuthority?(authority: "geometry"): boolean;
  requestAuthority(authority: "geometry"): Promise<unknown | null>;
  dispatch(command: WorkspaceClientDispatch): Promise<unknown>;
}

export interface LivePaneResizeTarget {
  readonly status: "live";
  readonly daemonGeneration: string;
  readonly workspaceName: string;
  readonly connection: object;
  readonly clientGeneration: number;
  readonly rendererEpoch: number;
  readonly client: PaneResizeClient;
}

export type PaneResizeFailure = Readonly<{
  stage: "authority-request" | "pre-dispatch" | "dispatch" | "post-dispatch" | "receipt";
  reason:
    | "authority-rejected"
    | "generation-replaced"
    | "operation-timeout"
    | "transport-rejected"
    | "receipt-invalid";
}>;

export type PaneResizeReceipt = Readonly<{
  operationId: string;
  semanticPaneId: string;
  axis: "cols" | "rows";
  requestedCells: number;
  cells: number;
  outcome: "applied" | "unchanged";
}>;

/** Exact generation-fenced pane resize; diagnostics never own the mutation. */
export async function resizeTerminalPane(
  expected: LivePaneResizeTarget,
  current: () => LivePaneResizeTarget | null,
  input: Readonly<{
    operationId: string;
    semanticPaneId: string;
    axis: "cols" | "rows";
    cells: number;
  }>,
  onFailure?: (failure: PaneResizeFailure) => void,
): Promise<PaneResizeReceipt | null> {
  const fail = (failure: PaneResizeFailure): null => {
    try {
      onFailure?.(failure);
    } catch {
      // Failure diagnostics are optional and fail open.
    }
    return null;
  };
  const isCurrent = (): boolean => {
    const active = current();
    return (
      active?.status === "live" &&
      active.client === expected.client &&
      active.connection === expected.connection &&
      active.clientGeneration === expected.clientGeneration &&
      active.rendererEpoch === expected.rendererEpoch &&
      active.daemonGeneration === expected.daemonGeneration &&
      active.workspaceName === expected.workspaceName
    );
  };
  const transport = (stage: PaneResizeFailure["stage"], error: unknown): null => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
    return fail({
      stage,
      reason: code === "operation-timeout" ? "operation-timeout" : "transport-rejected",
    });
  };
  try {
    if (expected.client.ownsRuntimeAuthority?.("geometry") !== true) {
      let lease;
      try {
        lease = await expected.client.requestAuthority("geometry");
      } catch (error) {
        return transport("authority-request", error);
      }
      if (!lease) return fail({ stage: "authority-request", reason: "authority-rejected" });
      if (!isCurrent()) return fail({ stage: "authority-request", reason: "generation-replaced" });
    }
    if (!isCurrent()) return fail({ stage: "pre-dispatch", reason: "generation-replaced" });
    let response: unknown;
    try {
      response = await expected.client.dispatch({
        kind: "semantic-intent",
        operationId: input.operationId,
        intent: {
          verb: "workspace.pane.resize",
          workspaceName: expected.workspaceName,
          semanticPaneId: input.semanticPaneId,
          axis: input.axis,
          cells: input.cells,
        },
      });
    } catch (error) {
      return transport("dispatch", error);
    }
    if (!isCurrent()) return fail({ stage: "post-dispatch", reason: "generation-replaced" });
    const wrapper = response as Record<string, unknown>;
    const result = wrapper.result as Record<string, unknown> | undefined;
    if (
      wrapper.kind !== "semantic-intent" ||
      wrapper.operationId !== input.operationId ||
      !result ||
      result.operationId !== input.operationId ||
      result.verb !== "workspace.pane.resize" ||
      result.daemonInstanceId !== expected.daemonGeneration ||
      result.workspaceName !== expected.workspaceName ||
      result.semanticPaneId !== input.semanticPaneId ||
      result.axis !== input.axis ||
      !Number.isSafeInteger(result.cells) ||
      Number(result.cells) <= 0 ||
      !["applied", "unchanged"].includes(String(result.outcome))
    )
      return fail({ stage: "receipt", reason: "receipt-invalid" });
    return Object.freeze({
      operationId: input.operationId,
      semanticPaneId: input.semanticPaneId,
      axis: input.axis,
      requestedCells: input.cells,
      cells: Number(result.cells),
      outcome: result.outcome as "applied" | "unchanged",
    });
  } catch (error) {
    return transport("dispatch", error);
  }
}
