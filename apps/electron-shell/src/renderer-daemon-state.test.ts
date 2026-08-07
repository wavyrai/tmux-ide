import { describe, expect, it } from "vitest";

import { rendererDaemonState } from "./daemon-resource-broker.ts";

describe("renderer daemon state reasons", () => {
  it("replaces probe reasons with fixed copy so internals never cross the bridge", () => {
    expect(
      rendererDaemonState({
        status: "unavailable",
        code: "process-not-running",
        reason: "pid 4100 at /Users/someone/.tmux-ide/daemon.json is dead",
      }),
    ).toEqual({
      status: "unavailable",
      code: "process-not-running",
      reason: "The canonical daemon is unavailable.",
    });
    expect(
      rendererDaemonState({
        status: "degraded",
        code: "record-invalid",
        reason: "daemon.json at /Users/someone/.tmux-ide is malformed",
      }),
    ).toEqual({
      status: "degraded",
      code: "record-invalid",
      reason: "Canonical daemon verification is degraded.",
    });
  });

  it("passes the supervisor-composed halt reason through to the recovery screen", () => {
    const reason =
      "The bundled engine stopped after 3 consecutive fatal startup failures (record-invalid). " +
      "Last failure: daemon.json is not trustworthy";
    expect(rendererDaemonState({ status: "degraded", code: "supervisor-halted", reason })).toEqual({
      status: "degraded",
      code: "supervisor-halted",
      reason,
    });
  });
});
