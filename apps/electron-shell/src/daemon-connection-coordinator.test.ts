import {
  DesktopDaemonRefreshConnectionResultSchemaZ,
  type DesktopDaemonEvent,
  type DesktopDaemonHostState,
  type TerminalAttachmentIssueResult,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  DaemonConnectionCoordinator,
  type DaemonResourceAuthority,
} from "./daemon-connection-coordinator.ts";
import type { DaemonPreflight } from "./daemon-preflight.ts";

const A: Extract<DesktopDaemonHostState, { status: "connected" }> = {
  status: "connected",
  descriptor: {
    apiBaseUrl: "http://127.0.0.1:6060",
    protocolVersion: 1,
    productVersion: "2.8.0",
    instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
    startedAt: "2026-07-21T00:00:00.000Z",
  },
};

const B: Extract<DesktopDaemonHostState, { status: "connected" }> = {
  status: "connected",
  descriptor: {
    apiBaseUrl: "http://127.0.0.1:7070",
    protocolVersion: 1,
    productVersion: "2.8.0",
    instanceId: "3371dd7b-f76f-44e9-aefe-0e357a066056",
    startedAt: "2026-07-22T00:00:00.000Z",
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

function preflight(probe: () => Promise<DesktopDaemonHostState>): DaemonPreflight {
  return { probe: vi.fn(probe) };
}

interface BrokerHarness {
  readonly authority: DaemonResourceAuthority;
  readonly releaseRenderer: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly unsubscribe: ReturnType<typeof vi.fn>;
  publish(event: DesktopDaemonEvent): void;
  resolveList?(): void;
}

function brokerHarness(
  daemon: Extract<DesktopDaemonHostState, { status: "connected" }>,
  options: { readonly pendingList?: boolean; readonly earlyEvent?: DesktopDaemonEvent } = {},
): BrokerHarness {
  let listener: ((event: DesktopDaemonEvent) => void) | null = null;
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const releaseRenderer = vi.fn(() => {
    listener = null;
  });
  const dispose = vi.fn(() => {
    listener = null;
  });
  const pending = options.pendingList ? deferred<void>() : null;
  const identity = {
    protocolVersion: daemon.descriptor.protocolVersion,
    productVersion: daemon.descriptor.productVersion,
    instanceId: daemon.descriptor.instanceId,
    startedAt: daemon.descriptor.startedAt,
  };
  return {
    authority: {
      createWorkspacePane: async (request) => ({
        operationId: request.operationId,
        daemonInstanceId: identity.instanceId,
        outcome: "created",
        resource: {
          resourceVersion: 1,
          workspaceName: request.intent.workspaceName,
          semanticPaneId: `pane.${request.operationId.replaceAll("-", "")}`,
          kind: "terminal",
          displayTitle: "Terminal",
          harnessProfileId: null,
          role: null,
          missionId: null,
        },
      }),
      issueTerminalAttachment: async () => ({
        status: "error",
        error: {
          code: "attachment-unavailable",
          reason: "The terminal attachment is unavailable.",
          retryable: true,
        },
      }),
      listWorkspaces: async () => {
        await pending?.promise;
        return { status: "ok", daemon: identity, workspaces: [{ workspaceName: "product" }] };
      },
      fetchApplicationShell: async () => ({
        status: "error",
        error: { code: "workspace-not-found", reason: "not part of this test" },
      }),
      subscribe: async (_workspaceNames, nextListener) => {
        listener = nextListener;
        if (options.earlyEvent) nextListener(options.earlyEvent);
        return { status: "subscribed", unsubscribe };
      },
      releaseRenderer,
      dispose,
    },
    releaseRenderer,
    dispose,
    unsubscribe,
    publish: (event) => listener?.(event),
    resolveList: pending ? () => pending.resolve() : undefined,
  };
}

describe("main-process daemon connection coordinator", () => {
  it("keeps the broker and subscriptions intact when revalidation verifies the same identity", async () => {
    const sameA = {
      ...A,
      descriptor: { ...A.descriptor, apiBaseUrl: "http://localhost:6060" },
    } satisfies DesktopDaemonHostState;
    const first = brokerHarness(A, {
      earlyEvent: { type: "connection.changed", state: "live", error: null },
    });
    const createBroker = vi.fn(() => first.authority);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: preflight(async () => sameA),
      createBroker,
    });
    const events: DesktopDaemonEvent[] = [];
    expect((await coordinator.subscribe(["product"], (event) => events.push(event))).status).toBe(
      "subscribed",
    );

    const result = await coordinator.refreshConnection();
    first.publish({ type: "workspaces.changed" });

    expect(result).toMatchObject({
      outcome: "unchanged",
      daemon: { status: "connected", identity: { instanceId: A.descriptor.instanceId } },
    });
    expect(createBroker).toHaveBeenCalledOnce();
    expect(first.unsubscribe).not.toHaveBeenCalled();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "connection.changed", state: "live", error: null },
      { type: "workspaces.changed" },
    ]);
  });

  it("atomically replaces A with B, emits one generation event, and rejects late A activity", async () => {
    const first = brokerHarness(A);
    const second = brokerHarness(B);
    const createBroker = vi
      .fn<(daemon: typeof A | typeof B) => DaemonResourceAuthority>()
      .mockReturnValueOnce(first.authority)
      .mockReturnValueOnce(second.authority);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: preflight(async () => B),
      createBroker,
    });
    const events: DesktopDaemonEvent[] = [];
    await coordinator.subscribe(["product"], (event) => events.push(event));

    const result = await coordinator.refreshConnection();
    first.publish({ type: "workspaces.changed" });

    expect(DesktopDaemonRefreshConnectionResultSchemaZ.parse(result)).toMatchObject({
      outcome: "generation-replaced",
      previousIdentity: { instanceId: A.descriptor.instanceId },
      daemon: { status: "connected", identity: { instanceId: B.descriptor.instanceId } },
    });
    expect(events).toEqual([
      {
        type: "daemon-generation.changed",
        previousIdentity: expect.objectContaining({ instanceId: A.descriptor.instanceId }),
        daemon: expect.objectContaining({
          status: "connected",
          identity: expect.objectContaining({ instanceId: B.descriptor.instanceId }),
        }),
      },
    ]);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect((await coordinator.listWorkspaces()).status).toBe("ok");
  });

  it("retires connected authority on failed preflight without leaking its malformed payload", async () => {
    const first = brokerHarness(A);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: {
        probe: async () =>
          ({
            status: "connected",
            descriptor: {
              ...A.descriptor,
              apiBaseUrl: "http://secret@127.0.0.1:6060/private/path",
              token: "do-not-leak",
            },
          }) as unknown as DesktopDaemonHostState,
      },
      createBroker: () => first.authority,
    });
    const events: DesktopDaemonEvent[] = [];
    await coordinator.subscribe([], (event) => events.push(event));

    const result = await coordinator.refreshConnection();

    expect(result).toMatchObject({
      outcome: "authority-retired",
      daemon: { status: "degraded", code: "probe-failed" },
    });
    expect(JSON.stringify({ result, events })).not.toMatch(/secret|private\/path|token/iu);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(await coordinator.listWorkspaces()).toMatchObject({
      status: "error",
      error: { code: "daemon-degraded" },
    });
  });

  it("deduplicates concurrent refresh calls within one renderer generation", async () => {
    const next = deferred<DesktopDaemonHostState>();
    const probe = vi.fn(() => next.promise);
    const first = brokerHarness(A);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: { probe },
      createBroker: () => first.authority,
    });

    const one = coordinator.refreshConnection();
    const two = coordinator.refreshConnection();
    expect(one).toBe(two);
    next.resolve(A);

    await expect(one).resolves.toMatchObject({ outcome: "unchanged" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("bounds a stalled revalidation and retires stale connected authority", async () => {
    const first = brokerHarness(A);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: { probe: async () => new Promise(() => undefined) },
      preflightTimeoutMs: 10,
      createBroker: () => first.authority,
    });

    await expect(coordinator.refreshConnection()).resolves.toMatchObject({
      outcome: "authority-retired",
      daemon: { status: "unavailable", code: "probe-timeout" },
    });
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it("serializes across renderer release and discards the stale preflight result", async () => {
    const stale = deferred<DesktopDaemonHostState>();
    const current = deferred<DesktopDaemonHostState>();
    const probe = vi
      .fn<() => Promise<DesktopDaemonHostState>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    const first = brokerHarness(A);
    const second = brokerHarness(B);
    const createBroker = vi
      .fn<(daemon: typeof A | typeof B) => DaemonResourceAuthority>()
      .mockReturnValueOnce(first.authority)
      .mockReturnValueOnce(second.authority);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: { probe },
      createBroker,
    });

    const oldRefresh = coordinator.refreshConnection();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    coordinator.releaseRenderer();
    const currentRefresh = coordinator.refreshConnection();
    stale.resolve(B);
    await expect(oldRefresh).resolves.toMatchObject({ outcome: "superseded" });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
    current.resolve(B);

    await expect(currentRefresh).resolves.toMatchObject({
      outcome: "generation-replaced",
      daemon: { status: "connected", identity: { instanceId: B.descriptor.instanceId } },
    });
    expect(createBroker).toHaveBeenCalledTimes(2);
    expect(first.releaseRenderer).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it("returns an honest degraded state when constructing the replacement broker fails", async () => {
    const first = brokerHarness(A);
    const createBroker = vi
      .fn<(daemon: typeof A | typeof B) => DaemonResourceAuthority>()
      .mockReturnValueOnce(first.authority)
      .mockImplementationOnce(() => {
        throw new Error("constructor secret");
      });
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: preflight(async () => B),
      createBroker,
    });

    const result = await coordinator.refreshConnection();

    expect(result).toMatchObject({
      outcome: "authority-retired",
      daemon: { status: "degraded", code: "resource-broker-failed" },
    });
    expect(JSON.stringify(result)).not.toContain("constructor secret");
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(await coordinator.listWorkspaces()).toMatchObject({
      status: "error",
      error: { code: "daemon-degraded" },
    });
  });

  it("rejects an old broker result after a successful replacement", async () => {
    const first = brokerHarness(A, { pendingList: true });
    const second = brokerHarness(B);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: preflight(async () => B),
      createBroker: vi
        .fn<(daemon: typeof A | typeof B) => DaemonResourceAuthority>()
        .mockReturnValueOnce(first.authority)
        .mockReturnValueOnce(second.authority),
    });

    const oldList = coordinator.listWorkspaces();
    await coordinator.refreshConnection();
    first.resolveList?.();

    await expect(oldList).resolves.toMatchObject({
      status: "error",
      error: { code: "daemon-identity-mismatch" },
    });
  });

  it("rejects a resource result completed after renderer release", async () => {
    const first = brokerHarness(A, { pendingList: true });
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: preflight(async () => A),
      createBroker: () => first.authority,
    });

    const oldList = coordinator.listWorkspaces();
    coordinator.releaseRenderer();
    first.resolveList?.();

    await expect(oldList).resolves.toMatchObject({
      status: "error",
      error: { code: "disposed" },
    });
  });

  it("discards a one-use ticket completed after renderer release", async () => {
    const late = deferred<TerminalAttachmentIssueResult>();
    const first = brokerHarness(A);
    const authority: DaemonResourceAuthority = {
      ...first.authority,
      issueTerminalAttachment: async () => late.promise,
    };
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: preflight(async () => A),
      createBroker: () => authority,
    });
    const mutation = {
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedDaemonInstanceId: A.descriptor.instanceId,
      attachment: {
        protocolVersion: 1 as const,
        target: { workspaceName: "product", semanticPaneId: "pane.worker" },
        viewerMode: "interactive" as const,
        viewport: { cols: 120, rows: 40 },
      },
    };
    const result = coordinator.issueTerminalAttachment(mutation, "http://127.0.0.1:5173");
    coordinator.releaseRenderer();
    const ticket = `ta1_${"A".repeat(43)}`;
    late.resolve({
      status: "issued",
      descriptor: {
        protocolVersion: 1,
        webSocketUrl: "ws://127.0.0.1:6060/v1/terminal/attachments/redeem",
        subprotocol: "tmux-ide-terminal.v1",
        redemptionTicket: ticket,
        daemonInstanceId: A.descriptor.instanceId,
        requestId: mutation.requestId,
        expiresAt: Date.now() + 30_000,
        effectiveViewerMode: "interactive",
      },
    });

    await expect(result).resolves.toMatchObject({ status: "error", error: { code: "disposed" } });
    expect(JSON.stringify(await result)).not.toContain(ticket);
  });

  it("does not install a replacement resolved after app disposal", async () => {
    const next = deferred<DesktopDaemonHostState>();
    const first = brokerHarness(A);
    const second = brokerHarness(B);
    const createBroker = vi
      .fn<(daemon: typeof A | typeof B) => DaemonResourceAuthority>()
      .mockReturnValueOnce(first.authority)
      .mockReturnValueOnce(second.authority);
    const coordinator = new DaemonConnectionCoordinator({
      initialDaemon: A,
      preflight: { probe: () => next.promise },
      createBroker,
    });

    const refresh = coordinator.refreshConnection();
    coordinator.dispose();
    next.resolve(B);

    await expect(refresh).resolves.toMatchObject({ outcome: "superseded" });
    expect(createBroker).toHaveBeenCalledOnce();
    expect(first.dispose).toHaveBeenCalledOnce();
  });
});
