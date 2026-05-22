/**
 * `computePollBackoffDelay` unit tests.
 *
 * The diagnostics poll uses this helper to space requests when the
 * daemon's LSP routes are unresponsive (typically: daemon started
 * before the LSP wire landed, so every poll returns 404). A stale
 * daemon should NOT generate runaway request volume.
 */

import { describe, expect, it } from "vitest";
import { computePollBackoffDelay } from "@/lib/lsp/poll-backoff";

const config = { intervalMs: 5_000, maxMs: 60_000, factor: 2 };

describe("computePollBackoffDelay", () => {
  it("returns the base interval when there are zero consecutive errors", () => {
    expect(computePollBackoffDelay(0, config)).toBe(5_000);
  });

  it("treats negative error counts as zero (defensive)", () => {
    expect(computePollBackoffDelay(-1, config)).toBe(5_000);
  });

  it("doubles each consecutive error up to the cap", () => {
    expect(computePollBackoffDelay(1, config)).toBe(5_000);
    expect(computePollBackoffDelay(2, config)).toBe(10_000);
    expect(computePollBackoffDelay(3, config)).toBe(20_000);
    expect(computePollBackoffDelay(4, config)).toBe(40_000);
  });

  it("caps at maxMs even with very large error counts", () => {
    expect(computePollBackoffDelay(5, config)).toBe(60_000); // 80_000 would exceed
    expect(computePollBackoffDelay(50, config)).toBe(60_000);
    expect(computePollBackoffDelay(1_000, config)).toBe(60_000);
  });

  it("handles non-finite arithmetic (extreme factors)", () => {
    expect(computePollBackoffDelay(2_000, { intervalMs: 5_000, maxMs: 60_000, factor: 10 })).toBe(
      60_000,
    );
  });

  it("respects a different config object", () => {
    const tighter = { intervalMs: 1_000, maxMs: 10_000, factor: 3 };
    expect(computePollBackoffDelay(0, tighter)).toBe(1_000);
    expect(computePollBackoffDelay(1, tighter)).toBe(1_000);
    expect(computePollBackoffDelay(2, tighter)).toBe(3_000);
    expect(computePollBackoffDelay(3, tighter)).toBe(9_000);
    expect(computePollBackoffDelay(4, tighter)).toBe(10_000); // capped
  });
});
