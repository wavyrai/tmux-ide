import {
  WorkspacePaneCreationReferenceSchemaZ,
  WorkspacePaneCreationWorkspaceNameSchemaZ,
  type WorkspacePaneCreationPlacement,
} from "@tmux-ide/contracts";

export interface ProvisioningWorkspaceCandidate {
  readonly name: string;
  readonly label: string;
  readonly available: boolean;
}

export type ProvisioningTarget =
  | {
      readonly id: string;
      readonly kind: "pane";
      readonly workspaceName: string;
      readonly semanticPaneId: string;
      readonly label: string;
      readonly description: string;
      readonly available: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "workspace";
      readonly workspaceName: string;
      readonly semanticPaneId: null;
      readonly label: string;
      readonly description: string;
      readonly available: boolean;
    };

export interface ProvisioningCurrentTarget {
  readonly workspaceName: string;
  readonly semanticPaneId?: string | null;
  readonly paneLabel?: string;
}

/**
 * Build the renderer-neutral first step of agent/terminal provisioning.
 * Current-pane placement is first, followed by one new-window target per
 * workspace. Runtime tmux ids, directories, and commands never enter it.
 */
export function projectProvisioningTargets(
  workspaces: readonly ProvisioningWorkspaceCandidate[],
  current?: ProvisioningCurrentTarget,
): readonly ProvisioningTarget[] {
  const valid = workspaces.filter(
    (workspace) =>
      WorkspacePaneCreationWorkspaceNameSchemaZ.safeParse(workspace.name).success &&
      workspace.label.trim().length > 0,
  );
  const byName = new Map(valid.map((workspace) => [workspace.name, workspace]));
  const targets: ProvisioningTarget[] = [];
  const currentWorkspace = current ? byName.get(current.workspaceName) : undefined;
  if (
    currentWorkspace?.available &&
    current?.semanticPaneId &&
    WorkspacePaneCreationReferenceSchemaZ.safeParse(current.semanticPaneId).success
  ) {
    targets.push({
      id: `pane:${current.semanticPaneId}`,
      kind: "pane",
      workspaceName: currentWorkspace.name,
      semanticPaneId: current.semanticPaneId,
      label: current.paneLabel?.trim() || "Beside active pane",
      description: `Split right in ${currentWorkspace.label}`,
      available: true,
    });
  }
  const ordered = [...valid].sort((left, right) => {
    if (left.name === current?.workspaceName) return -1;
    if (right.name === current?.workspaceName) return 1;
    return left.label.localeCompare(right.label);
  });
  for (const workspace of ordered) {
    targets.push({
      id: `workspace:${workspace.name}`,
      kind: "workspace",
      workspaceName: workspace.name,
      semanticPaneId: null,
      label: workspace.label,
      description: "Open as a new tmux window",
      available: workspace.available,
    });
  }
  return Object.freeze(targets.map((target) => Object.freeze(target)));
}

/** One target policy shared by GUI and TUI daemon provisioning. */
export function provisioningPlacementForTarget(
  target: Pick<ProvisioningTarget, "kind" | "semanticPaneId">,
  splitDirection: "right" | "down" = "right",
): WorkspacePaneCreationPlacement {
  return target.kind === "pane"
    ? {
        kind: "split",
        direction: splitDirection,
        targetSemanticPaneId: target.semanticPaneId!,
      }
    : { kind: "window" };
}

export type TargetFirstProvisioningStage = "target" | "kind" | "details";

export function targetFirstProvisioningStage(
  target: ProvisioningTarget | null,
  kind: "terminal" | "agent" | null,
): TargetFirstProvisioningStage {
  if (!target) return "target";
  return kind ? "details" : "kind";
}
