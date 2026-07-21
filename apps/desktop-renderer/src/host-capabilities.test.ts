import { beforeEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_HOST_API_VERSION, type HostCapabilities } from "@tmux-ide/contracts";
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
});
