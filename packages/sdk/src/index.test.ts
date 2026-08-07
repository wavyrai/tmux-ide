import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_RESOURCE_KINDS,
  DESKTOP_HOST_API_VERSION,
  createDaemonResourceMethods,
  type DaemonResourceRequest,
  type DesktopDaemonEvent,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { createTmuxIdeSdk } from "./index.ts";

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
