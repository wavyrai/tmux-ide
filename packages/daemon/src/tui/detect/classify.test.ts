/**
 * Unit tests for the 4-state classifier.
 *
 * Covers the pure instantaneous mapping (`classifyInstant`) and the stateful
 * `StatusTracker`, whose `done` + seen logic is driven entirely by its call
 * sequence.
 */
import { describe, expect, it } from "vitest";
import { classifyInstant, createStatusTracker, parseAuthorityEpoch } from "./classify.ts";
import type { AgentManifest } from "./manifest.ts";
import type { PaneSnapshot } from "./snapshot.ts";

function snap(bottom: string[], extra: Partial<PaneSnapshot & { title?: string }> = {}) {
  const text = extra.text ?? bottom.join("\n");
  return {
    bottomNonEmpty: bottom,
    text,
    raw: extra.raw ?? text,
    ...(extra.title !== undefined ? { title: extra.title } : {}),
  };
}

const manifest: AgentManifest = {
  id: "test",
  commands: ["test"],
  states: {
    blocked: { any: [{ contains: "BLOCK" }] },
    working: { any: [{ contains: "WORK" }] },
    done: { any: [{ contains: "DONE" }] },
  },
};

describe("classifyInstant", () => {
  it("returns unknown when there is no manifest", () => {
    expect(classifyInstant(snap(["anything"]), undefined)).toBe("unknown");
  });

  it("maps blocked and working", () => {
    expect(classifyInstant(snap(["BLOCK now"]), manifest)).toBe("blocked");
    expect(classifyInstant(snap(["WORK now"]), manifest)).toBe("working");
  });

  it("collapses a manifest-detected done to idle", () => {
    expect(classifyInstant(snap(["DONE"]), manifest)).toBe("idle");
  });

  it("returns idle on a manifest miss", () => {
    expect(classifyInstant(snap(["plain prompt $"]), manifest)).toBe("idle");
  });
});

describe("parseAuthorityEpoch", () => {
  it("extracts the epoch stamp from a well-formed value", () => {
    expect(parseAuthorityEpoch("working:1700000000")).toBe(1700000000);
    expect(parseAuthorityEpoch("done:42")).toBe(42);
  });

  it("uses the LAST colon so an id:state:epoch triple still yields the epoch", () => {
    expect(parseAuthorityEpoch("idle:1700000000")).toBe(1700000000);
  });

  it("returns null for absent, colon-less, or non-numeric stamps", () => {
    expect(parseAuthorityEpoch(undefined)).toBeNull();
    expect(parseAuthorityEpoch("")).toBeNull();
    expect(parseAuthorityEpoch("working")).toBeNull();
    expect(parseAuthorityEpoch("working:soon")).toBeNull();
  });

  it("does NOT apply staleness — a very old stamp still parses (that's parseAuthority's job)", () => {
    expect(parseAuthorityEpoch("working:1")).toBe(1);
  });
});

describe("StatusTracker", () => {
  it("produces done on working→idle, holds it unseen, then acknowledges", () => {
    const t = createStatusTracker();
    expect(t.update("p", "working")).toBe("working");
    // working → idle transition = finished, not yet viewed.
    expect(t.update("p", "idle")).toBe("done");
    // still unseen on a subsequent idle tick.
    expect(t.update("p", "idle")).toBe("done");
    // viewing the pane acknowledges it.
    expect(t.update("p", "idle", { seen: true })).toBe("idle");
    // done is cleared afterwards.
    expect(t.update("p", "idle")).toBe("idle");
  });

  it("lets blocked take priority over a pending done", () => {
    const t = createStatusTracker();
    expect(t.update("p", "working")).toBe("working");
    expect(t.update("p", "blocked")).toBe("blocked");
    // no lingering done after blocked.
    expect(t.update("p", "idle")).toBe("idle");
  });

  it("never fabricates done when the pane was idle from the start", () => {
    const t = createStatusTracker();
    expect(t.update("p", "idle")).toBe("idle");
    expect(t.update("p", "idle")).toBe("idle");
  });

  it("passes unknown through", () => {
    const t = createStatusTracker();
    expect(t.update("p", "unknown")).toBe("unknown");
  });

  it("markSeen clears a pending done", () => {
    const t = createStatusTracker();
    t.update("p", "working");
    expect(t.update("p", "idle")).toBe("done");
    t.markSeen("p");
    expect(t.update("p", "idle")).toBe("idle");
  });

  it("forget resets a pane so a later working→idle can produce done again", () => {
    const t = createStatusTracker();
    t.update("p", "working");
    expect(t.update("p", "idle")).toBe("done");
    t.forget("p");
    // fresh state: an idle tick alone is not a transition.
    expect(t.update("p", "idle")).toBe("idle");
    // but a new working→idle cycle produces done again.
    expect(t.update("p", "working")).toBe("working");
    expect(t.update("p", "idle")).toBe("done");
  });

  it("tracks panes independently", () => {
    const t = createStatusTracker();
    t.update("a", "working");
    t.update("b", "idle");
    expect(t.update("a", "idle")).toBe("done");
    expect(t.update("b", "idle")).toBe("idle");
  });
});
