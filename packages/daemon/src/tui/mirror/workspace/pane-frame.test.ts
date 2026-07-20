import { describe, expect, it } from "vitest";
import { paneFrameHitTest, paneFrameVariant, projectPaneFrame } from "./pane-frame.ts";

const actions = [
  { id: "zoom", label: "zoom", compactLabel: "Z", description: "Toggle zoom" },
  { id: "split", label: "split", compactLabel: "+", description: "Split pane" },
  { id: "more", label: "more", compactLabel: "…", description: "More actions" },
] as const;

describe("PaneFrame projection", () => {
  it.each([
    [48, 12, "compact"],
    [90, 24, "standard"],
    [140, 40, "wide"],
  ] as const)("selects the %s×%s %s chrome", (width, height, variant) => {
    expect(paneFrameVariant(width, height)).toBe(variant);
    const projection = projectPaneFrame({
      width,
      height,
      title: "API server",
      kind: "terminals",
      subtitle: "%7 · codex",
      focused: true,
      status: "working",
      statusTone: "working",
      actions,
    });
    expect(projection.variant).toBe(variant);
    expect(projection.header).toEqual({ x: 0, y: 0, width, height: 1 });
    expect(projection.body).toEqual({ x: 0, y: 1, width, height: height - 1 });
    expect(projection.title).toContain("API server");
    expect(projection.chips.every((chip) => chip.start + chip.width <= width)).toBe(true);
    expect(
      projection.chips.every(
        (chip, index) => index === 0 || chip.start > projection.chips[index - 1]!.start,
      ),
    ).toBe(true);
  });

  it("prioritizes terminal focus, attention, focus, and idle markers", () => {
    const marker = (overrides: Partial<Parameters<typeof projectPaneFrame>[0]>) =>
      projectPaneFrame({
        width: 80,
        height: 24,
        title: "pane",
        kind: "files",
        focused: false,
        ...overrides,
      }).marker;
    expect(marker({ terminalFocused: true, attention: true, focused: true })).toBe("▣");
    expect(marker({ attention: true, focused: true })).toBe("!");
    expect(marker({ focused: true })).toBe("●");
    expect(marker({})).toBe("○");
  });

  it("keeps semantic status while progressively dropping actions on narrow panes", () => {
    const projection = projectPaneFrame({
      width: 24,
      height: 8,
      title: "very long pane title",
      kind: "missions",
      focused: false,
      attention: true,
      status: "blocked",
      statusTone: "blocked",
      actions,
    });
    expect(projection.chips[0]).toMatchObject({ kind: "status", label: "!" });
    expect(projection.actions.length).toBeLessThan(actions.length);
    expect(projection.title.length).toBeGreaterThan(0);
    expect(projection.title.length).toBeLessThanOrEqual(projection.chips[0]!.start);
  });

  it("routes enabled actions while leaving status and disabled actions inert", () => {
    const projection = projectPaneFrame({
      width: 120,
      height: 30,
      title: "Terminal",
      kind: "terminals",
      focused: true,
      status: "working",
      statusTone: "working",
      actions: [actions[0], { ...actions[1], disabled: true }],
    });
    const zoom = projection.actions.find((action) => action.id === "zoom")!;
    const split = projection.actions.find((action) => action.id === "split")!;
    expect(paneFrameHitTest(projection, zoom.start, 0)).toEqual({
      area: "header",
      actionId: "zoom",
      actionIndex: 0,
    });
    expect(paneFrameHitTest(projection, split.start, 0)).toEqual({ area: "header" });
    expect(paneFrameHitTest(projection, projection.chips[0]!.start, 0)).toEqual({
      area: "header",
    });
    expect(paneFrameHitTest(projection, 2, 2)).toEqual({ area: "body" });
    expect(paneFrameHitTest(projection, -1, 0)).toBeNull();
  });
});
