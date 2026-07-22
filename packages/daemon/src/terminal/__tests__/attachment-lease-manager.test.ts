import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { TerminalAttachRequest } from "@tmux-ide/contracts";
import {
  AttachmentLeaseError,
  AttachmentLeaseManager,
  type AttachmentLeaseAuditEvent,
  type AttachmentLeaseBinding,
  type AttachmentLeaseDescriptor,
  type AttachmentViewExecutor,
  type EnumeratedMarkedAttachmentView,
  type GuardedAttachmentViewOperation,
  type GuardedAttachmentCleanup,
} from "../attachments/lease-manager.ts";
import { SemanticPaneCatalog } from "../attachments/semantic-pane-catalog.ts";
import {
  planGroupedTmuxAttachment,
  type GroupedTmuxAttachmentPlan,
  type TmuxArgvPlan,
} from "../attachments/grouped-tmux.ts";

const DAEMON_ID = "daemon-instance-a";
const PROJECT_ID = "project-alpha";
const target = { workspaceName: "workspace.alpha", semanticPaneId: "pane.worker" };

function uuid(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function request(
  viewerMode: "interactive" | "read-only" = "interactive",
  requestTarget = target,
): TerminalAttachRequest {
  return {
    protocolVersion: 1,
    target: requestTarget,
    viewerMode,
    viewport: { cols: 120, rows: 40 },
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    workspaceName: target.workspaceName,
    semanticPaneId: target.semanticPaneId,
    sessionId: "$1",
    windowId: "@2",
    runtimePaneId: "%3",
    windowPaneCount: 1,
    sessionWindowCount: 2,
    ...overrides,
  };
}

function planFor(
  descriptor: AttachmentLeaseDescriptor,
  source: ReturnType<typeof row> = row(),
): GroupedTmuxAttachmentPlan {
  return planGroupedTmuxAttachment({
    attachmentId: descriptor.leaseId,
    generation: descriptor.viewGeneration,
    target: descriptor.target,
    viewerMode: descriptor.viewerMode,
    viewport: { cols: 120, rows: 40 },
    source: {
      sessionId: source.sessionId as string,
      windowId: source.windowId as string,
      runtimePaneId: source.runtimePaneId as string,
      paneCount: 1,
    },
  });
}

interface FakeView {
  marker: string | null;
  windows: string[];
}

class FakeViewExecutor implements AttachmentViewExecutor {
  readonly views = new Map<string, FakeView>();
  readonly executed: TmuxArgvPlan[] = [];
  readonly cleanups: GuardedAttachmentCleanup[] = [];
  readonly guardedViewOperations: GuardedAttachmentViewOperation[] = [];
  readonly operations: string[] = [];
  cleanupFailure = false;
  sourceProofMatches = true;
  operationFailure = false;
  operationErrorCode: "read_only_unavailable" | null = null;
  clientClaimAttemptId: string | null = null;
  enumerationFailure = false;
  viewMutationCount = 0;
  operationNow: () => number = () => 0;
  beforeViewMutation: ((operation: GuardedAttachmentViewOperation) => void) | undefined;
  cleanupWait: (() => Promise<void>) | undefined;
  sourceProofWait: (() => Promise<void>) | undefined;

  seed(plan: GroupedTmuxAttachmentPlan, overrides: Partial<FakeView> = {}): void {
    this.views.set(plan.identity.viewSessionName, {
      marker: plan.identity.markerValue,
      windows: [plan.identity.durableSource.windowId],
      ...overrides,
    });
  }

  async guardedCleanup(cleanup: GuardedAttachmentCleanup) {
    this.operations.push("guardedCleanup");
    this.cleanups.push(cleanup);
    await this.cleanupWait?.();
    if (this.cleanupFailure) {
      throw new Error("cleanup failed with bearer-secret-that-must-not-log");
    }
    const name = cleanup.exactViewSessionTarget.replace(/^=/u, "");
    const view = this.views.get(name);
    if (!view) return "absent" as const;
    if (view.marker !== cleanup.expectedMarkerValue) return "ownership-mismatch" as const;
    if (view.windows.length !== 1 || view.windows[0] !== cleanup.expectedWindowId) {
      return "topology-mismatch" as const;
    }
    this.views.delete(name);
    this.executed.push({
      executable: "tmux",
      argv: ["kill-session", "-t", cleanup.exactViewSessionTarget],
    });
    return "cleaned" as const;
  }

  async executeGuardedViewOperation(operation: GuardedAttachmentViewOperation) {
    this.operations.push("executeGuardedViewOperation");
    this.guardedViewOperations.push(operation);
    await this.sourceProofWait?.();
    if (!this.sourceProofMatches) return "source-proof-mismatch" as const;
    this.beforeViewMutation?.(operation);
    if (this.operationNow() >= operation.deadline) return "lease-expired" as const;
    this.viewMutationCount += 1;
    if (this.operationErrorCode) {
      throw Object.assign(new Error("typed executor refusal"), {
        code: this.operationErrorCode,
      });
    }
    if (this.operationFailure) {
      this.seed(operation.plan);
      throw new Error("executor leaked bearer-secret-on-%99-at-$77:@88");
    }
    if (this.clientClaimAttemptId) {
      return {
        status: "executed" as const,
        clientClaim: {
          attachmentId: operation.plan.identity.attachmentId,
          generation: operation.plan.identity.generation,
          attemptId: this.clientClaimAttemptId,
        },
      };
    }
    return "executed" as const;
  }

  async enumerateMarkedViews(): Promise<readonly EnumeratedMarkedAttachmentView[]> {
    this.operations.push("enumerate");
    if (this.enumerationFailure) {
      throw new Error("enumeration leaked bearer-secret-on-%91-at-$71:@81");
    }
    return [...this.views.entries()].map(([viewSessionName, view]) => ({
      viewSessionName,
      markerValue: view.marker,
      windowIds: [...view.windows],
    }));
  }
}

interface Rig {
  manager: AttachmentLeaseManager;
  executor: FakeViewExecutor;
  rows: Array<ReturnType<typeof row>>;
  audits: AttachmentLeaseAuditEvent[];
  setNow(value: number): void;
}

function rig(
  options: {
    daemonInstanceId?: string;
    executor?: FakeViewExecutor;
    discover?: () => ReturnType<typeof row>[] | Promise<ReturnType<typeof row>[]>;
  } = {},
): Rig {
  let now = 1_000;
  let id = 1;
  let randomByte = 1;
  const rows = [row()];
  const executor = options.executor ?? new FakeViewExecutor();
  executor.operationNow = () => now;
  const audits: AttachmentLeaseAuditEvent[] = [];
  const catalog = new SemanticPaneCatalog({ discover: options.discover ?? (() => rows) });
  const manager = new AttachmentLeaseManager({
    daemonInstanceId: options.daemonInstanceId ?? DAEMON_ID,
    catalog,
    viewExecutor: executor,
    now: () => now,
    createId: () => uuid(id++),
    randomBytes: (size) => new Uint8Array(size).fill(randomByte++),
    ticketTtlMs: 100,
    leaseTtlMs: 1_000,
    maxLeaseTtlMs: 2_000,
    disconnectGraceMs: 50,
    onAudit: (event) => audits.push(event),
  });
  return { manager, executor, rows, audits, setNow: (value) => (now = value) };
}

function context(index: number) {
  return { requestId: uuid(100 + index), projectIdentity: PROJECT_ID };
}

function binding(requestId: string, overrides: Partial<AttachmentLeaseBinding> = {}) {
  return {
    daemonInstanceId: DAEMON_ID,
    requestId,
    projectIdentity: PROJECT_ID,
    ...overrides,
  };
}

async function errorCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}

describe("AttachmentLeaseManager", () => {
  it("serializes interactive ownership while explicit read-only viewers coexist", async () => {
    const { manager } = rig();
    const first = await manager.issue(request("interactive"), context(1));
    await errorCode(
      manager.issue(request("interactive"), context(2)),
      "interactive-viewer-conflict",
    );

    const readOne = await manager.issue(request("read-only"), context(3));
    const readTwo = await manager.issue(request("read-only"), context(4));
    expect(readOne.descriptor.viewerMode).toBe("read-only");
    expect(readTwo.descriptor.viewerMode).toBe("read-only");
    expect(manager.snapshot().leases).toHaveLength(3);

    await manager.release(first.descriptor.leaseId, binding(first.descriptor.requestId));
    await expect(manager.issue(request("interactive"), context(5))).resolves.toBeDefined();
  });

  it("makes contention atomic even when interactive issues race", async () => {
    const { manager } = rig();
    const results = await Promise.allSettled([
      manager.issue(request(), context(1)),
      manager.issue(request(), context(2)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toMatchObject({
      code: "interactive-viewer-conflict",
    });
  });

  it("serializes interactive ownership by global pane identity across linked sessions", async () => {
    const betaTarget = { workspaceName: "workspace.beta", semanticPaneId: "pane.other" };
    let rows = [row()];
    let id = 1;
    const manager = new AttachmentLeaseManager({
      daemonInstanceId: DAEMON_ID,
      catalog: new SemanticPaneCatalog({
        discover: () => rows,
      }),
      viewExecutor: new FakeViewExecutor(),
      createId: () => uuid(id++),
      randomBytes: (size) => new Uint8Array(size).fill(id),
    });
    await manager.issue(request("interactive"), context(1));
    rows = [
      row({
        workspaceName: betaTarget.workspaceName,
        semanticPaneId: betaTarget.semanticPaneId,
        sessionId: "$9",
      }),
    ];
    await errorCode(
      manager.issue(request("interactive", betaTarget), context(2)),
      "interactive-viewer-conflict",
    );
  });

  it("checks runtime ownership before moving a rebound interactive lease", async () => {
    const betaTarget = { workspaceName: "workspace.beta", semanticPaneId: "pane.other" };
    let rows = [row()];
    let id = 1;
    let ticketByte = 1;
    const executor = new FakeViewExecutor();
    const manager = new AttachmentLeaseManager({
      daemonInstanceId: DAEMON_ID,
      catalog: new SemanticPaneCatalog({ discover: () => rows }),
      viewExecutor: executor,
      createId: () => uuid(id++),
      randomBytes: (size) => new Uint8Array(size).fill(ticketByte++),
    });
    const alpha = await manager.issue(request(), context(1));
    rows = [
      row({
        workspaceName: betaTarget.workspaceName,
        semanticPaneId: betaTarget.semanticPaneId,
        sessionId: "$8",
        windowId: "@4",
        runtimePaneId: "%4",
      }),
    ];
    const beta = await manager.issue(request("interactive", betaTarget), context(2));
    await manager.redeem(beta.redemptionTicket, binding(beta.descriptor.requestId));
    rows = [row({ sessionId: "$9", windowId: "@4", runtimePaneId: "%4" })];

    await errorCode(
      manager.redeem(alpha.redemptionTicket, binding(alpha.descriptor.requestId)),
      "interactive-viewer-conflict",
    );
    expect(manager.snapshot().leases).toEqual([
      expect.objectContaining({ leaseId: beta.descriptor.leaseId, status: "active" }),
    ]);
    rows = [row()];
    await expect(manager.issue(request(), context(3))).resolves.toBeDefined();
  });

  it("serializes concurrent redeem and release operations without ticket or cleanup replay", async () => {
    const first = rig();
    const issued = await first.manager.issue(request(), context(1));
    const redeems = await Promise.allSettled([
      first.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
      first.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
    ]);
    expect(redeems.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(
      (redeems.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toMatchObject({ code: "invalid-ticket" });

    first.executor.seed(planFor(issued.descriptor));
    const releases = await Promise.all([
      first.manager.release(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
      first.manager.release(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
    ]);
    expect(releases).toEqual([
      { released: true, cleanup: "cleaned" },
      { released: false, cleanup: "absent" },
    ]);
    expect(first.executor.executed).toHaveLength(1);
  });

  it("binds high-entropy tickets to daemon, request, and project and rejects replay", async () => {
    const { manager } = rig();
    const issued = await manager.issue(request(), context(1));
    expect(issued.redemptionTicket).toMatch(/^ta1_[A-Za-z0-9_-]{43}$/u);

    await errorCode(
      manager.redeem(
        issued.redemptionTicket,
        binding(issued.descriptor.requestId, { daemonInstanceId: "daemon-instance-b" }),
      ),
      "binding-mismatch",
    );
    await errorCode(
      manager.redeem(
        issued.redemptionTicket,
        binding(issued.descriptor.requestId, { projectIdentity: "project-beta" }),
      ),
      "binding-mismatch",
    );
    await errorCode(
      manager.redeem(issued.redemptionTicket, binding(uuid(999))),
      "binding-mismatch",
    );

    const redeemed = await manager.redeem(
      issued.redemptionTicket,
      binding(issued.descriptor.requestId),
    );
    expect(redeemed.descriptor.status).toBe("active");
    await errorCode(
      manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
      "invalid-ticket",
    );
  });

  it("does not allow renewal or disconnect to bypass one-time redemption", async () => {
    const { manager } = rig();
    const issued = await manager.issue(request(), context(1));
    await errorCode(
      manager.renew(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
      "lease-not-active",
    );
    await errorCode(
      manager.disconnect(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
      "lease-not-active",
    );
    await expect(
      manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
    ).resolves.toMatchObject({ descriptor: { status: "active" } });
  });

  it("expires awaiting-redemption leases before status checks and releases ownership", async () => {
    for (const operation of ["renew", "disconnect", "execute"] as const) {
      const testRig = rig();
      const issued = await testRig.manager.issue(request(), context(1));
      const issuedPlan = planFor(issued.descriptor);
      testRig.executor.seed(issuedPlan);
      testRig.setNow(1_100);

      const pending =
        operation === "renew"
          ? testRig.manager.renew(issued.descriptor.leaseId, binding(issued.descriptor.requestId))
          : operation === "disconnect"
            ? testRig.manager.disconnect(
                issued.descriptor.leaseId,
                binding(issued.descriptor.requestId),
              )
            : testRig.manager.executeViewOperation(
                issued.descriptor.leaseId,
                binding(issued.descriptor.requestId),
                "create",
              );
      await errorCode(pending, "lease-expired");
      expect(testRig.manager.snapshot().leases).toHaveLength(0);
      expect(testRig.executor.views.has(issuedPlan.identity.viewSessionName)).toBe(false);
      expect(testRig.executor.guardedViewOperations).toHaveLength(0);
      await expect(testRig.manager.issue(request(), context(2))).resolves.toBeDefined();
    }
  });

  it("expires tickets at the exact clock boundary and releases interactive ownership", async () => {
    const { manager, executor, setNow } = rig();
    const issued = await manager.issue(request(), context(1));
    const issuedPlan = planFor(issued.descriptor);
    executor.seed(issuedPlan);
    setNow(1_100);
    await errorCode(
      manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
      "ticket-expired",
    );
    expect(executor.executed.at(-1)?.argv).toEqual([
      "kill-session",
      "-t",
      `=${issuedPlan.identity.viewSessionName}`,
    ]);
    await expect(manager.issue(request(), context(2))).resolves.toBeDefined();
  });

  it("rechecks ticket expiry after awaited trusted discovery", async () => {
    const discovery = deferred<ReturnType<typeof row>[]>();
    let calls = 0;
    const testRig = rig({
      discover: () => {
        calls += 1;
        return calls === 1 ? [row()] : discovery.promise;
      },
    });
    const issued = await testRig.manager.issue(request(), context(1));
    const issuedPlan = planFor(issued.descriptor);
    testRig.setNow(1_099);
    const redemption = testRig.manager.redeem(
      issued.redemptionTicket,
      binding(issued.descriptor.requestId),
    );
    await waitUntil(() => calls === 2);
    testRig.setNow(1_100);
    discovery.resolve([row()]);

    await errorCode(redemption, "ticket-expired");
    expect(testRig.manager.snapshot().leases).toHaveLength(0);
    expect(testRig.executor.cleanups.at(-1)?.exactViewSessionTarget).toBe(
      `=${issuedPlan.identity.viewSessionName}`,
    );
  });

  it("rechecks ticket expiry after awaited rebound cleanup before activation", async () => {
    const cleanup = deferred<void>();
    const testRig = rig();
    const issued = await testRig.manager.issue(request(), context(1));
    testRig.executor.seed(planFor(issued.descriptor));
    testRig.executor.cleanupWait = () => cleanup.promise;
    testRig.rows[0] = row({ sessionId: "$7", windowId: "@9", runtimePaneId: "%10" });
    testRig.setNow(1_099);
    const redemption = testRig.manager.redeem(
      issued.redemptionTicket,
      binding(issued.descriptor.requestId),
    );
    await waitUntil(() => testRig.executor.cleanups.length === 1);
    testRig.setNow(1_100);
    cleanup.resolve();

    await errorCode(redemption, "ticket-expired");
    expect(testRig.manager.snapshot().leases).toHaveLength(0);
  });

  it("rechecks active lease expiry after awaited discovery before extension", async () => {
    const discovery = deferred<ReturnType<typeof row>[]>();
    let calls = 0;
    const testRig = rig({
      discover: () => {
        calls += 1;
        return calls < 3 ? [row()] : discovery.promise;
      },
    });
    const issued = await testRig.manager.issue(request(), context(1));
    await testRig.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    testRig.setNow(1_999);
    const renewal = testRig.manager.renew(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
    );
    await waitUntil(() => calls === 3);
    testRig.setNow(2_000);
    discovery.resolve([row()]);

    await errorCode(renewal, "lease-expired");
    expect(testRig.manager.snapshot().leases).toHaveLength(0);
  });

  it("rechecks active lease expiry after awaited rebound cleanup before extension", async () => {
    const cleanup = deferred<void>();
    const testRig = rig();
    const issued = await testRig.manager.issue(request(), context(1));
    await testRig.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    testRig.executor.seed(planFor(issued.descriptor));
    testRig.executor.cleanupWait = () => cleanup.promise;
    testRig.rows[0] = row({ sessionId: "$7", windowId: "@9", runtimePaneId: "%10" });
    testRig.setNow(1_999);
    const renewal = testRig.manager.renew(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
    );
    await waitUntil(() => testRig.executor.cleanups.length === 1);
    testRig.setNow(2_000);
    cleanup.resolve();

    await errorCode(renewal, "lease-expired");
    expect(testRig.manager.snapshot().leases).toHaveLength(0);
  });

  it("renews TTL, supports disconnect grace, and expires exactly at the grace boundary", async () => {
    const { manager, executor, setNow } = rig();
    const issued = await manager.issue(request(), context(1));
    await manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));

    setNow(1_500);
    const renewed = await manager.renew(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
      1_500,
    );
    expect(renewed.descriptor.expiresAt).toBe(3_000);
    const disconnected = await manager.disconnect(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
    );
    expect(disconnected.graceExpiresAt).toBe(1_550);

    setNow(1_549);
    await expect(
      manager.renew(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
    ).resolves.toMatchObject({ descriptor: { status: "active" } });
    await manager.disconnect(issued.descriptor.leaseId, binding(issued.descriptor.requestId));
    executor.seed(planFor(issued.descriptor));
    setNow(1_599);
    expect(await manager.sweep()).toHaveLength(1);
    expect(manager.snapshot().leases).toHaveLength(0);
  });

  it("semantically rebinds pane churn and rotates the view only when its linked window changes", async () => {
    const { manager, executor, rows } = rig();
    const issued = await manager.issue(request(), context(1));
    rows.splice(0, 1, row({ runtimePaneId: "%8" }));
    const redeemed = await manager.redeem(
      issued.redemptionTicket,
      binding(issued.descriptor.requestId),
    );
    expect(redeemed.descriptor.bindingGeneration).toBe(1);
    expect(redeemed.descriptor.viewGeneration).toBe(0);
    expect(Object.keys(redeemed)).toEqual(["descriptor"]);
    expect(executor.executed).toHaveLength(0);

    const redeemedPlan = planFor(redeemed.descriptor, row({ runtimePaneId: "%8" }));
    executor.seed(redeemedPlan);
    rows.splice(0, 1, row({ sessionId: "$7", windowId: "@9", runtimePaneId: "%10" }));
    const renewed = await manager.renew(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
    );
    expect(renewed.descriptor.bindingGeneration).toBe(2);
    expect(renewed.descriptor.viewGeneration).toBe(1);
    expect(Object.keys(renewed)).toEqual(["descriptor"]);
    expect(executor.views.has(redeemedPlan.identity.viewSessionName)).toBe(false);
  });

  it("removes the ghost reservation after any post-consumption redemption failure", async () => {
    const { manager, executor, rows } = rig();
    const issued = await manager.issue(request(), context(1));
    executor.seed(planFor(issued.descriptor));
    rows[0] = row({ sessionId: "$7", windowId: "@9", runtimePaneId: "%10" });
    executor.cleanupFailure = true;

    await errorCode(
      manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
      "view-cleanup-failed",
    );
    expect(manager.snapshot().leases).toHaveLength(0);
    expect(executor.cleanups.length).toBeGreaterThanOrEqual(2);
    executor.cleanupFailure = false;
    await expect(manager.issue(request(), context(2))).resolves.toBeDefined();
  });

  it("releases the original runtime reservation when post-ticket discovery is invalid", async () => {
    const { manager, rows } = rig();
    const issued = await manager.issue(request(), context(1));
    rows[0] = row({
      sessionId: `$${"1".repeat(33)}`,
      windowId: "@9",
      runtimePaneId: "%10",
    });

    await expect(
      manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
    ).rejects.toMatchObject({ code: "invalid-runtime-proof" });
    expect(manager.snapshot().leases).toHaveLength(0);

    const betaTarget = { workspaceName: "workspace.beta", semanticPaneId: "pane.other" };
    rows[0] = row({
      workspaceName: betaTarget.workspaceName,
      semanticPaneId: betaTarget.semanticPaneId,
    });
    await expect(
      manager.issue(request("interactive", betaTarget), context(2)),
    ).resolves.toBeDefined();
  });

  it("executes behind fresh server-trusted source proof after runtime churn", async () => {
    const { manager, executor, rows } = rig();
    const issued = await manager.issue(request(), context(1));
    await manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));

    for (const operation of ["create", "attach", "recover"] as const) {
      if (operation === "attach") rows[0] = row({ runtimePaneId: "%7" });
      if (operation === "recover") {
        rows[0] = row({ sessionId: "$8", windowId: "@9", runtimePaneId: "%10" });
      }
      const executed = await manager.executeViewOperation(
        issued.descriptor.leaseId,
        binding(issued.descriptor.requestId),
        operation,
      );
      expect(executed.operation).toBe(operation);
      const guardedOperation = executor.guardedViewOperations.at(-1)!;
      expect(guardedOperation).toMatchObject({
        operation,
        source:
          operation === "create"
            ? { sessionId: "$1", windowId: "@2", runtimePaneId: "%3", paneCount: 1 }
            : operation === "attach"
              ? { sessionId: "$1", windowId: "@2", runtimePaneId: "%7", paneCount: 1 }
              : { sessionId: "$8", windowId: "@9", runtimePaneId: "%10", paneCount: 1 },
      });
      expect(guardedOperation.exactViewSessionTarget).toBe(
        `=${guardedOperation.plan.identity.viewSessionName}`,
      );
      expect(guardedOperation.plan.identity.durableSource).toEqual({
        sessionId: guardedOperation.source.sessionId,
        windowId: guardedOperation.source.windowId,
        runtimePaneId: guardedOperation.source.runtimePaneId,
      });
    }

    executor.sourceProofMatches = false;
    await errorCode(
      manager.executeViewOperation(
        issued.descriptor.leaseId,
        binding(issued.descriptor.requestId),
        "attach",
      ),
      "source-proof-mismatch",
    );
  });

  it("returns the exact one-use client claim key from the guarded executor", async () => {
    const { manager, executor } = rig();
    const issued = await manager.issue(request(), context(1));
    await manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    executor.clientClaimAttemptId = "728e8e59-00e7-4b6b-b794-1f55686f39ea";

    await expect(
      manager.executeViewOperation(
        issued.descriptor.leaseId,
        binding(issued.descriptor.requestId),
        "attach",
      ),
    ).resolves.toMatchObject({
      operation: "attach",
      clientClaim: {
        attachmentId: issued.descriptor.leaseId,
        generation: issued.descriptor.viewGeneration,
        attemptId: "728e8e59-00e7-4b6b-b794-1f55686f39ea",
      },
    });
  });

  it("sanitizes guarded executor failures and cleans uncertain view state", async () => {
    const { manager, executor } = rig();
    const issued = await manager.issue(request(), context(1));
    await manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    executor.operationFailure = true;

    try {
      await manager.executeViewOperation(
        issued.descriptor.leaseId,
        binding(issued.descriptor.requestId),
        "create",
      );
      throw new Error("expected guarded operation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentLeaseError);
      expect(error).toMatchObject({ code: "view-operation-failed" });
      expect((error as Error).message).toBe("The guarded terminal view operation failed.");
      expect((error as Error).cause).toBeUndefined();
      const inspected = `${JSON.stringify(error)} ${inspect(error)}`;
      expect(inspected).not.toMatch(/bearer-secret|%99|\$77|@88|executor leaked/u);
    }
    expect(manager.snapshot().leases).toHaveLength(0);
    expect(executor.views.size).toBe(0);
    executor.operationFailure = false;
    await expect(manager.issue(request(), context(2))).resolves.toBeDefined();
  });

  it("preserves a typed read-only transport refusal and cleans the lease", async () => {
    const { manager, executor } = rig();
    const issued = await manager.issue(request("read-only"), context(1));
    await manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    executor.operationErrorCode = "read_only_unavailable";

    await errorCode(
      manager.executeViewOperation(
        issued.descriptor.leaseId,
        binding(issued.descriptor.requestId),
        "attach",
      ),
      "read_only_unavailable",
    );
    expect(manager.snapshot().leases).toHaveLength(0);
    expect(executor.views.size).toBe(0);
    expect(executor.cleanups).toHaveLength(1);
  });

  it("does not execute an operation when the lease expires during its proof gate", async () => {
    const proof = deferred<void>();
    const testRig = rig();
    const issued = await testRig.manager.issue(request(), context(1));
    await testRig.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    testRig.executor.sourceProofWait = () => proof.promise;
    testRig.setNow(1_999);
    const authorization = testRig.manager.executeViewOperation(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
      "create",
    );
    await waitUntil(() => testRig.executor.guardedViewOperations.length === 1);
    testRig.setNow(2_000);
    proof.resolve();

    await errorCode(authorization, "lease-expired");
    expect(testRig.manager.snapshot().leases).toHaveLength(0);
  });

  it("checks the exact deadline inside the executor before view mutation", async () => {
    const testRig = rig();
    const issued = await testRig.manager.issue(request(), context(1));
    await testRig.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    testRig.setNow(1_999);
    testRig.executor.beforeViewMutation = (operation) => {
      expect(operation.deadline).toBe(2_000);
      testRig.setNow(operation.deadline);
    };

    await errorCode(
      testRig.manager.executeViewOperation(
        issued.descriptor.leaseId,
        binding(issued.descriptor.requestId),
        "create",
      ),
      "lease-expired",
    );
    expect(testRig.executor.viewMutationCount).toBe(0);
    expect(testRig.manager.snapshot().leases).toHaveLength(0);
  });

  it("rejects duplicate or missing semantic stamps during issue and renewal", async () => {
    const firstRig = rig();
    firstRig.rows.push(row({ windowId: "@8", runtimePaneId: "%9" }));
    await expect(firstRig.manager.issue(request(), context(1))).rejects.toMatchObject({
      code: "duplicate-semantic-stamp",
    });

    const secondRig = rig();
    const issued = await secondRig.manager.issue(request(), context(1));
    await secondRig.manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId));
    secondRig.rows.splice(0, 1, row({ semanticPaneId: null }));
    await expect(
      secondRig.manager.renew(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
    ).rejects.toMatchObject({ code: "missing-semantic-stamp" });
  });

  it("checks marker and topology before cleanup and makes release idempotent", async () => {
    const { manager, executor } = rig();
    const issued = await manager.issue(request(), context(1));
    const issuedPlan = planFor(issued.descriptor);
    executor.seed(issuedPlan);
    await expect(
      manager.release(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
    ).resolves.toEqual({ released: true, cleanup: "cleaned" });
    expect(executor.operations.at(-1)).toBe("guardedCleanup");
    expect(executor.cleanups.at(-1)?.exactViewSessionTarget).toBe(
      `=${issuedPlan.identity.viewSessionName}`,
    );
    expect(executor.executed).toHaveLength(1);
    await expect(
      manager.release(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
    ).resolves.toEqual({ released: false, cleanup: "absent" });
    expect(executor.executed).toHaveLength(1);

    const mismatch = await manager.issue(request(), context(2));
    executor.seed(planFor(mismatch.descriptor), { windows: ["@999"] });
    await expect(
      manager.release(mismatch.descriptor.leaseId, binding(mismatch.descriptor.requestId)),
    ).resolves.toEqual({ released: true, cleanup: "topology-mismatch" });
    expect(executor.executed).toHaveLength(1);
  });

  it("contains cleanup executor failures and never kills durable tmux identities", async () => {
    const { manager, executor, audits } = rig();
    const issued = await manager.issue(request(), context(1));
    executor.seed(planFor(issued.descriptor));
    executor.cleanupFailure = true;
    await expect(
      manager.release(issued.descriptor.leaseId, binding(issued.descriptor.requestId)),
    ).resolves.toEqual({ released: true, cleanup: "failed" });
    expect(executor.executed).toHaveLength(0);
    expect(audits).toContainEqual(expect.objectContaining({ type: "cleanup-failed" }));
    expect(JSON.stringify(audits)).not.toContain("bearer-secret-that-must-not-log");
  });

  it("keeps ticket material and digests out of snapshots, JSON, and audit hooks", async () => {
    const { manager, audits } = rig();
    const issued = await manager.issue(request(), context(1));
    const serialized = JSON.stringify({ issued, manager, snapshot: manager.snapshot(), audits });
    expect(serialized).not.toContain(issued.redemptionTicket);
    expect(serialized).not.toContain(
      createHash("sha256").update(issued.redemptionTicket).digest("hex"),
    );
    expect(serialized).not.toMatch(/ticketDigest|redemptionTicket|authToken|bearer/iu);
    expect(Object.keys(issued)).not.toContain("redemptionTicket");
  });

  it("keeps executable plans, argv, and runtime tmux ids out of lease results", async () => {
    const { manager } = rig();
    const issued = await manager.issue(request(), context(1));
    expect(Object.keys(issued)).toEqual(["descriptor"]);
    expect("plan" in issued).toBe(false);

    const redeemed = await manager.redeem(
      issued.redemptionTicket,
      binding(issued.descriptor.requestId),
    );
    const renewed = await manager.renew(
      issued.descriptor.leaseId,
      binding(issued.descriptor.requestId),
    );
    for (const result of [issued, redeemed, renewed]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/"(?:plan|argv|runtimePaneId|sessionId|windowId)"/u);
      expect(serialized).not.toContain("%3");
      expect(serialized).not.toContain("$1");
      expect(serialized).not.toContain("@2");
      expect("plan" in result).toBe(false);
    }
  });

  it("contains audit-hook failures without losing the issued ticket or ownership state", async () => {
    let now = 1_000;
    const manager = new AttachmentLeaseManager({
      daemonInstanceId: DAEMON_ID,
      catalog: new SemanticPaneCatalog({ discover: () => [row()] }),
      viewExecutor: new FakeViewExecutor(),
      now: () => now,
      createId: () => uuid(1),
      randomBytes: (size) => new Uint8Array(size).fill(7),
      ticketTtlMs: 100,
      leaseTtlMs: 1_000,
      disconnectGraceMs: 50,
      onAudit: () => {
        throw new Error("logger failed");
      },
    });
    const issued = await manager.issue(request(), context(1));
    expect(manager.snapshot().leases).toHaveLength(1);
    now += 1;
    await expect(
      manager.redeem(issued.redemptionTicket, binding(issued.descriptor.requestId)),
    ).resolves.toMatchObject({ descriptor: { status: "active" } });
  });

  it("invalidates old tickets on restart and reconciles only strictly marked orphan views", async () => {
    const executor = new FakeViewExecutor();
    const first = rig({ executor });
    const issued = await first.manager.issue(request(), context(1));
    const issuedPlan = planFor(issued.descriptor);
    executor.seed(issuedPlan);
    executor.views.set("durable-source", {
      marker: issuedPlan.identity.markerValue,
      windows: [issuedPlan.identity.durableSource.windowId],
    });
    executor.views.set(`${issuedPlan.identity.viewSessionName}-spoof`, {
      marker: issuedPlan.identity.markerValue,
      windows: [issuedPlan.identity.durableSource.windowId],
    });

    const restarted = rig({ daemonInstanceId: "daemon-instance-b", executor });
    await errorCode(
      restarted.manager.redeem(
        issued.redemptionTicket,
        binding(issued.descriptor.requestId, { daemonInstanceId: "daemon-instance-b" }),
      ),
      "invalid-ticket",
    );
    const result = await restarted.manager.reconcileOrphanViews();
    expect(result).toEqual({
      cleaned: [{ attachmentId: issued.descriptor.leaseId, generation: 0 }],
      failed: [],
      skippedCount: 2,
    });
    const exposed = `${JSON.stringify(result)} ${inspect(result)}`;
    expect(exposed).not.toContain("durable-source");
    expect(exposed).not.toContain(`${issuedPlan.identity.viewSessionName}-spoof`);
    expect(exposed).not.toMatch(/%3|\$1|@2/u);
    expect(executor.views.has(issuedPlan.identity.viewSessionName)).toBe(false);
    expect(executor.views.has("durable-source")).toBe(true);
    expect(executor.executed.at(-1)?.argv).toEqual([
      "kill-session",
      "-t",
      `=${issuedPlan.identity.viewSessionName}`,
    ]);
  });

  it("sanitizes marked-view enumeration failures without returning executor names", async () => {
    const executor = new FakeViewExecutor();
    executor.enumerationFailure = true;
    const { manager } = rig({ executor });

    try {
      await manager.reconcileOrphanViews();
      throw new Error("expected orphan enumeration failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentLeaseError);
      expect(error).toMatchObject({ code: "orphan-enumeration-failed" });
      expect((error as Error).message).toBe("Marked attachment view enumeration failed.");
      expect((error as Error).cause).toBeUndefined();
      const exposed = `${JSON.stringify(error)} ${inspect(error)}`;
      expect(exposed).not.toMatch(/bearer-secret|%91|\$71|@81|enumeration leaked/u);
    }
  });

  it("uses domain errors without ever embedding a presented ticket", async () => {
    const { manager } = rig();
    const secret = "ta1_presented-but-invalid-secret";
    try {
      await manager.redeem(secret, binding(uuid(101)));
      throw new Error("expected invalid ticket");
    } catch (error) {
      expect(error).toBeInstanceOf(AttachmentLeaseError);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
