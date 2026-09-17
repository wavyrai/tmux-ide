import { expect, it } from "vitest";
import { ApplicationShellTransportError } from "@tmux-ide/daemon-client/application-shell-session";
import {
  OpenTuiStartupError,
  safeStartupFailure,
  startupFailureFromError,
} from "./startup-failure.ts";
it("accepts only known fields and bounded opaque operation IDs", () => {
  expect(
    safeStartupFailure({ reason: "Bearer secret", code: "secret", operationId: "token=secret" }),
  ).toEqual({ reason: "connection-unavailable" });
  expect(
    safeStartupFailure({
      reason: "authority_disposed",
      code: "operation_capacity",
      operationId: "a".repeat(129),
    }),
  ).toEqual({ reason: "authority_disposed", code: "operation_capacity" });
  expect(JSON.stringify(startupFailureFromError(new Error("Bearer secret")))).not.toContain(
    "secret",
  );
});
it("preserves typed transport kind without its message or arbitrary details", () => {
  expect(
    startupFailureFromError(new ApplicationShellTransportError("http-error", "Bearer secret", 500)),
  ).toEqual({ reason: "connection-unavailable", code: "http-error" });
  expect(
    new OpenTuiStartupError({
      reason: "promotion-rejected",
      code: "operation_capacity",
      message: "secret",
    }).message,
  ).toBe("Session startup failed: operation_capacity");
});
it("retains only bounded daemon/build correlation and preserves it through typed errors", () => {
  const correlation = {
    reason: "admission_queue_full",
    operationId: "op-1",
    daemonGeneration: "daemon-a",
    tuiGeneration: "build-11111111-1111-4111-8111-111111111111",
  };
  expect(startupFailureFromError(new OpenTuiStartupError(correlation))).toEqual(correlation);
  expect(
    safeStartupFailure({ daemonGeneration: "Bearer secret", tuiGeneration: "token=secret" }),
  ).toEqual({ reason: "connection-unavailable" });
});
