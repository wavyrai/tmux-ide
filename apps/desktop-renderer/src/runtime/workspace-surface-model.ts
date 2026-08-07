import {
  flattenWorkspaceChangesView,
  flattenWorkspaceFileTree,
  type DesktopDaemonCapabilityErrorCode,
  type WorkspaceChangeEntry,
  type WorkspaceChangeResourceId,
  type WorkspaceFileEntry,
  type WorkspaceFileResourceId,
  type WorkspaceFileTreeCatalog,
} from "@tmux-ide/contracts";

import type {
  ChangesDiffModel,
  ChangesSurfaceModel,
} from "../experience/workspace-changes-surface.tsx";
import type {
  FilesPreviewModel,
  FilesSurfaceModel,
} from "../experience/workspace-files-surface.tsx";
import type {
  WorkspaceChangeDiffState,
  WorkspaceChangesCatalogState,
} from "./workspace-changes-store.ts";
import type {
  WorkspaceFilePreviewState,
  WorkspaceFilesCatalogState,
} from "./workspace-files-store.ts";

/**
 * Pure folds from the generation-bound Files and Changes read stores onto the
 * presentational dock-surface models. Every store state — loading, a typed
 * unavailable resource, a transport/protocol error, or a stale-generation
 * drop — maps onto an honest surface kind. Nothing here performs I/O or holds
 * the daemon endpoint; the composition owns expansion and selection and passes
 * them in.
 */

/**
 * A store-level transport or protocol error is worth a plain reload except when
 * the failure is inherent to this generation or request (a mismatched daemon,
 * an invalid target, a disposed store, or a preview-only transport).
 */
export function storeErrorRetryable(code: DesktopDaemonCapabilityErrorCode): boolean {
  return (
    code !== "daemon-identity-mismatch" &&
    code !== "invalid-request" &&
    code !== "disposed" &&
    code !== "preview-only"
  );
}

/** Folds every loaded directory catalog into the tree projection inputs. */
export function collectFileCatalogs(state: WorkspaceFilesCatalogState): {
  readonly rootId: WorkspaceFileResourceId | null;
  readonly catalogs: WorkspaceFileTreeCatalog[];
  readonly entriesById: Map<WorkspaceFileResourceId, WorkspaceFileEntry>;
} {
  const catalogs: WorkspaceFileTreeCatalog[] = [];
  const entriesById = new Map<WorkspaceFileResourceId, WorkspaceFileEntry>();
  const absorb = (slot: WorkspaceFilesCatalogState["root"]): void => {
    if (slot?.status !== "loaded" || slot.resource.status !== "ready") return;
    catalogs.push({ directoryId: slot.resource.directory.id, entries: slot.resource.entries });
    for (const entry of slot.resource.entries) entriesById.set(entry.id, entry);
  };
  absorb(state.root);
  for (const slot of state.directories.values()) absorb(slot);
  return { rootId: state.rootId, catalogs, entriesById };
}

export function filesSurfaceModel(
  state: WorkspaceFilesCatalogState,
  workspaceName: string,
  expandedIds: ReadonlySet<WorkspaceFileResourceId>,
  selectedId: WorkspaceFileResourceId | null,
): FilesSurfaceModel {
  const root = state.root;
  if (root === null || root.status === "loading") return { kind: "loading" };
  if (root.status === "error") {
    return { kind: "unavailable", reason: root.reason, retryable: storeErrorRetryable(root.code) };
  }
  if (root.resource.status === "unavailable") {
    return {
      kind: "unavailable",
      reason: root.resource.message,
      retryable: root.resource.retryable,
    };
  }
  const { rootId, catalogs } = collectFileCatalogs(state);
  if (rootId === null) return { kind: "loading" };
  return {
    kind: "ready",
    workspaceName,
    view: flattenWorkspaceFileTree({ rootId, catalogs, expandedIds, selectedId }),
    totalEntries: root.resource.totalEntries,
  };
}

export function filePreviewSurfaceModel(
  state: WorkspaceFilePreviewState,
  entriesById: ReadonlyMap<WorkspaceFileResourceId, WorkspaceFileEntry>,
): FilesPreviewModel {
  if (state.status === "idle") return { kind: "absent" };
  const known = state.fileId ? (entriesById.get(state.fileId) ?? null) : null;
  if (state.status === "loading") {
    return {
      kind: "loading",
      name: known?.name ?? "File",
      relativePath: known?.relativePath ?? "",
    };
  }
  if (state.status === "error") {
    return {
      kind: "unavailable",
      name: known?.name ?? null,
      relativePath: known?.relativePath ?? null,
      reason: state.reason,
      retryable: storeErrorRetryable(state.code),
    };
  }
  const resource = state.resource;
  switch (resource.status) {
    case "ready":
      return {
        kind: "ready",
        name: resource.name,
        relativePath: resource.relativePath,
        content: resource.content,
        languageHint: resource.languageHint,
        totalLines: resource.totalLines,
        truncated: resource.truncated,
      };
    case "binary":
      return {
        kind: "binary",
        name: resource.name,
        relativePath: resource.relativePath,
        totalBytes: resource.totalBytes,
        mediaType: resource.mediaType,
      };
    case "too-large":
      return {
        kind: "too-large",
        name: resource.name,
        relativePath: resource.relativePath,
        totalBytes: resource.totalBytes,
        limitBytes: resource.limitBytes,
      };
    case "unavailable":
      return {
        kind: "unavailable",
        name: known?.name ?? null,
        relativePath: known?.relativePath ?? null,
        reason: resource.message,
        retryable: resource.retryable,
      };
  }
}

export function changesSurfaceModel(
  state: WorkspaceChangesCatalogState,
  selectedId: WorkspaceChangeResourceId | null,
): ChangesSurfaceModel {
  if (state.status === "loading") return { kind: "loading" };
  if (state.status === "error") {
    return {
      kind: "unavailable",
      reason: state.reason,
      retryable: storeErrorRetryable(state.code),
    };
  }
  const resource = state.resource;
  if (resource.status === "unavailable") {
    return { kind: "unavailable", reason: resource.message, retryable: resource.retryable };
  }
  return {
    kind: "ready",
    branch: resource.branch,
    detached: resource.detached,
    view: flattenWorkspaceChangesView({ entries: resource.entries, selectedId }),
    truncated: resource.truncated,
    totalEntries: resource.totalEntries,
  };
}

export function changeDiffSurfaceModel(
  state: WorkspaceChangeDiffState,
  entriesById: ReadonlyMap<WorkspaceChangeResourceId, WorkspaceChangeEntry>,
): ChangesDiffModel {
  if (state.status === "idle") return { kind: "absent" };
  const known = state.changeId ? (entriesById.get(state.changeId) ?? null) : null;
  if (state.status === "loading") {
    return { kind: "loading", relativePath: known?.relativePath ?? "" };
  }
  if (state.status === "error") {
    return {
      kind: "unavailable",
      relativePath: known?.relativePath ?? null,
      reason: state.reason,
      retryable: storeErrorRetryable(state.code),
    };
  }
  const resource = state.resource;
  switch (resource.status) {
    case "ready":
      return {
        kind: "ready",
        relativePath: resource.relativePath,
        originPath: resource.originPath,
        hunks: resource.hunks,
        totalHunks: resource.totalHunks,
        totalLines: resource.totalLines,
        truncated: resource.truncated,
      };
    case "binary":
      return {
        kind: "binary",
        relativePath: resource.relativePath,
        oldBytes: resource.oldBytes,
        newBytes: resource.newBytes,
      };
    case "too-large":
      return {
        kind: "too-large",
        relativePath: resource.relativePath,
        totalBytes: resource.totalBytes,
        limitBytes: resource.limitBytes,
      };
    case "unavailable":
      return {
        kind: "unavailable",
        relativePath: known?.relativePath ?? null,
        reason: resource.message,
        retryable: resource.retryable,
      };
  }
}

export function changeEntriesById(
  state: WorkspaceChangesCatalogState,
): Map<WorkspaceChangeResourceId, WorkspaceChangeEntry> {
  const entriesById = new Map<WorkspaceChangeResourceId, WorkspaceChangeEntry>();
  if (state.status === "loaded" && state.resource.status === "ready") {
    for (const entry of state.resource.entries) entriesById.set(entry.id, entry);
  }
  return entriesById;
}
