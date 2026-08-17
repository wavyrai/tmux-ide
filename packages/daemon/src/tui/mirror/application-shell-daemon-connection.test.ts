import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  type CanonicalDaemonInfo,
  type WorkspaceCatalogResourceV2,
} from "@tmux-ide/contracts";
import type { TerminalFirstDaemonTransport } from "@tmux-ide/daemon-client/direct-application-shell-transport";

import {
  openTuiDaemonDescriptor,
  prepareOpenTuiApplicationShellConnection,
  resolveOpenTuiApplicationShellConnection,
  type OpenTuiApplicationShellConnectionDependencies,
} from "./application-shell-daemon-connection.ts";

const daemon: CanonicalDaemonInfo = {
  pid: 42,
  port: 6060,
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "11111111-1111-4111-8111-111111111111",
  startedAt: "2026-08-09T12:00:00.000Z",
  bindHostname: "127.0.0.1",
  authToken: "owner-secret",
};

const catalog = {
  version: 2,
  daemon: {
    protocolVersion: daemon.protocolVersion,
    productVersion: daemon.productVersion,
    instanceId: daemon.instanceId,
    startedAt: daemon.startedAt,
  },
  intents: [
    {
      workspaceName: "workspace.alpha",
      sessionName: "alpha",
      source: "workspace",
      availability: "live",
    },
  ],
  liveSessions: [
    {
      sessionName: "alpha",
      fleetSessionId: "session.aaaaaaaaaaaaaaaaaaaa",
      paneCount: 1,
    },
  ],
} as WorkspaceCatalogResourceV2;

function transport(
  prepareTerminalRuntimeInventory = vi.fn(async () => ({
    resource: {
      workspaceName: "workspace.alpha",
      workspaceId: "workspace.0123456789abcdefabcd",
      sessionId: "session.0123456789abcdefabcd",
      resourceRevision: 0,
      semanticPaneIds: ["pane.alpha"],
    },
    consume: vi.fn(() => null),
    dispose: vi.fn(),
  })),
): TerminalFirstDaemonTransport {
  return {
    validateTarget: (value) => value as never,
    fetchApplicationShell: vi.fn(async () => ({ terminalInventory: { resources: [] } })) as never,
    connectEvents: () => ({ close: vi.fn() }),
    prepareTerminalRuntimeInventory,
    adoptTerminalRuntimeInventory: vi.fn(() => null),
    disposeEventSupervisor: vi.fn(),
    selectApplicationShellFallback: vi.fn(),
    refreshTerminalRuntimeInventory: vi.fn(),
  } as unknown as TerminalFirstDaemonTransport;
}

describe("OpenTUI canonical daemon connection", () => {
  it("derives an uncredentialed host descriptor", () => {
    expect(openTuiDaemonDescriptor(daemon)).toEqual({
      apiBaseUrl: "http://127.0.0.1:6060/",
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
    });
  });

  it("resolves transport capabilities without constructing a client session", async () => {
    const baseTransport = transport();
    const createTransport = vi.fn(() => baseTransport);
    const connection = await resolveOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      createTransport,
    });

    expect(connection).toMatchObject({
      workspaceName: "workspace.alpha",
      target: { workspaceName: "workspace.alpha" },
    });
    expect(connection?.transport.prepareTerminalRuntimeInventory).toBeTypeOf("function");
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptor: openTuiDaemonDescriptor(daemon),
        ownerToken: "owner-secret",
        sessionName: "alpha",
        workspaceName: "workspace.alpha",
        applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      }),
    );
    expect(createTransport.mock.calls[0]![0]).not.toHaveProperty("terminalRuntimeDiagnostic");

    connection?.dispose();
    expect(() =>
      connection?.routing?.assertCurrent({
        daemonInstanceId: daemon.instanceId,
        workspaceName: "workspace.alpha",
        sessionName: "alpha",
      }),
    ).toThrow("has been retired");
  });

  it("returns null before allocating a transport when the session is not live", async () => {
    const createTransport = vi.fn();
    const connection = await resolveOpenTuiApplicationShellConnection("missing", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      createTransport,
    });

    expect(connection).toBeNull();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("prepares an already-routed warm session with one liveness and catalog read", async () => {
    const isCanonicalDaemonAlive = vi.fn(async () => true);
    const fetchCanonicalWorkspaceRouting = vi.fn(async () => catalog);
    const ensureSessionWorkspace = vi.fn(async () => true);
    const createTransport = vi.fn(() => transport());

    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive,
      fetchCanonicalWorkspaceRouting,
      ensureSessionWorkspace,
      createTransport,
    });

    expect(prepared?.workspaceName).toBe("workspace.alpha");
    expect(isCanonicalDaemonAlive).toHaveBeenCalledOnce();
    expect(fetchCanonicalWorkspaceRouting).toHaveBeenCalledOnce();
    expect(ensureSessionWorkspace).not.toHaveBeenCalled();
    expect(createTransport).toHaveBeenCalledOnce();
  });

  it("retains promote-then-resolve fallback for an ordinary live session", async () => {
    const unrouted = { ...catalog, intents: [] } satisfies WorkspaceCatalogResourceV2;
    const fetchCanonicalWorkspaceRouting = vi
      .fn<() => Promise<WorkspaceCatalogResourceV2>>()
      .mockResolvedValueOnce(unrouted)
      .mockResolvedValueOnce(catalog);
    const ensureSessionWorkspace = vi.fn(async () => true);
    const createTransport = vi.fn(() => transport());

    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting,
      ensureSessionWorkspace,
      createTransport,
    });

    expect(prepared?.workspaceName).toBe("workspace.alpha");
    expect(fetchCanonicalWorkspaceRouting).toHaveBeenCalledTimes(2);
    expect(ensureSessionWorkspace).toHaveBeenCalledOnce();
    expect(createTransport).toHaveBeenCalledOnce();
  });

  it("fails closed on stale routing without allocating a transport", async () => {
    const createTransport = vi.fn();
    const staleCatalog = {
      ...catalog,
      daemon: { ...catalog.daemon, instanceId: "22222222-2222-4222-8222-222222222222" },
    } satisfies WorkspaceCatalogResourceV2;

    await expect(
      resolveOpenTuiApplicationShellConnection("alpha", {
        readCanonicalDaemonInfo: () => daemon,
        isCanonicalDaemonAlive: async () => true,
        fetchCanonicalWorkspaceRouting: async () => staleCatalog,
        createTransport,
      }),
    ).resolves.toBeNull();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("retains one terminal preparation and never starts V2 before the host decision", async () => {
    let preparationSignal!: AbortSignal;
    const prepare = vi.fn((_target, signal: AbortSignal) => {
      preparationSignal = signal;
      return new Promise<never>(() => undefined);
    });
    const baseTransport = transport(prepare);
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport: () => baseTransport,
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(baseTransport.fetchApplicationShell).not.toHaveBeenCalled();
    expect(prepared!.prepareTerminalRuntimeInventory()).toBe(
      prepared!.prepareTerminalRuntimeInventory(),
    );
    prepared!.dispose();
    expect(preparationSignal.aborted).toBe(true);
    expect(baseTransport.disposeEventSupervisor).toHaveBeenCalledOnce();
  });

  it("fully selects V2 fallback after terminal preparation rejection", async () => {
    const diagnostics: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const lifecycleOrder: string[] = [];
    const baseTransport = transport(
      vi.fn(async () => {
        lifecycleOrder.push("preparation-started");
        throw new Error("unsupported");
      }),
    );
    baseTransport.selectApplicationShellFallback.mockImplementation(() => {
      lifecycleOrder.push("fallback-selected");
    });
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport: () => baseTransport,
      onDiagnostic: (phase, details) => {
        diagnostics.push({ phase, details });
        if (phase === "application-shell-prewarm-start") lifecycleOrder.push("start-marked");
        if (phase === "application-shell-prewarm-settled") lifecycleOrder.push("settled-marked");
        throw new Error("diagnostic sink failed");
      },
    });
    await expect(prepared!.prepareTerminalRuntimeInventory()).resolves.toBeNull();
    expect(baseTransport.selectApplicationShellFallback).toHaveBeenCalledWith(
      "preparation-rejected",
    );
    expect(diagnostics.at(-1)).toMatchObject({
      phase: "application-shell-prewarm-settled",
      details: { outcome: "rejected", fallbackReason: "preparation-rejected" },
    });
    expect(lifecycleOrder).toEqual([
      "preparation-started",
      "start-marked",
      "fallback-selected",
      "settled-marked",
    ]);
    prepared!.dispose();
  });

  it("reports the bounded deadline fallback reason without changing the one-second policy", async () => {
    vi.useFakeTimers();
    try {
      const diagnostics: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
      const baseTransport = transport(
        vi.fn(
          (_target, signal: AbortSignal) =>
            new Promise<never>((_resolve, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
            ),
        ),
      );
      const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
        readCanonicalDaemonInfo: () => daemon,
        isCanonicalDaemonAlive: async () => true,
        fetchCanonicalWorkspaceRouting: async () => catalog,
        ensureSessionWorkspace: async () => true,
        createTransport: () => baseTransport,
        onDiagnostic: (phase, details) => diagnostics.push({ phase, details }),
      });
      const terminal = prepared!.prepareTerminalRuntimeInventory();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(terminal).resolves.toBeNull();
      expect(diagnostics.at(-1)).toMatchObject({
        phase: "application-shell-prewarm-settled",
        details: { outcome: "aborted", fallbackReason: "deadline" },
      });
      expect(baseTransport.selectApplicationShellFallback).toHaveBeenCalledWith("deadline");
      prepared!.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fully selects V2 fallback when terminal preparation is aborted", async () => {
    const prepare = vi.fn(
      (_target, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const baseTransport = transport(prepare);
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport: () => baseTransport,
    });
    prepared!.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(baseTransport.selectApplicationShellFallback).toHaveBeenCalledWith("retired");
  });

  it("emits bounded opt-in terminal preparation evidence without credentials", async () => {
    const diagnostics: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const createTransport: OpenTuiApplicationShellConnectionDependencies["createTransport"] = vi.fn(
      (options) => {
        options.terminalRuntimeDiagnostic?.("terminal-event-socket-create", {});
        return transport();
      },
    );
    const prepared = await prepareOpenTuiApplicationShellConnection("alpha", {
      readCanonicalDaemonInfo: () => daemon,
      isCanonicalDaemonAlive: async () => true,
      fetchCanonicalWorkspaceRouting: async () => catalog,
      ensureSessionWorkspace: async () => true,
      createTransport,
      onDiagnostic: (phase, details) => diagnostics.push({ phase, details }),
    });
    await prepared!.prepareTerminalRuntimeInventory();
    expect(diagnostics).toContainEqual({
      phase: "application-shell-prewarm-settled",
      details: {
        ordinal: 0,
        outcome: "fulfilled",
        resource: "terminal-runtime-inventory",
        daemonGeneration: daemon.instanceId,
      },
    });
    expect(diagnostics[0]).toEqual({ phase: "terminal-event-socket-create", details: {} });
    expect(JSON.stringify(diagnostics)).not.toContain(daemon.authToken);
    prepared!.dispose();
  });
});
