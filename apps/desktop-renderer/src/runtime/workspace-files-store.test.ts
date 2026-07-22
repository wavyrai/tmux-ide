import { describe, expect, it, vi } from "vitest";
import type {
  DesktopDaemonFetchWorkspaceFilePreviewResult,
  DesktopDaemonFetchWorkspaceFilesResult,
  DaemonInstanceIdentity,
  HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createWorkspaceFilePreviewStore,
  createWorkspaceFilesCatalogStore,
} from "./workspace-files-store.ts";

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};

const TARGET = { daemon: DAEMON, workspaceName: "product workspace" };
const TARGET_B = { daemon: DAEMON, workspaceName: "docs" };

function rootCatalog(daemon = DAEMON): DesktopDaemonFetchWorkspaceFilesResult {
  return {
    status: "ok",
    envelope: {
      version: 1,
      daemon,
      resource: {
        status: "ready",
        workspaceName: "product workspace",
        revision: "files-rev.revrevrevrevrev01",
        rootId: "file.rootrootrootroot01",
        directory: {
          id: "file.rootrootrootroot01",
          name: "product",
          relativePath: null,
          parentId: null,
        },
        breadcrumbs: [{ id: "file.rootrootrootroot01", label: "product" }],
        entries: [
          {
            id: "file.dirdirdirdirdir0001",
            parentId: "file.rootrootrootroot01",
            name: "src",
            relativePath: "src",
            kind: "directory",
            hidden: false,
            ignored: false,
            hasChildren: true,
            gitStatus: null,
          },
        ],
        totalEntries: 1,
        truncated: false,
      },
    },
  };
}

function childCatalog(): DesktopDaemonFetchWorkspaceFilesResult {
  return {
    status: "ok",
    envelope: {
      version: 1,
      daemon: DAEMON,
      resource: {
        status: "ready",
        workspaceName: "product workspace",
        revision: "files-rev.revrevrevrevrev01",
        rootId: "file.rootrootrootroot01",
        directory: {
          id: "file.dirdirdirdirdir0001",
          name: "src",
          relativePath: "src",
          parentId: "file.rootrootrootroot01",
        },
        breadcrumbs: [
          { id: "file.rootrootrootroot01", label: "product" },
          { id: "file.dirdirdirdirdir0001", label: "src" },
        ],
        entries: [
          {
            id: "file.fillfillfillfill01",
            parentId: "file.dirdirdirdirdir0001",
            name: "index.ts",
            relativePath: "src/index.ts",
            kind: "file",
            hidden: false,
            ignored: false,
            hasChildren: false,
            gitStatus: "modified",
          },
        ],
        totalEntries: 1,
        truncated: false,
      },
    },
  };
}

const UNAVAILABLE_CATALOG: DesktopDaemonFetchWorkspaceFilesResult = {
  status: "ok",
  envelope: {
    version: 1,
    daemon: DAEMON,
    resource: {
      status: "unavailable",
      workspaceName: "product workspace",
      reason: "directory-not-found",
      message: "The directory no longer exists.",
      retryable: false,
    },
  },
};

function makeHost(daemon: Partial<HostCapabilities["daemon"]>): Pick<HostCapabilities, "daemon"> {
  return { daemon: daemon as HostCapabilities["daemon"] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("workspace files catalog store", () => {
  it("auto-loads the workspace root and records the root id", async () => {
    const fetchWorkspaceFiles = vi.fn(async () => rootCatalog());
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({ fetchWorkspaceFiles }),
      target: TARGET,
    });
    expect(store.getState().root).toMatchObject({ status: "loading" });
    await flush();
    const state = store.getState();
    expect(state.rootId).toBe("file.rootrootrootroot01");
    expect(state.root).toMatchObject({ status: "loaded", resource: { status: "ready" } });
    expect(fetchWorkspaceFiles).toHaveBeenCalledWith({ workspaceName: "product workspace" });
    store.dispose();
  });

  it("loads a child directory for tree expansion under its requested id", async () => {
    const fetchWorkspaceFiles = vi.fn(async (request: { directoryId?: string }) =>
      request.directoryId ? childCatalog() : rootCatalog(),
    );
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({ fetchWorkspaceFiles }),
      target: TARGET,
    });
    await flush();
    store.loadDirectory("file.dirdirdirdirdir0001");
    await flush();
    const slot = store.getState().directories.get("file.dirdirdirdirdir0001");
    expect(slot).toMatchObject({ status: "loaded", resource: { status: "ready" } });
    store.dispose();
  });

  it("surfaces a typed unavailable resource without treating it as a transport error", async () => {
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({ fetchWorkspaceFiles: vi.fn(async () => UNAVAILABLE_CATALOG) }),
      target: TARGET,
    });
    await flush();
    expect(store.getState().root).toMatchObject({
      status: "loaded",
      resource: { status: "unavailable", reason: "directory-not-found" },
    });
    store.dispose();
  });

  it("maps a host error to a transport error slot", async () => {
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({
        fetchWorkspaceFiles: vi.fn(async () => ({
          status: "error" as const,
          error: { code: "daemon-unavailable" as const, reason: "down" },
        })),
      }),
      target: TARGET,
    });
    await flush();
    expect(store.getState().root).toMatchObject({ status: "error", code: "daemon-unavailable" });
    store.dispose();
  });

  it("rejects a catalog stamped by another daemon generation", async () => {
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({
        fetchWorkspaceFiles: vi.fn(async () =>
          rootCatalog({ ...DAEMON, instanceId: "00000000-0000-4000-8000-000000000099" }),
        ),
      }),
      target: TARGET,
    });
    await flush();
    expect(store.getState().root).toMatchObject({
      status: "error",
      code: "daemon-identity-mismatch",
    });
    store.dispose();
  });

  it("drops a stale response after the target generation changes", async () => {
    const pending = deferred<DesktopDaemonFetchWorkspaceFilesResult>();
    const fetchWorkspaceFiles = vi
      .fn<() => Promise<DesktopDaemonFetchWorkspaceFilesResult>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        status: "ok",
        envelope: {
          version: 1,
          daemon: DAEMON,
          resource: {
            status: "unavailable",
            workspaceName: "docs",
            reason: "workspace-unavailable",
            message: "gone",
            retryable: true,
          },
        },
      });
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({ fetchWorkspaceFiles }),
      target: TARGET,
    });
    const firstGeneration = store.getState().generation;
    store.setTarget(TARGET_B);
    await flush();
    // The first target's request resolves late; its ready root must be ignored.
    pending.resolve(rootCatalog());
    await flush();
    const state = store.getState();
    expect(state.generation).toBeGreaterThan(firstGeneration);
    expect(state.target?.workspaceName).toBe("docs");
    expect(state.rootId).toBeNull();
    expect(state.root).toMatchObject({ resource: { workspaceName: "docs" } });
    store.dispose();
  });

  it("reports an invalid target as an invalid-request slot", () => {
    const store = createWorkspaceFilesCatalogStore({
      host: makeHost({ fetchWorkspaceFiles: vi.fn() }),
      target: { daemon: DAEMON, workspaceName: "" },
    });
    expect(store.getState().root).toMatchObject({ status: "error", code: "invalid-request" });
    expect(store.getState().target).toBeNull();
    store.dispose();
  });
});

function preview(daemon = DAEMON): DesktopDaemonFetchWorkspaceFilePreviewResult {
  return {
    status: "ok",
    envelope: {
      version: 1,
      daemon,
      resource: {
        status: "ready",
        workspaceName: "product workspace",
        catalogRevision: "files-rev.revrevrevrevrev01",
        fileId: "file.fillfillfillfill01",
        name: "index.ts",
        relativePath: "src/index.ts",
        encoding: "utf-8",
        languageHint: "typescript",
        content: "export {};\n",
        totalBytes: 11,
        totalLines: 2,
        truncated: false,
      },
    },
  };
}

describe("workspace file preview store", () => {
  it("stays idle until a file is requested, then loads it", async () => {
    const fetchWorkspaceFilePreview = vi.fn(async () => preview());
    const store = createWorkspaceFilePreviewStore({
      host: makeHost({ fetchWorkspaceFilePreview }),
      target: TARGET,
    });
    expect(store.getState()).toMatchObject({ status: "idle", fileId: null });
    store.load("file.fillfillfillfill01");
    expect(store.getState()).toMatchObject({
      status: "loading",
      fileId: "file.fillfillfillfill01",
    });
    await flush();
    expect(store.getState()).toMatchObject({
      status: "loaded",
      fileId: "file.fillfillfillfill01",
      resource: { status: "ready" },
    });
    expect(fetchWorkspaceFilePreview).toHaveBeenCalledWith({
      workspaceName: "product workspace",
      fileId: "file.fillfillfillfill01",
    });
    store.dispose();
  });

  it("drops a stale preview after the target changes", async () => {
    const pending = deferred<DesktopDaemonFetchWorkspaceFilePreviewResult>();
    const fetchWorkspaceFilePreview = vi
      .fn<() => Promise<DesktopDaemonFetchWorkspaceFilePreviewResult>>()
      .mockReturnValue(pending.promise);
    const store = createWorkspaceFilePreviewStore({
      host: makeHost({ fetchWorkspaceFilePreview }),
      target: TARGET,
    });
    store.load("file.fillfillfillfill01");
    store.setTarget(TARGET_B);
    expect(store.getState()).toMatchObject({ status: "idle", fileId: null });
    pending.resolve(preview());
    await flush();
    expect(store.getState()).toMatchObject({ status: "idle", fileId: null });
    store.dispose();
  });

  it("clears back to idle", async () => {
    const store = createWorkspaceFilePreviewStore({
      host: makeHost({ fetchWorkspaceFilePreview: vi.fn(async () => preview()) }),
      target: TARGET,
    });
    store.load("file.fillfillfillfill01");
    await flush();
    store.clear();
    expect(store.getState()).toMatchObject({ status: "idle", fileId: null });
    store.dispose();
  });
});
