import { describe, expect, it } from "vitest";

import {
  DESKTOP_HOST_API_VERSION,
  DesktopDaemonPreflightSchemaZ,
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
        daemon: { status: "deferred", reason: "owner not installed" },
      }),
    ).toMatchObject({ apiVersion: 1, runtime: "electron" });
  });

  it("does not permit unversioned daemon metadata to leak into the facade", () => {
    expect(() =>
      DesktopDaemonPreflightSchemaZ.parse({
        status: "ready",
        apiBaseUrl: "http://127.0.0.1:6060",
        pid: 42,
      }),
    ).toThrow();
  });
});
