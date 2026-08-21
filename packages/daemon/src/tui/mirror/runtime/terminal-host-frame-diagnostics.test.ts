import { describe, expect, it } from "vitest";

import type { TuiTerminalCanonicalPaintIdentity } from "../performance-events.ts";
import { publishCanonicalHostFrameDiagnostics } from "./terminal-host-frame-diagnostics.ts";

const identity: TuiTerminalCanonicalPaintIdentity = {
  processId: "opentui:1",
  clockId: "opentui-performance-now",
  clockKind: "performance-now",
  semanticPaneId: "pane.one",
  generation: "generation",
  incarnation: "generation:0",
  revision: 3,
  stateHash: "0123456789abcdef",
  cols: 132,
  rows: 41,
  sourceEpoch: 1,
  viewportCols: 132,
  viewportRows: 40,
  acceptedUpdateType: "terminal.seed",
  acceptedRevision: 3,
};

describe("publishCanonicalHostFrameDiagnostics", () => {
  it("publishes each consumed identity once before its same-stream fence", () => {
    const events: string[] = [];
    let drains = 0;
    const adapter = {
      drainCanonicalHostFrameIdentities: () => {
        drains += 1;
        return { identities: [identity], dropped: 0 };
      },
    };
    const published = publishCanonicalHostFrameDiagnostics(
      adapter as never,
      "generation",
      4,
      {
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        terminalCanonicalHostFrame: (event) => events.push(`frame:${event.atMicros}`),
        terminalFrameFence: (event) => events.push(`fence:${event.revision}`),
      },
      () => 500,
    );
    expect(published).toBe(1);
    expect(drains).toBe(1);
    expect(events).toEqual(["frame:500", "fence:3"]);
  });

  it("does zero producer work when disabled and keeps throwing observers fail-open", () => {
    let drains = 0;
    const adapter = {
      drainCanonicalHostFrameIdentities: () => {
        drains += 1;
        return { identities: [identity], dropped: 0 };
      },
    };
    expect(publishCanonicalHostFrameDiagnostics(adapter as never, "generation", 1, null)).toBe(0);
    expect(drains).toBe(0);
    expect(() =>
      publishCanonicalHostFrameDiagnostics(
        adapter as never,
        "generation",
        1,
        {
          frame: () => undefined,
          terminalPaint: () => undefined,
          terminalDelivery: () => undefined,
          terminalCanonicalHostFrame: () => undefined,
          terminalFrameFence: () => undefined,
        },
        () => {
          throw new Error("clock failed");
        },
      ),
    ).not.toThrow();
    expect(drains).toBe(0);
    expect(() =>
      publishCanonicalHostFrameDiagnostics(adapter as never, "generation", 1, {
        frame: () => undefined,
        terminalPaint: () => undefined,
        terminalDelivery: () => undefined,
        terminalCanonicalHostFrame: () => {
          throw new Error("host sink failed");
        },
        terminalFrameFence: () => {
          throw new Error("fence sink failed");
        },
      }),
    ).not.toThrow();
    expect(drains).toBe(1);
  });
});
