import { assert, expect, test } from "vitest";

import type { WorkspaceOpenHandoffDependencies } from "./workspace-open-handoff.ts";
import {
  WorkspaceOpenHandoffCoordinator,
  WorkspaceOpenHandoffError,
} from "./workspace-open-handoff.ts";

const generation = "10000000-0000-4000-8000-000000000001";
const op = "20000000-0000-4000-8000-000000000001";

function dependencies(overrides: Partial<WorkspaceOpenHandoffDependencies> = {}) {
  return {
    daemonInstanceId: generation,
    openProject: async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: generation,
      outcome: "created" as const,
      resource: {
        resourceVersion: 1 as const,
        workspaceName: "project",
        initialPaneId: "pane.editor",
      },
    }),
    adoptLiveSession: async (request) => ({
      operationId: request.operationId,
      daemonInstanceId: generation,
      outcome: "promoted" as const,
      resource: { resourceVersion: 1 as const, workspaceName: "adopted" },
    }),
    prepareRuntime: async (_workspaceName, preferredPaneId) => ({
      semanticPaneId: preferredPaneId ?? "pane.adopted",
      paneCount: 2,
      terminalRevision: 0,
      terminalStateHash: "0123456789abcdef",
    }),
    ...overrides,
  } satisfies WorkspaceOpenHandoffDependencies;
}

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    callbacks,
    setTimer: (callback: () => void) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer: ReturnType<typeof setTimeout>) => {
      callbacks.delete(timer as unknown as number);
    },
    fireAll: () => {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
  };
}

test("clean project prepare proves runtime before commit", async () => {
  const coordinator = new WorkspaceOpenHandoffCoordinator(dependencies());
  const prepared = await coordinator.prepare(op, generation, "client-a", {
    source: { kind: "project", projectDir: "/tmp/project" },
  });
  assert.equal(prepared.phase, "prepared");
  assert.equal(prepared.proof.semanticPaneId, "pane.editor");
  assert.equal(coordinator.commit(op, generation, "client-a", prepared).phase, "committed");
});

test("ordinary live session is adopted and semantically prewarmed", async () => {
  let adopted = false;
  const coordinator = new WorkspaceOpenHandoffCoordinator(
    dependencies({
      adoptLiveSession: async (request) => {
        adopted = request.intent.sessionId === "session.abcdef12";
        return {
          operationId: request.operationId,
          daemonInstanceId: generation,
          outcome: "promoted",
          resource: { resourceVersion: 1, workspaceName: "adopted" },
        };
      },
    }),
  );
  const result = await coordinator.prepare(op, generation, "client-a", {
    source: { kind: "live-session", sessionId: "session.abcdef12" },
  });
  assert.equal(adopted, true);
  assert.equal(result.workspaceName, "adopted");
  assert.equal(result.proof.semanticPaneId, "pane.adopted");
});

test("cancel retires the token without switching", async () => {
  const coordinator = new WorkspaceOpenHandoffCoordinator(dependencies());
  const prepared = await coordinator.prepare(op, generation, "client-a", {
    source: { kind: "project", projectDir: "/tmp/project" },
  });
  assert.equal(coordinator.cancel(op, generation, "client-a", prepared).phase, "cancelled");
  assert.throws(
    () => coordinator.commit(op, generation, "client-a", prepared),
    WorkspaceOpenHandoffError,
  );
});

test("stale daemon generation cannot prepare", async () => {
  const coordinator = new WorkspaceOpenHandoffCoordinator(dependencies());
  await expect(
    coordinator.prepare(op, "30000000-0000-4000-8000-000000000001", "client-a", {
      source: { kind: "project", projectDir: "/tmp/project" },
    }),
  ).rejects.toMatchObject({ code: "daemon_instance_mismatch" });
});

test("concurrent prepare is latest-wins per client", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let calls = 0;
  const coordinator = new WorkspaceOpenHandoffCoordinator(
    dependencies({
      prepareRuntime: async () => {
        if (++calls === 1) {
          markStarted();
          await blocked;
        }
        return {
          semanticPaneId: "pane.editor",
          paneCount: 1,
          terminalRevision: 0,
          terminalStateHash: "0123456789abcdef",
        };
      },
    }),
  );
  const first = coordinator.prepare(op, generation, "client-a", {
    source: { kind: "project", projectDir: "/tmp/one" },
  });
  await started;
  const second = await coordinator.prepare(
    "20000000-0000-4000-8000-000000000002",
    generation,
    "client-a",
    {
      source: { kind: "project", projectDir: "/tmp/two" },
    },
  );
  release();
  await expect(first).rejects.toMatchObject({ code: "workspace_prepare_superseded" });
  assert.equal(second.preparedRevision, 2);
});

test("failed candidate keeps previous runtime warm and emits no token", async () => {
  const warmed: string[] = [];
  const coordinator = new WorkspaceOpenHandoffCoordinator(
    dependencies({
      prewarmPrevious: async (workspace) => {
        warmed.push(workspace);
      },
      prepareRuntime: async () => {
        throw new Error("seed unavailable");
      },
    }),
  );
  await expect(
    coordinator.prepare(op, generation, "client-a", {
      source: { kind: "project", projectDir: "/tmp/project" },
      previousWorkspaceName: "previous",
    }),
  ).rejects.toMatchObject({ code: "workspace_prepare_failed" });
  assert.deepEqual(warmed, ["previous"]);
});

test("abandoned prepare expires and commit reports expiry", async () => {
  const timers = fakeTimers();
  const coordinator = new WorkspaceOpenHandoffCoordinator(
    dependencies({
      prepareTtlMs: 10,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
  );
  const prepared = await coordinator.prepare(op, generation, "client-a", {
    source: { kind: "project", projectDir: "/tmp/project" },
  });
  assert.equal(timers.callbacks.size, 1);
  timers.fireAll();
  expect(() => coordinator.commit(op, generation, "client-a", prepared)).toThrowError(
    expect.objectContaining({ code: "workspace_prepare_expired" }),
  );
});

test("many abandoned client ids are deterministically bounded", async () => {
  const timers = fakeTimers();
  const coordinator = new WorkspaceOpenHandoffCoordinator(
    dependencies({
      maxLiveClients: 2,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
  );
  const first = await coordinator.prepare(op, generation, "client-a", {
    source: { kind: "project", projectDir: "/tmp/a" },
  });
  await coordinator.prepare("20000000-0000-4000-8000-000000000002", generation, "client-b", {
    source: { kind: "project", projectDir: "/tmp/b" },
  });
  const latest = await coordinator.prepare(
    "20000000-0000-4000-8000-000000000003",
    generation,
    "client-c",
    {
      source: { kind: "project", projectDir: "/tmp/c" },
    },
  );
  assert.throws(() => coordinator.commit(op, generation, "client-a", first));
  assert.equal(coordinator.commit(op, generation, "client-c", latest).phase, "committed");
  assert.ok(timers.callbacks.size <= 1);
});

test("dispose clears leases and rejects late preparation and decisions", async () => {
  const timers = fakeTimers();
  const coordinator = new WorkspaceOpenHandoffCoordinator(
    dependencies({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
  );
  const prepared = await coordinator.prepare(op, generation, "client-a", {
    source: { kind: "project", projectDir: "/tmp/project" },
  });
  coordinator.dispose();
  assert.equal(timers.callbacks.size, 0);
  expect(() => coordinator.commit(op, generation, "client-a", prepared)).toThrowError(
    expect.objectContaining({ code: "workspace_prepare_disposed" }),
  );
  await expect(
    coordinator.prepare("20000000-0000-4000-8000-000000000004", generation, "client-a", {
      source: { kind: "project", projectDir: "/tmp/other" },
    }),
  ).rejects.toMatchObject({ code: "workspace_prepare_disposed" });
});
