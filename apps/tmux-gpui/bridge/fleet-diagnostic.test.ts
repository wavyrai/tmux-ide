import assert from "node:assert/strict";
import { test } from "node:test";
import type { FleetConnectionStatus } from "../../../packages/daemon-client/src/fleet-connection-status.ts";
import { projectFleetDiagnostic } from "./fleet-diagnostic.ts";

test("fleet diagnostics project only canonical phase and failure, never transport details", () => {
  const source = {
    phase: "needs-attention" as const,
    failure: "ssh-authentication" as const,
    attempt: 17,
    nextRetryAt: 1234,
    authToken: "SECRET",
    remote: "user@private-host",
    path: "/private/home",
    note: "terminal contents",
    retry: "not-a-capability",
  };
  const value = projectFleetDiagnostic(source);
  assert.deepEqual(value, { phase: "needs-attention", failure: "ssh-authentication" });
  assert.notEqual(value, source);
  assert.equal(JSON.stringify(value).includes("SECRET"), false);
});

test("diagnostic projection replaces old errors and omits absent or unknown metadata", () => {
  const source: FleetConnectionStatus = {
    phase: "needs-attention",
    failure: "incompatible",
    attempt: 1,
    nextRetryAt: null,
  };
  const failed = projectFleetDiagnostic(source);
  const ready = projectFleetDiagnostic({ ...source, phase: "ready", failure: null });
  assert.deepEqual(failed, { phase: "needs-attention", failure: "incompatible" });
  assert.deepEqual(ready, { phase: "ready", failure: null });
  assert.equal(projectFleetDiagnostic(undefined), undefined);
  assert.equal(
    projectFleetDiagnostic({
      ...source,
      phase: "private detail",
    } as unknown as FleetConnectionStatus),
    undefined,
  );
  assert.equal(
    projectFleetDiagnostic({
      ...source,
      failure: "private detail",
    } as unknown as FleetConnectionStatus),
    undefined,
  );
});
