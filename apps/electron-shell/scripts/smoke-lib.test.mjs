import { describe, expect, it, vi } from "vitest";

import {
  FATAL_OUTPUT_PATTERNS,
  attachabilityReport,
  dominantRefusalReasons,
  pollUntil,
  scanFatalPatterns,
  selectFleetSession,
} from "./smoke-lib.mjs";

describe("scanFatalPatterns", () => {
  it("finds nothing in a clean transcript", () => {
    expect(scanFatalPatterns("[main] ready\n[renderer] bootstrapped\n")).toEqual([]);
    expect(scanFatalPatterns("")).toEqual([]);
    expect(scanFatalPatterns(undefined)).toEqual([]);
  });

  it("reports every fatal pattern with the line that carried it", () => {
    const output = [
      "ok",
      "Error: Cannot find module 'node-pty'",
      "still ok",
      "Uncaught TypeError: x is not a function",
    ].join("\n");
    expect(scanFatalPatterns(output)).toEqual([
      {
        pattern: "Cannot find module",
        line: "Error: Cannot find module 'node-pty'",
        lineNumber: 2,
      },
      {
        pattern: "Uncaught TypeError",
        line: "Uncaught TypeError: x is not a function",
        lineNumber: 4,
      },
    ]);
  });

  it("catches each documented pattern, including CSP refusals", () => {
    for (const pattern of FATAL_OUTPUT_PATTERNS) {
      expect(scanFatalPatterns(`prefix ${pattern} suffix`)).toHaveLength(1);
    }
    expect(scanFatalPatterns("Refused to apply inline style because it violates CSP")).toHaveLength(
      1,
    );
  });

  it("clamps a pathological single line instead of echoing it whole", () => {
    const [finding] = scanFatalPatterns(`MODULE_NOT_FOUND${"x".repeat(10_000)}`);
    expect(finding.line.length).toBe(400);
  });

  it("counts one line carrying two patterns twice", () => {
    expect(scanFatalPatterns("Uncaught Error: Cannot find module 'a'")).toHaveLength(2);
  });
});

describe("pollUntil", () => {
  it("returns the first non-null probe value without sleeping", async () => {
    const sleep = vi.fn();
    await expect(
      pollUntil({ probe: () => "ready", detail: "readiness", timeoutMs: 1_000, sleep }),
    ).resolves.toBe("ready");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps polling while the probe is not ready", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const value = await pollUntil({
      probe: () => (++calls < 3 ? null : calls),
      detail: "the third attempt",
      timeoutMs: 1_000,
      sleep,
    });
    expect(value).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("treats false and 0 as real values, not as 'not yet'", async () => {
    await expect(
      pollUntil({
        probe: () => false,
        detail: "false",
        timeoutMs: 10,
        sleep: async () => undefined,
      }),
    ).resolves.toBe(false);
    await expect(
      pollUntil({ probe: () => 0, detail: "zero", timeoutMs: 10, sleep: async () => undefined }),
    ).resolves.toBe(0);
  });

  it("times out against the injected clock and names what it waited for", async () => {
    let clock = 0;
    await expect(
      pollUntil({
        probe: () => null,
        detail: "the daemon record",
        timeoutMs: 500,
        intervalMs: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/timed out after 500ms \(6 attempts\) waiting for the daemon record/u);
  });

  it("propagates a probe failure instead of retrying it", async () => {
    await expect(
      pollUntil({
        probe: () => {
          throw new Error("query is broken");
        },
        detail: "anything",
        timeoutMs: 1_000,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("query is broken");
  });
});

describe("selectFleetSession", () => {
  const catalog = {
    sessions: [
      { sessionId: "session.aaa", label: "other" },
      { sessionId: "session.bbb", label: "smoke-zz-42" },
    ],
  };

  it("matches the session by its exact label", () => {
    expect(selectFleetSession(catalog, "smoke-zz-42")?.sessionId).toBe("session.bbb");
  });

  it("returns null for an absent label or a malformed catalog", () => {
    expect(selectFleetSession(catalog, "smoke-zz-43")).toBeNull();
    expect(selectFleetSession({}, "smoke-zz-42")).toBeNull();
    expect(selectFleetSession(null, "smoke-zz-42")).toBeNull();
  });
});

describe("attachabilityReport", () => {
  it("splits available panes from refused ones", () => {
    const report = attachabilityReport([
      { id: "a", attachability: { status: "available", semanticPaneId: "pane.one" } },
      { id: "b", attachability: { status: "unavailable", reason: "missing-semantic-stamp" } },
      { id: "c", attachability: { status: "unavailable", reason: "missing-semantic-stamp" } },
      { id: "d", attachability: { status: "unavailable", reason: "not-single-pane-window" } },
    ]);
    expect(report).toEqual({
      total: 4,
      available: ["pane.one"],
      unavailable: [
        { id: "b", reason: "missing-semantic-stamp" },
        { id: "c", reason: "missing-semantic-stamp" },
        { id: "d", reason: "not-single-pane-window" },
      ],
    });
    expect(dominantRefusalReasons(report)).toEqual([
      "missing-semantic-stamp x2",
      "not-single-pane-window x1",
    ]);
  });

  it("degrades honestly on a missing or malformed inventory", () => {
    expect(attachabilityReport(undefined)).toEqual({ total: 0, available: [], unavailable: [] });
    expect(attachabilityReport([{ id: "a" }])).toEqual({
      total: 1,
      available: [],
      unavailable: [{ id: "a", reason: "unknown" }],
    });
  });
});
