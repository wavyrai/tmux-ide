import { describe, expect, it } from "vitest";

import {
  loopbackHttpOriginOrNull,
  resolveDevWebHostConfig,
  webSocketOriginFor,
  type DevWebHostResolutionInput,
} from "./dev-web-host-config.ts";

const ACTIVE: DevWebHostResolutionInput = {
  developmentBuild: true,
  hostBridgePresent: false,
  optInFlag: "1",
  optInQuery: undefined,
  daemonUrl: "http://127.0.0.1:8787",
  ownerToken: "owner-token",
};

describe("loopbackHttpOriginOrNull", () => {
  it("accepts a canonical loopback origin with a port", () => {
    expect(loopbackHttpOriginOrNull("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(loopbackHttpOriginOrNull("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("refuses every off-machine or non-canonical form", () => {
    for (const value of [
      undefined,
      "",
      "http://10.0.0.4:8787",
      "http://example.com:8787",
      "http://127.0.0.1", // no port: refuses the ambiguous default
      "https://127.0.0.1", // no port
      "file:///tmp",
      "ws://127.0.0.1:8787",
      "http://user:pass@127.0.0.1:8787",
      "http://127.0.0.1:8787/api",
      "http://127.0.0.1:8787?x=1",
      "http://127.0.0.1:8787#f",
      "http://127.0.0.1:8787\r\nX-Injected: 1",
      "not a url",
    ]) {
      expect(loopbackHttpOriginOrNull(value)).toBeNull();
    }
  });

  it("maps an http origin onto its websocket sibling", () => {
    expect(webSocketOriginFor("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787");
    expect(webSocketOriginFor("https://127.0.0.1:8787")).toBe("wss://127.0.0.1:8787");
  });
});

describe("resolveDevWebHostConfig", () => {
  it("activates when every factor holds", () => {
    const resolution = resolveDevWebHostConfig(ACTIVE);
    expect(resolution).toEqual({
      status: "active",
      config: {
        daemonOrigin: "http://127.0.0.1:8787",
        daemonWebSocketOrigin: "ws://127.0.0.1:8787",
        ownerToken: "owner-token",
      },
    });
  });

  it("accepts the query opt-in as an alternative to the env flag", () => {
    const resolution = resolveDevWebHostConfig({
      ...ACTIVE,
      optInFlag: undefined,
      optInQuery: "1",
    });
    expect(resolution.status).toBe("active");
  });

  it("stays off in a production build even when everything else is configured", () => {
    expect(resolveDevWebHostConfig({ ...ACTIVE, developmentBuild: false })).toEqual({
      status: "inactive",
      reason: "not-a-development-build",
    });
  });

  it("never shadows a present Electron host bridge", () => {
    expect(resolveDevWebHostConfig({ ...ACTIVE, hostBridgePresent: true })).toEqual({
      status: "inactive",
      reason: "host-bridge-present",
    });
  });

  it("requires a deliberate opt-in", () => {
    expect(
      resolveDevWebHostConfig({ ...ACTIVE, optInFlag: undefined, optInQuery: undefined }),
    ).toEqual({ status: "inactive", reason: "opt-in-absent" });
    // A truthy-but-not-"1" value is not an opt-in.
    expect(resolveDevWebHostConfig({ ...ACTIVE, optInFlag: "true", optInQuery: "yes" })).toEqual({
      status: "inactive",
      reason: "opt-in-absent",
    });
  });

  it("refuses a daemon URL that is missing or not loopback", () => {
    expect(resolveDevWebHostConfig({ ...ACTIVE, daemonUrl: undefined })).toEqual({
      status: "inactive",
      reason: "daemon-url-absent",
    });
    expect(resolveDevWebHostConfig({ ...ACTIVE, daemonUrl: "http://192.168.1.9:8787" })).toEqual({
      status: "inactive",
      reason: "daemon-url-not-loopback",
    });
  });

  it("refuses an absent owner credential", () => {
    expect(resolveDevWebHostConfig({ ...ACTIVE, ownerToken: "" })).toEqual({
      status: "inactive",
      reason: "owner-token-absent",
    });
  });
});
