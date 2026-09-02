import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_WIRE_PROTOCOL_VERSION,
  type DesktopDaemonFetchWorkspaceChangeDiffResult,
  type DesktopDaemonFetchWorkspaceChangesResult,
  type DaemonInstanceIdentity,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import {
  createWorkspaceChangeDiffStore,
  createWorkspaceChangesCatalogStore,
} from "./workspace-changes-store.ts";

const DAEMON: DaemonInstanceIdentity = {
  protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};

const TARGET = { daemon: DAEMON, workspaceName: "product workspace" };
const TARGET_B = { daemon: DAEMON, workspaceName: "docs" };

function changesCatalog(daemon = DAEMON): DesktopDaemonFetchWorkspaceChangesResult {
  return {
    status: "ok",
    envelope: {
      version: 1,
      daemon,
      resource: {
        status: "ready",
        workspaceName: "product workspace",
        revision: "changes-rev.revrevrevrevrev01",
        branch: "main",
        detached: false,
        entries: [
          {
            id: "change.changechangechange01",
            group: "unstaged",
            status: "modified",
            name: "README.md",
            relativePath: "README.md",
            originPath: null,
            binary: false,
            additions: 3,
            deletions: 1,
          },
        ],
        totalEntries: 1,
        truncated: false,
      },
    },
  };
}

const UNAVAILABLE_CHANGES: DesktopDaemonFetchWorkspaceChangesResult = {
  status: "ok",
  envelope: {
    version: 1,
    daemon: DAEMON,
    resource: {
      status: "unavailable",
      workspaceName: "product workspace",
      reason: "not-a-git-repository",
      message: "This workspace is not a git repository.",
      retryable: false,
    },
  },
};

function diff(daemon = DAEMON): DesktopDaemonFetchWorkspaceChangeDiffResult {
  return {
    status: "ok",
    envelope: {
      version: 1,
      daemon,
      resource: {
        status: "ready",
        workspaceName: "product workspace",
        changesRevision: "changes-rev.revrevrevrevrev01",
        changeId: "change.changechangechange01",
        group: "unstaged",
        relativePath: "README.md",
        originPath: null,
        hunks: [
          {
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: [
              { kind: "delete", content: "old", oldLine: 1, newLine: null },
              { kind: "insert", content: "new", oldLine: null, newLine: 1 },
            ],
          },
        ],
        totalHunks: 1,
        totalLines: 2,
        truncated: false,
      },
    },
  };
}

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

describe("workspace changes catalog store", () => {
  it("auto-loads the changes catalog on a target", async () => {
    const fetchWorkspaceChanges = vi.fn(async () => changesCatalog());
    const store = createWorkspaceChangesCatalogStore({
      host: makeHost({ fetchWorkspaceChanges }),
      target: TARGET,
    });
    expect(store.getState()).toMatchObject({ status: "loading" });
    await flush();
    expect(store.getState()).toMatchObject({
      status: "loaded",
      resource: { status: "ready", branch: "main" },
    });
    expect(fetchWorkspaceChanges).toHaveBeenCalledWith(
      { workspaceName: "product workspace" },
      expect.any(AbortSignal),
    );
    store.dispose();
  });

  it("surfaces a typed unavailable catalog", async () => {
    const store = createWorkspaceChangesCatalogStore({
      host: makeHost({ fetchWorkspaceChanges: vi.fn(async () => UNAVAILABLE_CHANGES) }),
      target: TARGET,
    });
    await flush();
    expect(store.getState()).toMatchObject({
      status: "loaded",
      resource: { status: "unavailable", reason: "not-a-git-repository" },
    });
    store.dispose();
  });

  it("maps a host error to a transport error", async () => {
    const store = createWorkspaceChangesCatalogStore({
      host: makeHost({
        fetchWorkspaceChanges: vi.fn(async () => ({
          status: "error" as const,
          error: { code: "request-failed" as const, reason: "boom" },
        })),
      }),
      target: TARGET,
    });
    await flush();
    expect(store.getState()).toMatchObject({ status: "error", code: "request-failed" });
    store.dispose();
  });

  it("drops a stale catalog after the target changes", async () => {
    const pending = deferred<DesktopDaemonFetchWorkspaceChangesResult>();
    const fetchWorkspaceChanges = vi
      .fn<() => Promise<DesktopDaemonFetchWorkspaceChangesResult>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(UNAVAILABLE_CHANGES);
    const store = createWorkspaceChangesCatalogStore({
      host: makeHost({ fetchWorkspaceChanges }),
      target: TARGET,
    });
    store.setTarget(TARGET_B);
    await flush();
    pending.resolve(changesCatalog());
    await flush();
    expect(store.getState()).toMatchObject({
      status: "loaded",
      resource: { status: "unavailable" },
    });
    expect(store.getState().target?.workspaceName).toBe("docs");
    store.dispose();
  });
});

describe("workspace change diff store", () => {
  it("loads a diff on demand", async () => {
    const fetchWorkspaceChangeDiff = vi.fn(async () => diff());
    const store = createWorkspaceChangeDiffStore({
      host: makeHost({ fetchWorkspaceChangeDiff }),
      target: TARGET,
    });
    expect(store.getState()).toMatchObject({ status: "idle", changeId: null });
    store.load("change.changechangechange01");
    await flush();
    expect(store.getState()).toMatchObject({
      status: "loaded",
      changeId: "change.changechangechange01",
      resource: { status: "ready" },
    });
    expect(fetchWorkspaceChangeDiff).toHaveBeenCalledWith(
      {
        workspaceName: "product workspace",
        changeId: "change.changechangechange01",
      },
      expect.any(AbortSignal),
    );
    store.dispose();
  });

  it("rejects a diff from another daemon generation", async () => {
    const store = createWorkspaceChangeDiffStore({
      host: makeHost({
        fetchWorkspaceChangeDiff: vi.fn(async () =>
          diff({ ...DAEMON, instanceId: "00000000-0000-4000-8000-000000000099" }),
        ),
      }),
      target: TARGET,
    });
    store.load("change.changechangechange01");
    await flush();
    expect(store.getState()).toMatchObject({
      status: "error",
      code: "daemon-identity-mismatch",
    });
    store.dispose();
  });

  it("drops a stale diff after the target changes", async () => {
    const pending = deferred<DesktopDaemonFetchWorkspaceChangeDiffResult>();
    const fetchWorkspaceChangeDiff = vi
      .fn<() => Promise<DesktopDaemonFetchWorkspaceChangeDiffResult>>()
      .mockReturnValue(pending.promise);
    const store = createWorkspaceChangeDiffStore({
      host: makeHost({ fetchWorkspaceChangeDiff }),
      target: TARGET,
    });
    store.load("change.changechangechange01");
    store.setTarget(TARGET_B);
    pending.resolve(diff());
    await flush();
    expect(store.getState()).toMatchObject({ status: "idle", changeId: null });
    store.dispose();
  });
});
