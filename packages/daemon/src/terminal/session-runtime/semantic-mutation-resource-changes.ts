import {
  WorkspaceMultiplexerMutationResultSchemaZ,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";

export interface SemanticMutationResourceChange {
  readonly workspaceName: string | null;
  readonly resource:
    | "application-shell"
    | "workspace-missions"
    | "fleet-catalog"
    | "workspace-catalog";
  readonly causeOperationId: string;
}

/** One shared invalidation projection for HTTP and hosted semantic mutations. */
export function semanticMutationResourceChanges(
  raw: WorkspaceMultiplexerMutationResult | unknown,
): readonly SemanticMutationResourceChange[] {
  const parsed = WorkspaceMultiplexerMutationResultSchemaZ.safeParse(raw);
  if (!parsed.success || parsed.data.outcome !== "applied") return [];
  const result = parsed.data;
  if (result.verb === "workspace.pane.send") return [];
  const base = {
    workspaceName: result.workspaceName,
    causeOperationId: result.operationId,
  } as const;
  const changes: SemanticMutationResourceChange[] = [
    { ...base, resource: "application-shell" },
    { ...base, resource: "workspace-missions" },
  ];
  if (
    result.verb === "workspace.window.split" ||
    result.verb === "workspace.window.kill" ||
    result.verb === "workspace.pane.kill" ||
    result.verb === "workspace.session.kill"
  ) {
    changes.push({ ...base, workspaceName: null, resource: "fleet-catalog" });
  }
  if (result.verb === "workspace.session.kill") {
    changes.push({ ...base, workspaceName: null, resource: "workspace-catalog" });
  }
  if (result.verb === "workspace.rename" && result.scope === "session") {
    changes.push({ ...base, workspaceName: null, resource: "fleet-catalog" });
    changes.push({ ...base, workspaceName: null, resource: "workspace-catalog" });
  }
  return Object.freeze(changes.map((change) => Object.freeze(change)));
}
