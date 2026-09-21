import { afterEach, expect, it, vi } from "vitest";
import {
  createApplicationConnectionFeedback,
  type ApplicationConnectionFeedback,
} from "./connection-feedback.ts";
afterEach(() => vi.useRealTimers());
it("reports real stages, ignores another session, and stops ticking on failure", () => {
  vi.useFakeTimers();
  let value: ApplicationConnectionFeedback | null = null;
  const owner = createApplicationConnectionFeedback((next) => {
    value = next;
  });
  owner.note("opening main");
  owner.progress("other", "runtime-fault", { authToken: "secret" });
  expect(value).toMatchObject({ stage: "Connecting to daemon" });
  owner.progress("main", "runtime-progress", {
    runtimePhase: "seed",
    seededPanes: 2,
    expectedPanes: 4,
    authToken: "secret",
  });
  vi.advanceTimersByTime(2000);
  expect(value).toMatchObject({ stage: "Receiving panes 2/4", seconds: 2 });
  expect(JSON.stringify(value)).not.toContain("secret");
  owner.note("main could not attach");
  expect(value).toMatchObject({ failed: true });
  expect(vi.getTimerCount()).toBe(0);
  owner.note("opening main");
  expect(value).toMatchObject({ failed: false, seconds: 0 });
  owner.note(null);
  expect(value).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("does not install performance diagnostics for ordinary connection feedback", () => {
  const owner = createApplicationConnectionFeedback(() => {});
  const diagnostic = vi.fn();
  expect(owner.hostOptions("main", false, diagnostic).onDiagnostic).toBeUndefined();
  owner.hostOptions("main", true, diagnostic).onDiagnostic?.("runtime-fault", {});
  expect(diagnostic).toHaveBeenCalledWith("generation-runtime-fault", {});
  owner.dispose();
});

it("retains safe startup detail through generic failure notes and copy, clearing it on retry", async () => {
  vi.useFakeTimers();
  const owner = createApplicationConnectionFeedback();
  owner.note("opening main");
  owner.progress("main", "startup-failed", {
    code: "operation_capacity",
    reason: "admission_queue_full",
    operationId: "operation-123",
    daemonGeneration: "daemon-a",
    tuiGeneration: "build-11111111-1111-4111-8111-111111111111",
    message: "Bearer secret",
    authToken: "secret",
  });
  owner.note("main could not attach");
  expect(owner.snapshot()).toMatchObject({
    failed: true,
    failure: {
      code: "operation_capacity",
      reason: "admission_queue_full",
      operationId: "operation-123",
      daemonGeneration: "daemon-a",
      tuiGeneration: "build-11111111-1111-4111-8111-111111111111",
    },
  });
  const copy = vi.fn((_text: string) => true);
  owner.copy(copy);
  expect(copy.mock.calls[0]?.[0]).not.toContain("secret");
  expect(owner.text()).toContain("operation_capacity");
  expect(vi.getTimerCount()).toBe(0);
  owner.note("opening main");
  expect(owner.snapshot()?.failure).toBeUndefined();
  owner.dispose();
});

it("keeps rebind failure visible after startup clears, but rejects cancelled and unrelated snapshots", () => {
  vi.useFakeTimers();
  const owner = createApplicationConnectionFeedback();
  const value = (status: string, reason?: string) =>
    ({
      status,
      daemonGeneration: "daemon-b",
      ...(reason ? { startupFailure: { reason, daemonGeneration: "daemon-b" } } : {}),
    }) as Parameters<typeof owner.adopt>[1];
  owner.note("opening main");
  owner.adopt("main", value("live"));
  owner.note(null, "opened");
  owner.adopt("other", value("unavailable", "missing-semantic-stamp"));
  expect(owner.snapshot()).toBeNull();
  owner.adopt("main", value("unavailable", "missing-semantic-stamp"));
  expect(owner.snapshot()).toMatchObject({
    failed: true,
    failure: { reason: "missing-semantic-stamp" },
  });
  expect(owner.snapshot()?.recovery).toContain("different session");
  owner.adopt(undefined, null);
  expect(owner.snapshot()?.failed).toBe(true);
  owner.note(null, "cancelled");
  owner.adopt("main", value("unavailable", "missing-semantic-stamp"));
  expect(owner.snapshot()).toBeNull();
  owner.note("opening main");
  owner.adopt("main", value("unavailable", "duplicate-semantic-stamp"));
  expect(owner.snapshot()?.recovery).toContain("does not repair");
  owner.note("opening main");
  owner.adopt("main", value("live"));
  expect(owner.snapshot()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  owner.dispose();
});

it("rejects old same-name host and machine callbacks after a new owner starts", () => {
  const owner = createApplicationConnectionFeedback();
  let epoch = 1;
  owner.note("opening main");
  const old = owner.hostOptions(
    "main",
    false,
    () => {},
    () => epoch === 1,
  );
  epoch = 2;
  owner.note("opening main");
  old.onConnectionProgress("startup-failed", { reason: "missing-semantic-stamp" });
  expect(owner.snapshot()?.failed).toBe(false);
  const current = owner.hostOptions(
    "main",
    false,
    () => {},
    () => epoch === 2,
  );
  old.onConnectionProgress("startup-failed", { reason: "missing-semantic-stamp" });
  expect(owner.snapshot()?.failed).toBe(false);
  current.onConnectionProgress("startup-failed", { reason: "duplicate-semantic-stamp" });
  expect(owner.snapshot()?.failure?.reason).toBe("duplicate-semantic-stamp");
  owner.dispose();
});

it("defers retained-owner failure on Home and resumes it on Terminals without reopening", () => {
  const owner = createApplicationConnectionFeedback();
  const value = (status: string, reason?: string) =>
    ({
      status,
      daemonGeneration: "daemon-b",
      ...(reason ? { startupFailure: { reason, daemonGeneration: "daemon-b" } } : {}),
    }) as Parameters<typeof owner.adopt>[1];
  owner.note("opening main");
  owner.adopt("main", value("live"));
  owner.note(null, "opened");
  owner.note(null, "cancelled");
  owner.adopt("main", value("unavailable", "missing-semantic-stamp"));
  expect(owner.snapshot()).toBeNull();
  owner.resume();
  expect(owner.snapshot()?.failure?.reason).toBe("missing-semantic-stamp");
  owner.note(null, "cancelled");
  owner.adopt(undefined, null);
  owner.resume();
  expect(owner.snapshot()).toBeNull();
  owner.dispose();
});

it("cannot replay a prior machine failure while a replacement owner is preparing", () => {
  const owner = createApplicationConnectionFeedback();
  owner.note("opening main");
  owner.adopt("main", {
    status: "unavailable",
    startupFailure: { reason: "missing-semantic-stamp" },
  } as Parameters<typeof owner.adopt>[1]);
  owner.note(null, "cancelled");
  owner.replaceOwner();
  owner.note("opening main");
  owner.note(null, "cancelled");
  owner.resume();
  expect(owner.snapshot()).toBeNull();
  owner.dispose();
});

it("updates failure correlation for a replacement daemon without repeating identical failures", () => {
  const publish = vi.fn();
  const owner = createApplicationConnectionFeedback(publish);
  owner.note("opening main");
  const failed = (generation: string) =>
    ({
      status: "unavailable",
      daemonGeneration: generation,
      startupFailure: { reason: "missing-semantic-stamp", daemonGeneration: generation },
    }) as Parameters<typeof owner.adopt>[1];
  owner.adopt("main", failed("daemon-a"));
  const count = publish.mock.calls.length;
  owner.adopt("main", failed("daemon-a"));
  expect(publish).toHaveBeenCalledTimes(count);
  owner.adopt("main", failed("daemon-b"));
  expect(owner.snapshot()?.failure?.daemonGeneration).toBe("daemon-b");
  owner.dispose();
});
