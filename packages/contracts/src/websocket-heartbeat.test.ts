import { describe, expect, it } from "vitest";
import {
  WEBSOCKET_HEARTBEAT_INTERVAL_MS,
  WEBSOCKET_HEARTBEAT_MISSED_LIMIT,
  formatWebSocketHeartbeatHeader,
  parseWebSocketHeartbeatHeader,
} from "./websocket-heartbeat.ts";

describe("websocket heartbeat advertisement", () => {
  it("round-trips the default policy as a plain header value", () => {
    const policy = {
      intervalMs: WEBSOCKET_HEARTBEAT_INTERVAL_MS,
      missedLimit: WEBSOCKET_HEARTBEAT_MISSED_LIMIT,
    };
    expect(formatWebSocketHeartbeatHeader(policy)).toBe("interval-ms=10000, missed-limit=3");
    expect(parseWebSocketHeartbeatHeader(formatWebSocketHeartbeatHeader(policy))).toEqual(policy);
  });

  it.each([
    undefined,
    null,
    "",
    "interval-ms=10000",
    "interval-ms=0, missed-limit=3",
    "interval-ms=100, missed-limit=3",
    "interval-ms=60001, missed-limit=3",
    "interval-ms=10000, missed-limit=0",
    "interval-ms=10000, missed-limit=3; extra",
    "interval-ms=1e4, missed-limit=3",
  ])("gives no policy, and so no idle deadline, for %j", (value) => {
    expect(parseWebSocketHeartbeatHeader(value)).toBeNull();
  });
});
