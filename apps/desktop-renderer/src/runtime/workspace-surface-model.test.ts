import { describe, expect, it } from "vitest";
import type {
  WorkspaceChangeDiffResourceV1,
  WorkspaceChangeEntry,
  WorkspaceChangeResourceId,
  WorkspaceChangesCatalogResourceV1,
  WorkspaceFileEntry,
  WorkspaceFilePreviewResourceV1,
  WorkspaceFileResourceId,
  WorkspaceFilesCatalogResourceV1,
} from "@tmux-ide/contracts";

import type {
  WorkspaceChangeDiffState,
  WorkspaceChangesCatalogState,
} from "./workspace-changes-store.ts";
import type {
  WorkspaceFilePreviewState,
  WorkspaceFilesCatalogState,
} from "./workspace-files-store.ts";
import {
  changeDiffSurfaceModel,
  changeEntriesById,
  changesSurfaceModel,
  collectFileCatalogs,
  filePreviewSurfaceModel,
  filesSurfaceModel,
  storeErrorRetryable,
} from "./workspace-surface-model.ts";

const ROOT_ID = "file.root0000000000000" as WorkspaceFileResourceId;
const SRC_ID = "file.src00000000000000" as WorkspaceFileResourceId;
const INDEX_ID = "file.index000000000000" as WorkspaceFileResourceId;

function fileEntry(
  partial: Partial<WorkspaceFileEntry> & Pick<WorkspaceFileEntry, "id" | "name">,
): WorkspaceFileEntry {
  return {
    id: partial.id,
    parentId: ROOT_ID,
    name: partial.name,
    relativePath: partial.relativePath ?? partial.name,
    kind: partial.kind ?? "file",
    hidden: partial.hidden ?? false,
    ignored: partial.ignored ?? false,
    hasChildren: partial.hasChildren ?? false,
    gitStatus: partial.gitStatus ?? null,
  } as WorkspaceFileEntry;
}

function rootCatalogReady(entries: WorkspaceFileEntry[]): WorkspaceFilesCatalogResourceV1 {
  return {
    status: "ready",
    workspaceName: "alpha",
    revision: "rev-root",
    rootId: ROOT_ID,
    directory: { id: ROOT_ID, name: "alpha", relativePath: null, parentId: null },
    breadcrumbs: [{ id: ROOT_ID, label: "alpha" }],
    entries,
    totalEntries: entries.length,
    truncated: false,
  } as unknown as WorkspaceFilesCatalogResourceV1;
}

function filesState(root: WorkspaceFilesCatalogState["root"]): WorkspaceFilesCatalogState {
  return { generation: 1, target: null, rootId: ROOT_ID, root, directories: new Map() };
}

describe("storeErrorRetryable", () => {
  it("treats transport failures as retryable and generation faults as terminal", () => {
    expect(storeErrorRetryable("request-failed")).toBe(true);
    expect(storeErrorRetryable("invalid-response")).toBe(true);
    expect(storeErrorRetryable("request-timeout")).toBe(true);
    expect(storeErrorRetryable("daemon-identity-mismatch")).toBe(false);
    expect(storeErrorRetryable("invalid-request")).toBe(false);
    expect(storeErrorRetryable("disposed")).toBe(false);
    expect(storeErrorRetryable("preview-only")).toBe(false);
  });
});

describe("filesSurfaceModel", () => {
  it("maps a missing or loading root to loading", () => {
    expect(filesSurfaceModel(filesState(null), "alpha", new Set(), null).kind).toBe("loading");
    expect(
      filesSurfaceModel(filesState({ status: "loading" }), "alpha", new Set(), null).kind,
    ).toBe("loading");
  });

  it("maps a transport error to an honest, code-driven retryable state", () => {
    const model = filesSurfaceModel(
      filesState({ status: "error", code: "request-failed", reason: "boom", stale: null }),
      "alpha",
      new Set(),
      null,
    );
    expect(model).toEqual({ kind: "unavailable", reason: "boom", retryable: true });
    const mismatch = filesSurfaceModel(
      filesState({
        status: "error",
        code: "daemon-identity-mismatch",
        reason: "stale",
        stale: null,
      }),
      "alpha",
      new Set(),
      null,
    );
    expect(mismatch).toEqual({ kind: "unavailable", reason: "stale", retryable: false });
  });

  it("surfaces a typed unavailable catalog resource with its own retryability", () => {
    const resource = {
      status: "unavailable",
      workspaceName: "alpha",
      reason: "permission-denied",
      message: "The directory cannot be read.",
      retryable: false,
    } as unknown as WorkspaceFilesCatalogResourceV1;
    const model = filesSurfaceModel(
      filesState({ status: "loaded", resource, updatedAt: 0, refreshing: false }),
      "alpha",
      new Set(),
      null,
    );
    expect(model).toEqual({
      kind: "unavailable",
      reason: "The directory cannot be read.",
      retryable: false,
    });
  });

  it("folds a ready root and expanded child catalog into an ordered tree view", () => {
    const root = rootCatalogReady([
      fileEntry({ id: SRC_ID, name: "src", kind: "directory", hasChildren: true }),
      fileEntry({ id: INDEX_ID, name: "readme.md", gitStatus: "modified" }),
    ]);
    const childResource = {
      status: "ready",
      workspaceName: "alpha",
      revision: "rev-src",
      rootId: ROOT_ID,
      directory: { id: SRC_ID, name: "src", relativePath: "src", parentId: ROOT_ID },
      breadcrumbs: [
        { id: ROOT_ID, label: "alpha" },
        { id: SRC_ID, label: "src" },
      ],
      entries: [
        {
          id: "file.child0000000000" as WorkspaceFileResourceId,
          parentId: SRC_ID,
          name: "app.ts",
          relativePath: "src/app.ts",
          kind: "file",
          hidden: false,
          ignored: false,
          hasChildren: false,
          gitStatus: null,
        },
      ],
      totalEntries: 1,
      truncated: false,
    } as unknown as WorkspaceFilesCatalogResourceV1;
    const state: WorkspaceFilesCatalogState = {
      generation: 1,
      target: null,
      rootId: ROOT_ID,
      root: { status: "loaded", resource: root, updatedAt: 0, refreshing: false },
      directories: new Map([
        [SRC_ID, { status: "loaded", resource: childResource, updatedAt: 0, refreshing: false }],
      ]),
    };
    const model = filesSurfaceModel(state, "alpha", new Set([SRC_ID]), INDEX_ID);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") throw new Error("unreachable");
    expect(model.workspaceName).toBe("alpha");
    // Directory sorts before file, and the expanded child row is present.
    expect(model.view.rows.map((row) => row.name)).toEqual(["src", "app.ts", "readme.md"]);
    expect(model.view.rows.find((row) => row.name === "readme.md")?.selected).toBe(true);
  });

  it("collects only ready catalogs and ignores failed directory slots", () => {
    const root = rootCatalogReady([
      fileEntry({ id: SRC_ID, name: "src", kind: "directory", hasChildren: true }),
    ]);
    const state: WorkspaceFilesCatalogState = {
      generation: 1,
      target: null,
      rootId: ROOT_ID,
      root: { status: "loaded", resource: root, updatedAt: 0, refreshing: false },
      directories: new Map([
        [SRC_ID, { status: "error", code: "request-failed", reason: "no", stale: null }],
      ]),
    };
    const collected = collectFileCatalogs(state);
    expect(collected.catalogs).toHaveLength(1);
    expect(collected.entriesById.has(SRC_ID)).toBe(true);
  });
});

describe("filePreviewSurfaceModel", () => {
  const entries = new Map<WorkspaceFileResourceId, WorkspaceFileEntry>([
    [INDEX_ID, fileEntry({ id: INDEX_ID, name: "index.ts", relativePath: "src/index.ts" })],
  ]);

  it("maps idle to absent", () => {
    const state: WorkspaceFilePreviewState = {
      generation: 1,
      target: null,
      status: "idle",
      fileId: null,
    };
    expect(filePreviewSurfaceModel(state, entries)).toEqual({ kind: "absent" });
  });

  it("labels a loading preview from the known entry", () => {
    const state: WorkspaceFilePreviewState = {
      generation: 1,
      target: null,
      status: "loading",
      fileId: INDEX_ID,
    };
    expect(filePreviewSurfaceModel(state, entries)).toEqual({
      kind: "loading",
      name: "index.ts",
      relativePath: "src/index.ts",
    });
  });

  it("maps a ready preview resource", () => {
    const state: WorkspaceFilePreviewState = {
      generation: 1,
      target: null,
      status: "loaded",
      fileId: INDEX_ID,
      updatedAt: 0,
      refreshing: false,
      resource: {
        status: "ready",
        workspaceName: "alpha",
        catalogRevision: "rev",
        fileId: INDEX_ID,
        name: "index.ts",
        relativePath: "src/index.ts",
        encoding: "utf-8",
        languageHint: "typescript",
        content: "a\nb",
        totalBytes: 3,
        totalLines: 2,
        truncated: false,
      } as unknown as WorkspaceFilePreviewResourceV1,
    };
    expect(filePreviewSurfaceModel(state, entries)).toEqual({
      kind: "ready",
      name: "index.ts",
      relativePath: "src/index.ts",
      content: "a\nb",
      languageHint: "typescript",
      totalLines: 2,
      truncated: false,
    });
  });

  it("maps a transport error to an unavailable preview with the known path", () => {
    const state: WorkspaceFilePreviewState = {
      generation: 1,
      target: null,
      status: "error",
      fileId: INDEX_ID,
      code: "request-failed",
      reason: "The file preview request failed.",
      stale: null,
    };
    expect(filePreviewSurfaceModel(state, entries)).toEqual({
      kind: "unavailable",
      name: "index.ts",
      relativePath: "src/index.ts",
      reason: "The file preview request failed.",
      retryable: true,
    });
  });
});

const CHANGE_ID = "change.index0000000000" as WorkspaceChangeResourceId;

function changeEntry(): WorkspaceChangeEntry {
  return {
    id: CHANGE_ID,
    group: "staged",
    status: "modified",
    name: "index.ts",
    relativePath: "src/index.ts",
    originPath: null,
    binary: false,
    additions: 2,
    deletions: 1,
  } as WorkspaceChangeEntry;
}

function changesReady(): WorkspaceChangesCatalogResourceV1 {
  return {
    status: "ready",
    workspaceName: "alpha",
    revision: "rev",
    branch: "main",
    detached: false,
    entries: [changeEntry()],
    totalEntries: 1,
    truncated: false,
  } as unknown as WorkspaceChangesCatalogResourceV1;
}

describe("changesSurfaceModel", () => {
  it("maps loading and transport errors honestly", () => {
    expect(changesSurfaceModel({ generation: 1, target: null, status: "loading" }, null).kind).toBe(
      "loading",
    );
    expect(
      changesSurfaceModel(
        {
          generation: 1,
          target: null,
          status: "error",
          code: "request-failed",
          reason: "x",
          stale: null,
        },
        null,
      ),
    ).toEqual({ kind: "unavailable", reason: "x", retryable: true });
  });

  it("maps a not-a-git-repository resource to an unavailable state", () => {
    const resource = {
      status: "unavailable",
      workspaceName: "alpha",
      reason: "not-a-git-repository",
      message: "The workspace is not a git repository.",
      retryable: false,
    } as unknown as WorkspaceChangesCatalogResourceV1;
    const state: WorkspaceChangesCatalogState = {
      generation: 1,
      target: null,
      status: "loaded",
      resource,
      updatedAt: 0,
      refreshing: false,
    };
    expect(changesSurfaceModel(state, null)).toEqual({
      kind: "unavailable",
      reason: "The workspace is not a git repository.",
      retryable: false,
    });
  });

  it("folds a ready catalog into a grouped view", () => {
    const state: WorkspaceChangesCatalogState = {
      generation: 1,
      target: null,
      status: "loaded",
      resource: changesReady(),
      updatedAt: 0,
      refreshing: false,
    };
    const model = changesSurfaceModel(state, CHANGE_ID);
    expect(model.kind).toBe("ready");
    if (model.kind !== "ready") throw new Error("unreachable");
    expect(model.branch).toBe("main");
    expect(
      model.view.rows.some((row) => row.kind === "change" && row.entry?.id === CHANGE_ID),
    ).toBe(true);
    expect(changeEntriesById(state).get(CHANGE_ID)?.name).toBe("index.ts");
  });
});

describe("changeDiffSurfaceModel", () => {
  const entries = new Map<WorkspaceChangeResourceId, WorkspaceChangeEntry>([
    [CHANGE_ID, changeEntry()],
  ]);

  it("maps idle to absent and loading to a path-labelled state", () => {
    expect(
      changeDiffSurfaceModel(
        { generation: 1, target: null, status: "idle", changeId: null },
        entries,
      ),
    ).toEqual({ kind: "absent" });
    expect(
      changeDiffSurfaceModel(
        { generation: 1, target: null, status: "loading", changeId: CHANGE_ID },
        entries,
      ),
    ).toEqual({ kind: "loading", relativePath: "src/index.ts" });
  });

  it("maps a ready diff resource with its hunks", () => {
    const state: WorkspaceChangeDiffState = {
      generation: 1,
      target: null,
      status: "loaded",
      changeId: CHANGE_ID,
      updatedAt: 0,
      refreshing: false,
      resource: {
        status: "ready",
        workspaceName: "alpha",
        changesRevision: "rev",
        changeId: CHANGE_ID,
        group: "staged",
        relativePath: "src/index.ts",
        originPath: null,
        hunks: [],
        totalHunks: 0,
        totalLines: 0,
        truncated: false,
      } as unknown as WorkspaceChangeDiffResourceV1,
    };
    expect(changeDiffSurfaceModel(state, entries)).toEqual({
      kind: "ready",
      relativePath: "src/index.ts",
      originPath: null,
      hunks: [],
      totalHunks: 0,
      totalLines: 0,
      truncated: false,
    });
  });

  it("maps a transport error to an unavailable diff with the known path", () => {
    const state: WorkspaceChangeDiffState = {
      generation: 1,
      target: null,
      status: "error",
      changeId: CHANGE_ID,
      code: "daemon-identity-mismatch",
      reason: "stale generation",
      stale: null,
    };
    expect(changeDiffSurfaceModel(state, entries)).toEqual({
      kind: "unavailable",
      relativePath: "src/index.ts",
      reason: "stale generation",
      retryable: false,
    });
  });
});
