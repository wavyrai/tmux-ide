import { describe, expect, it } from "vitest";

import {
  DESKTOP_HOST_API_VERSION,
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
    ).toMatchObject({ apiVersion: 2, runtime: "electron" });
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
});
