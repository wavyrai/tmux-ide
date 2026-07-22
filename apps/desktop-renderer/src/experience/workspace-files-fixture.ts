import {
  flattenWorkspaceFileTree,
  type WorkspaceFileEntry,
  type WorkspaceFileTreeCatalog,
  type WorkspaceFileTreeView,
} from "@tmux-ide/contracts";

import type { FilesPreviewModel, FilesSurfaceModel } from "./workspace-files-surface.tsx";

/**
 * Illustrative file-tree fixtures. Catalogs are folded through the real
 * `flattenWorkspaceFileTree` projection so the surface renders exactly what the
 * store will produce at runtime.
 */

const ROOT_ID = "file.root00000000000000";
const SRC_ID = "file.src000000000000000";
const COMPONENTS_ID = "file.components00000000";

function entry(partial: Partial<WorkspaceFileEntry> & Pick<WorkspaceFileEntry, "id" | "parentId" | "name" | "relativePath" | "kind">): WorkspaceFileEntry {
  return {
    hidden: false,
    ignored: false,
    hasChildren: false,
    gitStatus: null,
    ...partial,
  };
}

const ROOT_CATALOG: WorkspaceFileTreeCatalog = {
  directoryId: ROOT_ID,
  entries: [
    entry({
      id: SRC_ID,
      parentId: ROOT_ID,
      name: "src",
      relativePath: "src",
      kind: "directory",
      hasChildren: true,
    }),
    entry({
      id: "file.node_modules0000000",
      parentId: ROOT_ID,
      name: "node_modules",
      relativePath: "node_modules",
      kind: "directory",
      hasChildren: true,
      ignored: true,
    }),
    entry({
      id: "file.readme000000000000",
      parentId: ROOT_ID,
      name: "README.md",
      relativePath: "README.md",
      kind: "file",
      gitStatus: "modified",
    }),
    entry({
      id: "file.envfile0000000000",
      parentId: ROOT_ID,
      name: ".env",
      relativePath: ".env",
      kind: "file",
      hidden: true,
    }),
  ],
};

const SRC_CATALOG: WorkspaceFileTreeCatalog = {
  directoryId: SRC_ID,
  entries: [
    entry({
      id: COMPONENTS_ID,
      parentId: SRC_ID,
      name: "components",
      relativePath: "src/components",
      kind: "directory",
      hasChildren: true,
    }),
    entry({
      id: "file.srcindex0000000000",
      parentId: SRC_ID,
      name: "index.ts",
      relativePath: "src/index.ts",
      kind: "file",
      gitStatus: "added",
    }),
    entry({
      id: "file.srcapp00000000000",
      parentId: SRC_ID,
      name: "app.tsx",
      relativePath: "src/app.tsx",
      kind: "file",
      gitStatus: "modified",
    }),
  ],
};

/** Root + src loaded, components expanded but its catalog is not loaded yet. */
export function createFilesTreeView(): WorkspaceFileTreeView {
  return flattenWorkspaceFileTree({
    rootId: ROOT_ID,
    catalogs: [ROOT_CATALOG, SRC_CATALOG],
    expandedIds: [SRC_ID, COMPONENTS_ID],
    selectedId: "file.srcindex0000000000",
  });
}

export const FILES_SELECTED_ID = "file.srcindex0000000000";
export const FILES_COMPONENTS_ID = COMPONENTS_ID;
export const FILES_SRC_ID = SRC_ID;

export function createFilesReadyModel(): FilesSurfaceModel {
  return {
    kind: "ready",
    workspaceName: "tmux-ide",
    view: createFilesTreeView(),
    totalEntries: 214,
  };
}

/** A ready model whose root catalog is empty. */
export function createFilesEmptyModel(): FilesSurfaceModel {
  return {
    kind: "ready",
    workspaceName: "tmux-ide",
    view: flattenWorkspaceFileTree({
      rootId: ROOT_ID,
      catalogs: [{ directoryId: ROOT_ID, entries: [] }],
    }),
  };
}

export function createFilesTruncatedModel(): FilesSurfaceModel {
  const view = createFilesTreeView();
  return {
    kind: "ready",
    workspaceName: "tmux-ide",
    view: { ...view, truncated: true },
    totalEntries: 20_512,
  };
}

export function createFilesUnavailableModel(): FilesSurfaceModel {
  return {
    kind: "unavailable",
    reason: "The workspace is not reachable from the desktop host.",
    retryable: true,
  };
}

export function createFilesPreviewReady(): FilesPreviewModel {
  return {
    kind: "ready",
    name: "index.ts",
    relativePath: "src/index.ts",
    languageHint: "typescript",
    content: [
      "export function main(): void {",
      '  console.log("tmux-ide");',
      "}",
      "",
      "main();",
    ].join("\n"),
    totalLines: 5,
    truncated: false,
  };
}

export function createFilesPreviewTruncated(): FilesPreviewModel {
  return {
    kind: "ready",
    name: "log.txt",
    relativePath: "src/log.txt",
    languageHint: null,
    content: ["line 1", "line 2", "line 3"].join("\n"),
    totalLines: 90_000,
    truncated: true,
  };
}

export function createFilesPreviewBinary(): FilesPreviewModel {
  return {
    kind: "binary",
    name: "logo.png",
    relativePath: "assets/logo.png",
    totalBytes: 48_211,
    mediaType: "image/png",
  };
}

export function createFilesPreviewUnavailable(): FilesPreviewModel {
  return {
    kind: "unavailable",
    name: "secret.key",
    relativePath: "src/secret.key",
    reason: "Reading this file was denied by the operating system.",
    retryable: true,
  };
}
