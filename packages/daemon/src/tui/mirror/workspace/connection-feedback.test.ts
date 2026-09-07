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
