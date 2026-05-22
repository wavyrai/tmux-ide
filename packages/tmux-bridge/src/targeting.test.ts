import { describe, it, expect } from "bun:test";
import { resolveTarget, type TmuxPaneTarget } from "./targeting.ts";
import type { TmuxPaneInfo } from "./panes.ts";

const PANES: TmuxPaneInfo[] = [
  { index: 0, title: "Lead", width: 80, height: 24, active: true },
  { index: 1, title: "Reviewer", width: 80, height: 24, active: false },
  { index: 2, title: "Reviewer", width: 80, height: 24, active: false },
  { index: 3, title: "Shell", width: 80, height: 24, active: false },
];

describe("resolveTarget — byId", () => {
  it("accepts an opaque %N tmux id and passes it through", () => {
    const result = resolveTarget(PANES, { kind: "byId", id: "%42" }, "sess");
    expect(result.target).toBe("%42");
  });

  it("treats bare-numeric id as a pane index", () => {
    const result = resolveTarget(PANES, { kind: "byId", id: "1" }, "sess");
    expect(result.target).toBe("sess.1");
    expect(result.pane.title).toBe("Reviewer");
  });

  it("throws for non-numeric, non-%N ids", () => {
    expect(() => resolveTarget(PANES, { kind: "byId", id: "not-a-number" }, "sess")).toThrow(
      /Invalid pane id/,
    );
  });

  it("throws when bare-numeric id doesn't match any pane", () => {
    expect(() => resolveTarget(PANES, { kind: "byId", id: "99" }, "sess")).toThrow(/not found/i);
  });
});

describe("resolveTarget — byIndex", () => {
  it("resolves by exact index match", () => {
    const result = resolveTarget(PANES, { kind: "byIndex", index: 3 }, "sess");
    expect(result.target).toBe("sess.3");
    expect(result.pane.title).toBe("Shell");
  });

  it("throws when index is missing", () => {
    expect(() => resolveTarget(PANES, { kind: "byIndex", index: 99 }, "sess")).toThrow(
      /not found/i,
    );
  });

  it("omits the session prefix when no session is supplied", () => {
    const result = resolveTarget(PANES, { kind: "byIndex", index: 0 });
    expect(result.target).toBe("0");
  });
});

describe("resolveTarget — byTitle", () => {
  it("resolves a unique title", () => {
    const result = resolveTarget(PANES, { kind: "byTitle", title: "Lead" }, "sess");
    expect(result.target).toBe("sess.0");
    expect(result.pane.index).toBe(0);
  });

  it("throws on ambiguous titles", () => {
    expect(() => resolveTarget(PANES, { kind: "byTitle", title: "Reviewer" }, "sess")).toThrow(
      /ambiguous/i,
    );
  });

  it("throws when no pane matches", () => {
    expect(() => resolveTarget(PANES, { kind: "byTitle", title: "Nonexistent" }, "sess")).toThrow(
      /not found/i,
    );
  });
});

describe("resolveTarget — byRole", () => {
  it("throws because byRole must be resolved by the daemon, not the bridge", () => {
    expect(() => resolveTarget(PANES, { kind: "byRole", role: "lead" }, "sess")).toThrow(
      /byRole.*daemon/i,
    );
  });
});

describe("resolveTarget — addressing-mode disambiguation", () => {
  it("byIndex 1 and byId '1' resolve to the same pane (parity)", () => {
    const a = resolveTarget(PANES, { kind: "byIndex", index: 1 }, "sess");
    const b = resolveTarget(PANES, { kind: "byId", id: "1" }, "sess");
    expect(a.target).toBe(b.target);
    expect(a.pane.index).toBe(b.pane.index);
  });

  it("a numeric title doesn't collide with a numeric index", () => {
    const panes: TmuxPaneInfo[] = [
      { index: 0, title: "1", width: 80, height: 24, active: true },
      { index: 1, title: "Lead", width: 80, height: 24, active: false },
    ];
    const byTitle = resolveTarget(panes, { kind: "byTitle", title: "1" }, "sess");
    const byIndex = resolveTarget(panes, { kind: "byIndex", index: 1 }, "sess");
    expect(byTitle.pane.index).toBe(0);
    expect(byIndex.pane.index).toBe(1);
  });

  it("uses the first matching index when multiple panes share a title via byIndex", () => {
    const target: TmuxPaneTarget = { kind: "byIndex", index: 2 };
    const result = resolveTarget(PANES, target, "sess");
    expect(result.pane.index).toBe(2);
    expect(result.pane.title).toBe("Reviewer");
  });
});
