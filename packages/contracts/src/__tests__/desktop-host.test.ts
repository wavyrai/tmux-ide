import { describe, expect, it } from "vitest";

import {
  DESKTOP_HOST_API_VERSION,
  DesktopApplicationShellTargetSchemaZ,
  DesktopDaemonCapabilityStateSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonEventSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopDaemonRefreshConnectionResultSchemaZ,
  DesktopDaemonPreflightSchemaZ,
  DesktopDaemonHostDescriptorSchemaZ,
  DesktopHostBootstrapSchemaZ,
} from "../desktop-host.ts";

describe("desktop host contract", () => {
  it("accepts a bounded, versioned bootstrap payload", () => {
    expect(
      DesktopHostBootstrapSchemaZ.parse({
        apiVersion: DESKTOP_HOST_API_VERSION,
        runtime: "electron",
        platform: "darwin",
        appVersion: "2.8.0",
        theme: { mode: "dark", highContrast: false, reducedMotion: false },
        window: { maximized: false, fullscreen: false, focused: true },
        daemon: { status: "unavailable", code: "record-missing", reason: "owner not installed" },
      }),
    ).toMatchObject({ apiVersion: 5, runtime: "electron" });
  });

  it("does not permit unversioned daemon metadata to leak into the facade", () => {
    expect(() =>
      DesktopDaemonPreflightSchemaZ.parse({
        status: "connected",
        descriptor: {
          apiBaseUrl: "http://127.0.0.1:6060",
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
          startedAt: "2026-07-21T00:00:00.000Z",
        },
        pid: 42,
      }),
    ).toThrow();
  });

  it("exposes only an uncredentialed loopback daemon descriptor", () => {
    const descriptor = {
      apiBaseUrl: "http://127.0.0.1:6060",
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
      startedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(DesktopDaemonHostDescriptorSchemaZ.parse(descriptor)).toEqual(descriptor);
    expect(
      DesktopDaemonHostDescriptorSchemaZ.safeParse({
        ...descriptor,
        apiBaseUrl: "http://192.0.2.1:6060",
      }).success,
    ).toBe(false);
    expect(
      DesktopDaemonHostDescriptorSchemaZ.safeParse({
        ...descriptor,
        apiBaseUrl: "http://secret@127.0.0.1:6060",
      }).success,
    ).toBe(false);
    expect(
      DesktopDaemonHostDescriptorSchemaZ.safeParse({
        ...descriptor,
        authToken: "must-not-cross-ipc",
      }).success,
    ).toBe(false);
  });

  it("rejects malformed or secret-bearing application-shell targets", () => {
    const target = {
      daemon: {
        protocolVersion: 1,
        productVersion: "2.8.0",
        instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
        startedAt: "2026-07-21T00:00:00.000Z",
      },
      workspaceName: " project ",
    };
    expect(DesktopApplicationShellTargetSchemaZ.parse(target).workspaceName).toBe("project");
    expect(
      DesktopApplicationShellTargetSchemaZ.safeParse({ ...target, token: "secret" }).success,
    ).toBe(false);
    expect(DesktopApplicationShellTargetSchemaZ.safeParse(null).success).toBe(false);
  });

  it("keeps the renderer-visible connected state identity-only", () => {
    const identity = {
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
      startedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(DesktopDaemonCapabilityStateSchemaZ.parse({ status: "connected", identity })).toEqual({
      status: "connected",
      identity,
    });
    for (const forbidden of [
      { apiBaseUrl: "http://127.0.0.1:6060" },
      { token: "secret" },
      { sessionName: "raw-session" },
    ]) {
      expect(
        DesktopDaemonCapabilityStateSchemaZ.safeParse({
          status: "connected",
          identity,
          ...forbidden,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts only bounded semantic daemon capability messages", () => {
    expect(
      DesktopDaemonFetchApplicationShellRequestSchemaZ.parse({ workspaceName: " product " }),
    ).toEqual({ workspaceName: "product" });
    expect(
      DesktopDaemonFetchApplicationShellRequestSchemaZ.parse({
        workspaceName: "product",
        resourceVersion: 2,
      }),
    ).toEqual({ workspaceName: "product", resourceVersion: 2 });
    expect(
      DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse({
        workspaceName: "product",
        resourceVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse({
        workspaceName: "product",
        sessionName: "raw-session",
      }).success,
    ).toBe(false);
    expect(
      DesktopDaemonEventSubscriptionRequestSchemaZ.safeParse({
        workspaceNames: ["product", "product"],
      }).success,
    ).toBe(false);
    expect(DesktopDaemonEventSubscriptionRequestSchemaZ.parse({ workspaceNames: [] })).toEqual({
      workspaceNames: [],
    });
    expect(
      DesktopDaemonListWorkspacesResultSchemaZ.safeParse({
        status: "ok",
        daemon: {
          protocolVersion: 1,
          productVersion: "2.8.0",
          instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
          startedAt: "2026-07-21T00:00:00.000Z",
        },
        workspaces: [{ workspaceName: "product", projectDir: "/private/leak" }],
      }).success,
    ).toBe(false);
  });

  it("models daemon replacement without exposing main-process connection material", () => {
    const identity = {
      protocolVersion: 1,
      productVersion: "2.8.0",
      instanceId: "3371dd7b-f76f-44e9-aefe-0e357a066056",
      startedAt: "2026-07-22T00:00:00.000Z",
    };
    const result = {
      outcome: "generation-replaced",
      previousIdentity: null,
      daemon: { status: "connected", identity },
    };
    expect(DesktopDaemonRefreshConnectionResultSchemaZ.parse(result)).toEqual(result);
    expect(
      DesktopDaemonRefreshConnectionResultSchemaZ.safeParse({
        ...result,
        apiBaseUrl: "http://127.0.0.1:6060",
      }).success,
    ).toBe(false);
    expect(
      DesktopDaemonEventSchemaZ.parse({
        type: "daemon-generation.changed",
        previousIdentity: identity,
        daemon: { status: "unavailable", code: "record-missing", reason: "not running" },
      }),
    ).toMatchObject({ type: "daemon-generation.changed" });
    expect(
      DesktopDaemonEventSchemaZ.safeParse({
        type: "daemon-generation.changed",
        previousIdentity: identity,
        daemon: { status: "connected", identity, sessionName: "raw-session" },
      }).success,
    ).toBe(false);
  });
});
