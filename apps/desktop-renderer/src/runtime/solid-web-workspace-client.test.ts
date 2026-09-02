import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRuntimeAuthoritySnapshot } from "@tmux-ide/contracts";

const mocks = vi.hoisted(() => ({
  client: null as null | Record<string, unknown>,
}));

vi.mock("./web-workspace-client.ts", () => ({
  createWebWorkspaceClient: () => mocks.client,
  paneStreamBridgeForWebWorkspaceClient: () => ({}),
}));

import { createSolidWebWorkspaceClient } from "./solid-web-workspace-client.ts";

const host = globalThis as typeof globalThis & {
  __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__?: unknown;
  __TMUX_IDE_CARD5_AUTHORITY_CONTROL__?: {
    release(input: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  };
  __TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?: () => Record<string, unknown>;
};

afterEach(() => {
  delete host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__;
  delete host.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__;
  delete host.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__;
  delete host.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__;
  mocks.client = null;
});

describe("Card5 exact Web authority control", () => {
  it("releases only the exact descriptor/session-bound current owner and fences stale completion", async () => {
    const authority: SessionRuntimeAuthoritySnapshot = {
      generation: "daemon-a",
      session: "runtime-a",
      revision: 7,
      owners: { input: "web-a", focus: null, geometry: null },
      nativeGeometryYieldUntilMs: 0,
      clients: [
        {
          clientId: "web-a",
          surface: "web",
          state: "foreground",
          connectedRevision: 1,
          activityRevision: 1,
        },
      ],
    };
    let snapshot = {
      generation: 1,
      phase: "live",
      target: { workspaceName: "workspace-a", daemon: { instanceId: "daemon-a" } },
      authority,
    };
    let localAuthorityClientId: string | null = "web-a";
    const releaseAuthority = vi.fn(async (kind: string) => {
      localAuthorityClientId = null;
      const released = {
        ...authority,
        revision: 8,
        owners: { ...authority.owners, [kind]: null },
      };
      snapshot = { ...snapshot, authority: released };
      return released;
    });
    mocks.client = {
      getSnapshot: () => snapshot,
      getMetrics: () => ({}),
      subscribe: () => () => undefined,
      setTarget: vi.fn(),
      refresh: vi.fn(),
      ownsRuntimeAuthority: (kind: string) => authority.owners[kind as "input"] === "web-a",
      runtimeAuthorityClientId: () => localAuthorityClientId,
      releaseAuthority,
      dispose: vi.fn(async () => undefined),
    };
    host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
    host.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ = () => ({
      activeLifecycleRequests: [
        {
          generation: "daemon-a",
          requestId: "request-a",
          workspaceName: "workspace-a",
          semanticPaneIds: ["pane-a"],
        },
      ],
      descriptorEvents: [{ generation: "daemon-a", requestId: "request-a" }],
    });
    let disposeRoot: () => void = () => undefined;
    createRoot((dispose) => {
      disposeRoot = dispose;
      createSolidWebWorkspaceClient({
        host: {} as never,
        target: { workspaceName: "workspace-a", daemon: { instanceId: "daemon-a" } } as never,
      });
    });
    const exact = {
      version: 1,
      workspaceName: "workspace-a",
      generation: "daemon-a",
      runtimeSession: "runtime-a",
      semanticPaneId: "pane-a",
      requestId: "request-a",
      clientId: "web-a",
      authority: "input",
    };
    await expect(host.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__?.release(exact)).resolves.toMatchObject({
      status: "released",
      operationOrdinal: 1,
      beforeRevision: 7,
      afterRevision: 8,
      owner: null,
    });
    expect(releaseAuthority).toHaveBeenCalledTimes(1);
    const staleAuthority: SessionRuntimeAuthoritySnapshot = {
      ...authority,
      revision: 9,
      owners: { ...authority.owners, input: "web-a" },
    };
    localAuthorityClientId = "web-a";
    snapshot = { ...snapshot, generation: 2, authority: staleAuthority };
    let settleRelease!: (value: typeof staleAuthority) => void;
    releaseAuthority.mockImplementationOnce(
      () => new Promise((resolve) => (settleRelease = resolve)),
    );
    const staleCompletion = host.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__?.release(exact);
    await Promise.resolve();
    snapshot = {
      ...snapshot,
      generation: 3,
      target: { workspaceName: "workspace-b", daemon: { instanceId: "daemon-b" } },
    };
    settleRelease({
      ...staleAuthority,
      revision: 10,
      owners: { ...staleAuthority.owners, input: null },
    });
    await expect(staleCompletion).resolves.toBeNull();
    expect(releaseAuthority).toHaveBeenCalledTimes(2);
    snapshot = {
      ...snapshot,
      generation: 1,
      target: { workspaceName: "workspace-a", daemon: { instanceId: "daemon-a" } },
      authority,
    };
    localAuthorityClientId = null;
    await expect(host.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__?.release(exact)).resolves.toBeNull();
    expect(releaseAuthority).toHaveBeenCalledTimes(2);
    for (const changed of [
      { ...exact, requestId: "request-b" },
      { ...exact, runtimeSession: "runtime-b" },
      { ...exact, clientId: "web-b" },
      { ...exact, generation: "daemon-b" },
      { ...exact, extra: true },
    ]) {
      await expect(host.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__?.release(changed)).resolves.toBeNull();
    }
    expect(releaseAuthority).toHaveBeenCalledTimes(2);
    disposeRoot();
    expect(host.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__).toBeUndefined();
  });
});
