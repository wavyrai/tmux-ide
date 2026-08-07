import { describe, expect, it } from "vitest";

import { browserInitiatedWebSocketCloseCode } from "./browser-websocket.ts";

describe("browserInitiatedWebSocketCloseCode", () => {
  it("keeps browser-legal codes and maps peer-only protocol codes to private use", () => {
    expect(browserInitiatedWebSocketCloseCode(undefined)).toBeUndefined();
    expect(browserInitiatedWebSocketCloseCode(1000)).toBe(1000);
    expect(browserInitiatedWebSocketCloseCode(1008)).toBe(4008);
    expect(browserInitiatedWebSocketCloseCode(1011)).toBe(4011);
    expect(browserInitiatedWebSocketCloseCode(3001)).toBe(3001);
    expect(browserInitiatedWebSocketCloseCode(4999)).toBe(4999);
    expect(browserInitiatedWebSocketCloseCode(2001)).toBe(4000);
  });
});
