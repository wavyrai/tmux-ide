import { describe, expect, it } from "vitest";
import { terminalDisplayWidth } from "../panel-host.ts";
import { paneFrameHitTest, paneFrameVariant, projectPaneFrame } from "./pane-frame.ts";

const actions = [
  { id: "agent", label: "agent", compactLabel: "A", description: "Open agent controls" },
  { id: "mission", label: "mission", compactLabel: "M", description: "Open mission proof" },
  { id: "native", label: "native", compactLabel: "N", description: "Open native surface" },
] as const;

describe("PaneFrame projection", () => {
  it.each([
    [48, 12, "compact"],
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("selects deterministic %s×%s %s chrome", (width, height, variant) => {
    expect(paneFrameVariant(width, height)).toBe(variant);
    const projection = projectPaneFrame({
      width,
      height,
      title: "API server",
      kind: "terminals",
      subtitle: "%7 · codex",
      focused: true,
      terminalFocused: true,
      status: "working",
      statusTone: "working",
      actions,
    });
    expect(projection.variant).toBe(variant);
    expect(projection.outer).toEqual({ x: 0, y: 0, width, height });
    expect(projection.header).toEqual({ x: 1, y: 1, width: width - 2, height: 1 });
    expect(projection.body).toEqual({ x: 1, y: 2, width: width - 2, height: height - 3 });
    expect(projection.title).toContain("API server");
    expect(projection.chips.every((chip) => chip.start + chip.width <= width - 1)).toBe(true);
    expect(
      projection.chips.every(
        (chip, index) => index === 0 || chip.start > projection.chips[index - 1]!.start,
      ),
    ).toBe(true);
  });

  it("keeps tiny frames bounded and avoids negative rectangles", () => {
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [7, 3],
      [8, 4],
    ] as const) {
      const projection = projectPaneFrame({
        width,
        height,
        title: "tiny",
        kind: "native",
        focused: false,
        actions,
      });
      for (const rect of [
        projection.outer,
        projection.header,
        projection.body,
        projection.titleSpan,
        ...(projection.grip ? [projection.grip] : []),
      ]) {
        expect(rect.width).toBeGreaterThanOrEqual(0);
        expect(rect.height).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(projection.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(projection.height);
      }
    }
  });

  it("keeps title, subtitle, grip, and chips inside the header rectangle in tiny frames", () => {
    for (const [width, height] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [7, 3],
      [8, 4],
      [12, 4],
      [28, 8],
    ] as const) {
      const projection = projectPaneFrame({
        width,
        height,
        title: "tiny native mission agent pane with a very long semantic title",
        kind: "native",
        subtitle: "mission/attempt/proof/native-surface",
        focused: true,
        terminalFocused: true,
        attention: true,
        windowEditSelected: true,
        floating: true,
        maximized: true,
        status: "blocked",
        statusTone: "blocked",
        actions,
      });
      const spans = [
        projection.titleSpan,
        ...(projection.subtitleSpan ? [projection.subtitleSpan] : []),
        ...(projection.grip ? [projection.grip] : []),
        ...projection.chips.map((chip) => ({
          x: chip.start,
          y: projection.header.y,
          width: chip.width,
          height: 1,
          text: chip.label,
        })),
      ];
      for (const span of spans) {
        expect(span.x).toBeGreaterThanOrEqual(projection.header.x);
        expect(span.y).toBeGreaterThanOrEqual(projection.header.y);
        expect(span.x + span.width).toBeLessThanOrEqual(
          projection.header.x + projection.header.width,
        );
        expect(span.y + span.height).toBeLessThanOrEqual(
          projection.header.y + projection.header.height,
        );
      }
    }
  });

  it("prioritizes marker state without losing orthogonal chips", () => {
    const marker = (overrides: Partial<Parameters<typeof projectPaneFrame>[0]>) =>
      projectPaneFrame({
        width: 120,
        height: 40,
        title: "pane",
        kind: "files",
        focused: false,
        ...overrides,
      });
    expect(
      marker({
        windowEditSelected: true,
        terminalFocused: true,
        attention: true,
        focused: true,
        floating: true,
        maximized: true,
      }).marker,
    ).toBe("◇");
    expect(marker({ terminalFocused: true, attention: true, focused: true }).marker).toBe("▣");
    expect(marker({ attention: true, focused: true }).marker).toBe("!");
    expect(marker({ focused: true }).marker).toBe("●");
    expect(marker({ floating: true }).marker).toBe("◌");
    expect(marker({}).marker).toBe("○");
    const projection = marker({
      windowEditSelected: true,
      floating: true,
      maximized: true,
      status: "blocked",
      statusTone: "blocked",
    });
    expect(projection.chips.map((chip) => (chip.kind === "state" ? chip.id : chip.kind))).toEqual([
      "status",
      "edit",
      "float",
      "maximized",
    ]);
  });

  it("keeps semantic status while progressively dropping actions then state on narrow panes", () => {
    const projection = projectPaneFrame({
      width: 28,
      height: 8,
      title: "very long pane title",
      kind: "missions",
      focused: false,
      attention: true,
      windowEditSelected: true,
      floating: true,
      maximized: true,
      status: "blocked",
      statusTone: "blocked",
      actions,
    });
    expect(projection.chips[0]).toMatchObject({ kind: "status", label: "!" });
    expect(projection.actions.length).toBeLessThan(actions.length);
    expect(projection.title.length).toBeGreaterThan(0);
    expect(projection.titleSpan.x + projection.titleSpan.width).toBeLessThanOrEqual(
      projection.chips[0]!.start,
    );
  });

  it("clips title and subtitle by terminal display width", () => {
    const projection = projectPaneFrame({
      width: 120,
      height: 40,
      title: "Pair 👨‍💻 implements exact title geometry for a very long native panel",
      kind: "native",
      subtitle: "apps/api/%7 · Nederlands 🇳🇱 keycap 1️⃣",
      focused: true,
      status: "working",
      statusTone: "working",
      actions,
    });
    expect(terminalDisplayWidth(projection.titleSpan.text)).toBe(projection.titleSpan.width);
    if (projection.subtitleSpan) {
      expect(terminalDisplayWidth(projection.subtitleSpan.text)).toBe(
        projection.subtitleSpan.width,
      );
      expect(projection.subtitleSpan.x + projection.subtitleSpan.width).toBeLessThanOrEqual(
        projection.chips[0]!.start,
      );
    }
  });

  it("routes grip, header, enabled action, body, and border zones explicitly", () => {
    const projection = projectPaneFrame({
      width: 120,
      height: 30,
      title: "Terminal",
      kind: "terminals",
      focused: true,
      status: "working",
      statusTone: "working",
      actions: [
        { ...actions[0], pressed: true },
        { ...actions[1], disabled: true },
      ],
    });
    const agent = projection.actions.find((action) => action.id === "agent")!;
    const mission = projection.actions.find((action) => action.id === "mission")!;
    expect(agent.pressed).toBe(true);
    expect(paneFrameHitTest(projection, agent.start, projection.header.y)).toEqual({
      area: "action",
      actionId: "agent",
      actionIndex: 0,
    });
    expect(paneFrameHitTest(projection, mission.start, projection.header.y)).toEqual({
      area: "header",
    });
    expect(paneFrameHitTest(projection, projection.grip!.x, projection.grip!.y)).toEqual({
      area: "grip",
    });
    expect(paneFrameHitTest(projection, projection.titleSpan.x, projection.titleSpan.y)).toEqual({
      area: "header",
    });
    expect(paneFrameHitTest(projection, projection.body.x, projection.body.y)).toEqual({
      area: "body",
    });
    expect(paneFrameHitTest(projection, 0, 0)).toEqual({ area: "border" });
    expect(paneFrameHitTest(projection, -1, 0)).toBeNull();
  });
});
