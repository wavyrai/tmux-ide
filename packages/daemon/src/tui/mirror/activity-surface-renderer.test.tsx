/* @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test";
import { createSemanticThemeSnapshot } from "./theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "./testing/renderer-harness.test.ts";
import {
  projectActivitySurface,
  type ActivityRowDto,
  type ActivitySurfaceVariant,
} from "./activity-surface.ts";
import { ActivitySurface } from "./activity-surface.tsx";

const ROWS: readonly ActivityRowDto[] = [
  {
    kind: "event",
    id: "evt-review",
    sequence: 104,
    timestampText: "now",
    source: "review",
    message: "Card 04 needs attention",
    detail: "one renderer snapshot changed",
    status: "blocked",
    attention: true,
  },
  {
    kind: "agent",
    id: "agent-codex",
    sequence: 106,
    timestampText: "12:48",
    agent: "Codex 5.5",
    message: "Building native Activity",
    detail: "projection and renderer",
    status: "working",
  },
  {
    kind: "event",
    id: "evt-proof",
    sequence: 105,
    timestampText: "12:47",
    source: "mission M31",
    message: "Files surface verified",
    detail: "47 tests passed",
    status: "done",
  },
  {
    kind: "agent",
    id: "agent-claude",
    sequence: 103,
    timestampText: "12:44",
    agent: "Claude",
    message: "Waiting for integration",
    status: "idle",
  },
  {
    kind: "event",
    id: "evt-refresh",
    sequence: 102,
    timestampText: "12:42",
    source: "workspace",
    message: "Activity feed refreshed",
    status: "unknown",
  },
  {
    kind: "agent",
    id: "agent-unicode",
    sequence: 101,
    timestampText: "12:40",
    agent: "設計 agent",
    message: "Checked responsive rows",
    detail: "compact, standard, and wide",
    status: "done",
  },
];

async function renderActivity(width: number, height: number, selectedRowId = "evt-review") {
  const projection = projectActivitySurface({
    width,
    height,
    state: "ready",
    rows: ROWS,
    selectedRowId,
    scrollOffset: 0,
  });
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const setup = await renderForTest(
    () => <ActivitySurface theme={theme} projection={projection} />,
    { width, height },
  );
  await setup.renderOnce();
  return { setup, projection, frame: () => setup.captureCharFrame() };
}

describe("ActivitySurface OpenTUI renderer", () => {
  it.each([
    [59, 6, "compact"],
    [91, 10, "standard"],
    [171, 16, "wide"],
  ] as const)(
    "records the %sx%s %s native dock-body baseline",
    async (width, height, variant: ActivitySurfaceVariant) => {
      const harness = await renderActivity(width, height);
      const frame = harness.frame();
      expectFrameBounds(frame, width, height);
      expect(harness.projection.variant).toBe(variant);
      expect(stableFrame(frame)).toMatchSnapshot();
      expect(stableFrame(frame)).toContain("Activity");
      expect(stableFrame(frame)).toContain("Codex 5.5");
      expect(stableFrame(frame)).toContain("blocked");
    },
  );

  it.each([
    ["loading", "Loading activity"],
    ["empty", "No activity yet"],
    ["error", "Activity unavailable"],
  ] as const)(
    "renders the %s state through the same presentational boundary",
    async (state, text) => {
      const width = 59;
      const height = 6;
      const projection = projectActivitySurface({
        width,
        height,
        state,
        rows: ROWS,
        selectedRowId: null,
        scrollOffset: 0,
      });
      const setup = await renderForTest(
        () => (
          <ActivitySurface
            theme={createSemanticThemeSnapshot({ mode: "dark" })}
            projection={projection}
          />
        ),
        { width, height },
      );
      await setup.renderOnce();
      expect(stableFrame(setup.captureCharFrame())).toContain(text);
    },
  );
});
