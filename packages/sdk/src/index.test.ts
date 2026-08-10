import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_RESOURCE_KINDS,
  DESKTOP_HOST_API_VERSION,
  createDaemonResourceMethods,
  type DaemonResourceRequest,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { createTmuxIdeDaemonSdk, createTmuxIdeOwnerSdk, createTmuxIdeSdk } from "./index.ts";

function createHost(dispatch: (request: DaemonResourceRequest) => Promise<unknown>) {
  const host: HostCapabilities = {
    apiVersion: DESKTOP_HOST_API_VERSION,
    bootstrap: async () => ({
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "browser",
      platform: "darwin",
      appVersion: "test",
      theme: { mode: "dark", highContrast: false, reducedMotion: false },
      window: { maximized: false, fullscreen: false, focused: true },
      daemon: { status: "unavailable", code: "preview-only", reason: "test" },
      onboarding: { introAcknowledged: true },
    }),
    window: {
      minimize: async () => ({ maximized: false, fullscreen: false, focused: true }),
      toggleMaximized: async () => ({ maximized: true, fullscreen: false, focused: true }),
      close: async () => undefined,
      onStateChanged: () => () => undefined,
    },
    workspace: { openProjectDirectory: async () => null },
    onboarding: { acknowledgeIntro: async () => undefined },
    theme: { onChanged: () => () => undefined },
    update: {
      getStatus: async () => ({
        phase: "idle",
        currentVersion: "test",
        availableVersion: null,
      }),
      onStatusChanged: () => () => undefined,
    },
    daemon: {
      ...createDaemonResourceMethods(dispatch),
      subscribe: async () => ({ status: "subscribed", unsubscribe: () => undefined }),
    },
  };
  return host;
}

describe("createTmuxIdeSdk", () => {
  it("creates the same validated daemon SDK without desktop-only capabilities", async () => {
    const dispatch = vi.fn(async () => ({
      status: "error",
      error: { code: "daemon-unavailable", reason: "offline" },
    }));
    const daemon = createHost(dispatch).daemon;
    const sdk = createTmuxIdeDaemonSdk(daemon);

    await expect(sdk.request({ resource: "capabilities" })).resolves.toEqual({
      status: "error",
      error: { code: "daemon-unavailable", reason: "offline" },
    });
    expect(sdk.resources).toEqual(DAEMON_RESOURCE_KINDS);
    expect(dispatch).toHaveBeenCalledWith({ resource: "capabilities" });
  });

  it("rejects incomplete daemon-only hosts before making a request", () => {
    expect(() => createTmuxIdeDaemonSdk({ subscribe: async () => ({ status: "error" }) })).toThrow(
      /incomplete/,
    );
  });

  it("exposes the complete derived daemon vocabulary", () => {
    const sdk = createTmuxIdeSdk(createHost(async () => ({ status: "error" })));

    expect(sdk.daemon.resources).toEqual(DAEMON_RESOURCE_KINDS);
    for (const resource of DAEMON_RESOURCE_KINDS) {
      expect(sdk.daemon[resource]).toBeTypeOf("function");
    }
  });

  it("supports generic typed requests and validates daemon responses", async () => {
    const dispatch = vi.fn(async () => ({
      status: "error",
      error: { code: "daemon-unavailable", reason: "offline" },
    }));
    const sdk = createTmuxIdeSdk(createHost(dispatch));

    await expect(sdk.daemon.request({ resource: "capabilities" })).resolves.toEqual({
      status: "error",
      error: { code: "daemon-unavailable", reason: "offline" },
    });
    expect(dispatch).toHaveBeenCalledWith({ resource: "capabilities" });

    const invalidSdk = createTmuxIdeSdk(createHost(async () => ({ status: "surprise" })));
    await expect(invalidSdk.daemon.request({ resource: "capabilities" })).rejects.toThrow();
  });

  it("validates bootstrap, state callbacks, and pushed daemon events", async () => {
    let daemonListener: ((event: DesktopDaemonEvent) => void) | undefined;
    const baseHost = createHost(async () => ({ status: "error" }));
    const subscribe: HostCapabilities["daemon"]["subscribe"] = vi.fn(async (_request, listener) => {
      daemonListener = listener;
      return { status: "subscribed" as const, unsubscribe: () => undefined };
    });
    const host: HostCapabilities = {
      ...baseHost,
      daemon: { ...baseHost.daemon, subscribe },
    };
    const sdk = createTmuxIdeSdk(host);
    const listener = vi.fn();

    await expect(sdk.bootstrap()).resolves.toMatchObject({ appVersion: "test" });
    await expect(
      sdk.daemon.subscribe({ workspaceNames: ["alpha"] }, listener),
    ).resolves.toMatchObject({ status: "subscribed" });
    daemonListener?.({ type: "workspaces.changed" });
    expect(listener).toHaveBeenCalledWith({ type: "workspaces.changed" });
  });

  it("rejects incomplete or version-skewed hosts before any call", () => {
    expect(() => createTmuxIdeSdk({ apiVersion: DESKTOP_HOST_API_VERSION })).toThrow(
      /incompatible/,
    );
    expect(() => createTmuxIdeSdk({ ...createHost(async () => ({})), apiVersion: 999 })).toThrow(
      /incompatible/,
    );
  });
});

describe("createTmuxIdeOwnerSdk", () => {
  it("sends one semantic SDK action and never exposes its literal input in the result", async () => {
    const request = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body)) as { text: string };
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            verb: "workspace.pane.send",
            outcome: "applied",
            operationId: init?.headers
              ? (init.headers as Record<string, string>)["X-Tmux-Ide-Operation-Id"]
              : "",
            daemonInstanceId: "11111111-1111-4111-8111-111111111111",
            workspaceName: "alpha",
            sourceSemanticPaneId: "pane.agent",
            semanticPaneId: "pane.editor",
            origin: "sdk",
            characterCount: Array.from(parsed.text).length,
            byteCount: new TextEncoder().encode(parsed.text).length,
            submitted: true,
          },
        }),
      );
    });
    const sdk = createTmuxIdeOwnerSdk({
      baseUrl: "http://127.0.0.1:4020/",
      ownerToken: "secret",
      fetch: request as typeof fetch,
    });
    const result = await sdk.sendPane(
      {
        workspaceName: "alpha",
        sourceSemanticPaneId: "pane.agent",
        semanticPaneId: "pane.editor",
        text: "private prompt",
        submit: true,
      },
      { operationId: "10000000-0000-4000-8000-000000000001" },
    );

    expect(result).toMatchObject({ origin: "sdk", characterCount: 14, submitted: true });
    expect(JSON.stringify(result)).not.toContain("private prompt");
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      sourceSemanticPaneId: "pane.agent",
    });
  });

  it("retries an ambiguous transport failure with the same operation id", async () => {
    const operationIds: string[] = [];
    const request = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      operationIds.push((init?.headers as Record<string, string>)["X-Tmux-Ide-Operation-Id"]!);
      if (operationIds.length === 1) throw new Error("response lost");
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            verb: "workspace.pane.send",
            outcome: "replayed",
            operationId: operationIds[0],
            daemonInstanceId: "11111111-1111-4111-8111-111111111111",
            workspaceName: "alpha",
            sourceSemanticPaneId: null,
            semanticPaneId: "pane.editor",
            origin: "sdk",
            characterCount: 2,
            byteCount: 2,
            submitted: false,
          },
        }),
      );
    });
    const sdk = createTmuxIdeOwnerSdk({
      baseUrl: "http://127.0.0.1:4020/",
      ownerToken: "secret",
      fetch: request as typeof fetch,
    });

    await expect(
      sdk.sendPane(
        { workspaceName: "alpha", semanticPaneId: "pane.editor", text: "hi", submit: false },
        { operationId: "10000000-0000-4000-8000-000000000002" },
      ),
    ).resolves.toMatchObject({ outcome: "replayed" });
    expect(operationIds).toEqual([
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000002",
    ]);
  });
});
