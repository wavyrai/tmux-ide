import {
  WorkspaceAgentRoleSchemaZ,
  WorkspacePaneDisplayTitleSchemaZ,
  WorkspacePaneCreationReferenceSchemaZ,
  WorkspacePaneCreationWorkspaceNameSchemaZ,
  workspacePaneCreateInvocation,
  type CommandSource,
  type WorkspaceAgentRole,
  type WorkspacePaneCreateInvocation,
} from "@tmux-ide/contracts";

export type CreatePaneKind = "terminal" | "agent";

export interface CreatePaneWorkspaceOption {
  readonly name: string;
  readonly label: string;
  readonly available: boolean;
}

export interface CreatePaneHarnessOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly available: boolean;
}

export interface CreatePaneMissionOption {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
}

export type CreatePaneCatalogState<Item> =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly items: readonly Item[] };

export interface CreatePaneFlowCatalogs {
  readonly workspaces: CreatePaneCatalogState<CreatePaneWorkspaceOption>;
  readonly harnessProfiles: CreatePaneCatalogState<CreatePaneHarnessOption>;
  readonly missions: CreatePaneCatalogState<CreatePaneMissionOption>;
}

interface ProjectedCatalog<Item> {
  readonly status: CreatePaneCatalogState<Item>["status"];
  readonly items: readonly Item[];
  readonly invalidOptionCount: number;
}

export interface CreatePaneFlowProjection {
  readonly workspaces: ProjectedCatalog<CreatePaneWorkspaceOption>;
  readonly harnessProfiles: ProjectedCatalog<CreatePaneHarnessOption>;
  readonly missions: ProjectedCatalog<CreatePaneMissionOption>;
  readonly roles: readonly WorkspaceAgentRole[];
}

export interface CreatePaneDraft {
  readonly kind: CreatePaneKind;
  readonly workspaceName: string;
  readonly displayTitle: string;
  readonly harnessProfileId: string;
  readonly role: WorkspaceAgentRole;
  readonly missionId: string;
}

export type CreatePaneField =
  | "workspaceName"
  | "displayTitle"
  | "harnessProfileId"
  | "role"
  | "missionId";

export type CreatePaneFieldErrors = Readonly<Partial<Record<CreatePaneField, string>>>;

export type CreatePaneSubmission =
  | {
      readonly ok: true;
      readonly invocation: WorkspacePaneCreateInvocation;
    }
  | {
      readonly ok: false;
      readonly errors: CreatePaneFieldErrors;
      readonly firstInvalidField: CreatePaneField;
    };

const ROLES = Object.freeze([
  "manager",
  "implementer",
  "reviewer",
  "researcher",
  "validator",
] as const satisfies readonly WorkspaceAgentRole[]);

function frozen<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) frozen(nested);
  }
  return value;
}

function validLabel(value: string): boolean {
  const containsControl = [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
  return value === value.trim() && value.length >= 1 && value.length <= 120 && !containsControl;
}

function emptyCatalog<Item>(status: "loading" | "unavailable"): ProjectedCatalog<Item> {
  return frozen({ status, items: [], invalidOptionCount: 0 });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function projectWorkspaceCatalog(
  catalog: CreatePaneCatalogState<CreatePaneWorkspaceOption>,
): ProjectedCatalog<CreatePaneWorkspaceOption> {
  if (catalog.status !== "ready") {
    return emptyCatalog(catalog.status);
  }
  if (!Array.isArray(catalog.items)) {
    return frozen({ status: "ready", items: [], invalidOptionCount: 1 });
  }

  const names = new Set<string>();
  const items: CreatePaneWorkspaceOption[] = [];
  let invalidOptionCount = 0;
  for (const candidate of catalog.items as readonly unknown[]) {
    const item = asRecord(candidate);
    if (
      !item ||
      typeof item.name !== "string" ||
      !WorkspacePaneCreationWorkspaceNameSchemaZ.safeParse(item.name).success ||
      typeof item.label !== "string" ||
      !validLabel(item.label) ||
      typeof item.available !== "boolean" ||
      names.has(item.name)
    ) {
      invalidOptionCount += 1;
      continue;
    }
    names.add(item.name);
    items.push({ name: item.name, label: item.label, available: item.available });
  }
  return frozen({ status: "ready", items, invalidOptionCount });
}

function projectHarnessCatalog(
  catalog: CreatePaneCatalogState<CreatePaneHarnessOption>,
): ProjectedCatalog<CreatePaneHarnessOption> {
  if (catalog.status !== "ready") return emptyCatalog(catalog.status);
  if (!Array.isArray(catalog.items)) {
    return frozen({ status: "ready", items: [], invalidOptionCount: 1 });
  }
  const ids = new Set<string>();
  const items: CreatePaneHarnessOption[] = [];
  let invalidOptionCount = 0;
  for (const candidate of catalog.items as readonly unknown[]) {
    const item = asRecord(candidate);
    if (
      !item ||
      typeof item.id !== "string" ||
      !WorkspacePaneCreationReferenceSchemaZ.safeParse(item.id).success ||
      typeof item.label !== "string" ||
      !validLabel(item.label) ||
      typeof item.available !== "boolean" ||
      ids.has(item.id) ||
      ("description" in item &&
        item.description !== undefined &&
        (typeof item.description !== "string" || !validLabel(item.description)))
    ) {
      invalidOptionCount += 1;
      continue;
    }
    ids.add(item.id);
    items.push({
      id: item.id,
      label: item.label,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      available: item.available,
    });
  }
  return frozen({ status: "ready", items, invalidOptionCount });
}

function projectMissionCatalog(
  catalog: CreatePaneCatalogState<CreatePaneMissionOption>,
): ProjectedCatalog<CreatePaneMissionOption> {
  if (catalog.status !== "ready") return emptyCatalog(catalog.status);
  if (!Array.isArray(catalog.items)) {
    return frozen({ status: "ready", items: [], invalidOptionCount: 1 });
  }
  const ids = new Set<string>();
  const items: CreatePaneMissionOption[] = [];
  let invalidOptionCount = 0;
  for (const candidate of catalog.items as readonly unknown[]) {
    const item = asRecord(candidate);
    if (
      !item ||
      typeof item.id !== "string" ||
      !WorkspacePaneCreationReferenceSchemaZ.safeParse(item.id).success ||
      typeof item.label !== "string" ||
      !validLabel(item.label) ||
      typeof item.available !== "boolean" ||
      ids.has(item.id)
    ) {
      invalidOptionCount += 1;
      continue;
    }
    ids.add(item.id);
    items.push({ id: item.id, label: item.label, available: item.available });
  }
  return frozen({ status: "ready", items, invalidOptionCount });
}

/** Pure, defensive catalog projection consumed by the Solid dialog. */
export function projectCreatePaneFlow(catalogs: CreatePaneFlowCatalogs): CreatePaneFlowProjection {
  return frozen({
    workspaces: projectWorkspaceCatalog(catalogs.workspaces),
    harnessProfiles: projectHarnessCatalog(catalogs.harnessProfiles),
    missions: projectMissionCatalog(catalogs.missions),
    roles: ROLES,
  });
}

function selectedAvailable<Item extends { readonly id: string; readonly available: boolean }>(
  catalog: ProjectedCatalog<Item>,
  id: string,
): boolean {
  return (
    catalog.status === "ready" && catalog.items.some((item) => item.id === id && item.available)
  );
}

function workspaceError(
  projection: CreatePaneFlowProjection,
  workspaceName: string,
): string | undefined {
  if (projection.workspaces.status === "loading") return "Workspace choices are still loading.";
  if (projection.workspaces.status === "unavailable") return "Workspace choices are unavailable.";
  if (projection.workspaces.items.length === 0) return "No workspace is available yet.";
  if (!workspaceName) return "Choose a workspace.";
  if (
    projection.workspaces.status !== "ready" ||
    !projection.workspaces.items.some((item) => item.name === workspaceName && item.available)
  ) {
    return "Choose an available workspace.";
  }
  return undefined;
}

/**
 * Build the sole command callback payload. Exact catalog membership is checked
 * here before shared contract validation, so typed input cannot forge a hidden
 * workspace, harness, or mission identity.
 */
export function createPaneSubmission(
  projection: CreatePaneFlowProjection,
  draft: CreatePaneDraft,
  source: CommandSource,
): CreatePaneSubmission {
  const errors: Partial<Record<CreatePaneField, string>> = {};
  const workspace = workspaceError(projection, draft.workspaceName);
  if (workspace) errors.workspaceName = workspace;

  const displayTitle = draft.displayTitle.trim();
  if (displayTitle && !WorkspacePaneDisplayTitleSchemaZ.safeParse(displayTitle).success) {
    errors.displayTitle = "Use 80 characters or fewer without control characters.";
  }

  if (draft.kind === "agent") {
    if (projection.harnessProfiles.status === "loading") {
      errors.harnessProfileId = "Agent profiles are still loading.";
    } else if (projection.harnessProfiles.status === "unavailable") {
      errors.harnessProfileId = "Agent profiles are unavailable.";
    } else if (projection.harnessProfiles.items.length === 0) {
      errors.harnessProfileId = "No agent profile is available yet.";
    } else if (!draft.harnessProfileId) {
      errors.harnessProfileId = "Choose an agent profile.";
    } else if (!selectedAvailable(projection.harnessProfiles, draft.harnessProfileId)) {
      errors.harnessProfileId = "Choose an available agent profile.";
    }

    if (!WorkspaceAgentRoleSchemaZ.safeParse(draft.role).success) {
      errors.role = "Choose a supported role.";
    }
    if (
      draft.missionId &&
      (projection.missions.status !== "ready" ||
        !selectedAvailable(projection.missions, draft.missionId))
    ) {
      errors.missionId = "Choose an available mission or leave it unassigned.";
    }
  }

  const fieldOrder: readonly CreatePaneField[] = [
    "workspaceName",
    "displayTitle",
    "harnessProfileId",
    "role",
    "missionId",
  ];
  const firstInvalidField = fieldOrder.find((field) => errors[field]);
  if (firstInvalidField) {
    return frozen({ ok: false, errors, firstInvalidField });
  }

  const common = {
    workspaceName: draft.workspaceName,
    ...(displayTitle ? { displayTitle } : {}),
  };
  const invocation =
    draft.kind === "terminal"
      ? workspacePaneCreateInvocation({ kind: "terminal", ...common }, source)
      : workspacePaneCreateInvocation(
          {
            kind: "agent",
            ...common,
            harnessProfileId: draft.harnessProfileId,
            role: draft.role,
            ...(draft.missionId ? { missionId: draft.missionId } : {}),
          },
          source,
        );
  return frozen({ ok: true, invocation });
}
