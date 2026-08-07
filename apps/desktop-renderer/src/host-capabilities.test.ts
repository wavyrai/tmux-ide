import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAEMON_RESOURCE_KINDS,
  DESKTOP_HOST_API_VERSION,
  createDaemonResourceMethods,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { readHostBootstrap, resolveHostCapabilities } from "./host-capabilities.ts";

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("document", { fullscreenElement: null, hasFocus: () => true });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

describe("renderer host capabilities", () => {
  it("falls back to the browser implementation without desktop globals", async () => {
    const host = resolveHostCapabilities(null);
    expect(await host.bootstrap()).toMatchObject({
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "browser",
      platform: "darwin",
    });
    await expect(host.daemon.listWorkspaces()).resolves.toMatchObject({
      status: "error",
      error: { code: "preview-only" },
    });
    await expect(
      host.daemon.fetchApplicationShell({ workspaceName: "preview" }),
    ).resolves.toMatchObject({ status: "error", error: { code: "preview-only" } });
    await expect(
      host.daemon.subscribe({ workspaceNames: ["preview"] }, vi.fn()),
    ).resolves.toMatchObject({ status: "error", error: { code: "preview-only" } });
    await expect(host.daemon.refreshConnection()).resolves.toMatchObject({
      outcome: "unchanged",
      daemon: { status: "unavailable", code: "preview-only" },
    });
    await expect(host.workspace.openProjectDirectory()).resolves.toBeNull();
  });

  it("does not silently downgrade a present incompatible preload object", () => {
    expect(() => resolveHostCapabilities({ apiVersion: 2, send: () => undefined })).toThrow(
      "present but incompatible",
    );
  });

  it("validates payloads returned by an otherwise typed preload", async () => {
    const host = {
      ...resolveHostCapabilities(null),
      bootstrap: async () => ({ invalid: true }),
    } as unknown as HostCapabilities;
    await expect(readHostBootstrap(host)).rejects.toThrow();
  });

  it("answers every declared resource in browser preview", async () => {
    const host = resolveHostCapabilities(null);
    for (const resource of DAEMON_RESOURCE_KINDS) {
      const method = host.daemon[resource] as (request?: unknown) => Promise<unknown>;
      expect(typeof method, resource).toBe("function");
      // Preview refuses, but it never leaves a resource unimplemented: the
      // methods come from the same list the facade check reads.
      await expect(method({}), resource).resolves.toBeTypeOf("object");
    }
  });

  it("rejects a bridge that is missing any single daemon resource", () => {
    const complete = resolveHostCapabilities(null);
    for (const missing of DAEMON_RESOURCE_KINDS) {
      const daemon: Record<string, unknown> = {
        ...createDaemonResourceMethods(async () => ({ status: "error" })),
        subscribe: complete.daemon.subscribe,
      };
      delete daemon[missing];
      expect(() => resolveHostCapabilities({ ...complete, daemon }), missing).toThrow(
        "present but incompatible",
      );
    }
  });

  it("no longer exposes the four members that had no caller", () => {
    const host = resolveHostCapabilities(null) as unknown as Record<
      string,
      Record<string, unknown>
    >;
    expect(host.lifecycle).toBeUndefined();
    expect(host.menu).toBeUndefined();
    expect(host.window?.getState).toBeUndefined();
    expect(host.theme?.getState).toBeUndefined();
  });
});
