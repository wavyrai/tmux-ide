import { describe, expect, it } from "vitest";
import {
  activityOrderSequence,
  activityRowHitTest,
  activitySurfaceVariant,
  clampActivityScrollOffset,
  orderActivityRows,
  projectActivitySurface,
  type ActivityRowDto,
  type ActivitySurfaceInput,
} from "./activity-surface.ts";

const ROWS: readonly ActivityRowDto[] = [
  {
    kind: "event",
    id: "evt-older",
    sequence: 7,
    timestampText: "12:01",
    source: "mission",
    message: "Goal created",
    status: "idle",
  },
  {
    kind: "agent",
    id: "agent-z",
    sequence: 9,
    timestampText: "12:03",
    agent: "Codex",
    message: "Implemented activity projection",
    detail: "tests pending",
    status: "working",
  },
  {
    kind: "event",
    id: "event-a",
    sequence: 9,
    timestampText: "12:02",
    source: "quality gate",
    message: "Renderer failed",
    status: "blocked",
    attention: true,
  },
];

function input(overrides: Partial<ActivitySurfaceInput> = {}): ActivitySurfaceInput {
  return {
    width: 91,
    height: 10,
    state: "ready",
    rows: ROWS,
    selectedRowId: "agent-z",
    scrollOffset: 0,
    ...overrides,
  };
}

describe("ActivitySurface projection", () => {
  it.each([
    [59, 6, "compact"],
    [91, 10, "standard"],
    [171, 16, "wide"],
  ] as const)("uses the %sx%s %s dock-body projection", (width, height, variant) => {
    expect(activitySurfaceVariant(width, height)).toBe(variant);
    const projection = projectActivitySurface(input({ width, height }));
    expect(projection.variant).toBe(variant);
    expect(projection.header.height + projection.body.height + projection.footer.height).toBe(
      height,
    );
    expect(projection.list.width + projection.scrollbar.width).toBe(width);
    expect(
      projection.rows.every(
        (row) =>
          row.x >= 0 &&
          row.y >= projection.body.y &&
          row.x + row.width <= width &&
          row.y + row.height <= projection.footer.y,
      ),
    ).toBe(true);
  });

  it("orders newest first and breaks equal sequences by stable identity", () => {
    expect(orderActivityRows(ROWS).map((row) => row.id)).toEqual([
      "agent-z",
      "event-a",
      "evt-older",
    ]);
    expect(orderActivityRows([...ROWS].reverse()).map((row) => row.id)).toEqual([
      "agent-z",
      "event-a",
      "evt-older",
    ]);
  });

  it("normalizes agent epoch-seconds and mission ISO timestamps into one order", () => {
    const rows: ActivityRowDto[] = [
      {
        kind: "agent",
        id: "agent-old",
        sequence: activityOrderSequence(1_700_000_000),
        timestampText: "12:03",
        agent: "Codex",
        message: "working",
        status: "working",
      },
      {
        kind: "event",
        id: "mission-new",
        sequence: activityOrderSequence("2024-07-22T12:04:00.000Z", 4),
        timestampText: "12:04",
        source: "mission",
        message: "completed",
        status: "done",
      },
    ];
    expect(orderActivityRows(rows).map((row) => row.id)).toEqual(["mission-new", "agent-old"]);
  });

  it.each([
    ["loading", "Loading recent agent"],
    ["empty", "Agent work and mission"],
    ["error", "Activity could not be loaded"],
  ] as const)("projects the %s state without stale rows", (state, message) => {
    const projection = projectActivitySurface(input({ state }));
    expect(projection.state).toBe(state);
    expect(projection.rows).toEqual([]);
    expect(projection.message).toContain(message);
  });

  it("coerces ready-without-rows to the useful empty state", () => {
    expect(projectActivitySurface(input({ rows: [] }))).toMatchObject({
      state: "empty",
      totalRows: 0,
      rows: [],
      selectedRowId: null,
      selectedRowIndex: -1,
    });
  });

  it("counts explicit attention and status text independently from selection", () => {
    const projection = projectActivitySurface(input({ selectedRowId: "event-a" }));
    expect(projection.attentionCount).toBe(1);
    expect(projection.statusCounts).toEqual({
      blocked: 1,
      working: 1,
      done: 0,
      idle: 1,
      unknown: 0,
    });
    expect(projection.summary).toContain("1 attention");
    expect(projection.rows.find((row) => row.id === "event-a")).toMatchObject({
      selected: true,
      attention: true,
      statusText: "blocked",
      timestampText: "12:02",
    });
  });

  it("clamps scroll and follows a selected row into the visible window", () => {
    const manyRows: ActivityRowDto[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "event",
      id: `event-${String(index).padStart(2, "0")}`,
      sequence: 12 - index,
      timestampText: `${index}m`,
      source: "mission",
      message: `event ${index}`,
      status: "unknown",
    }));
    expect(clampActivityScrollOffset(manyRows.length, 4, -20)).toBe(0);
    expect(clampActivityScrollOffset(manyRows.length, 4, 200)).toBe(8);

    const projection = projectActivitySurface(
      input({
        width: 59,
        height: 6,
        rows: manyRows,
        selectedRowId: "event-10",
        scrollOffset: 0,
      }),
    );
    expect(projection.body.height).toBe(4);
    expect(projection.maximumScrollOffset).toBe(8);
    expect(projection.scrollOffset).toBe(7);
    expect(projection.rows.map((row) => row.id)).toEqual([
      "event-07",
      "event-08",
      "event-09",
      "event-10",
    ]);
    expect(projection.rows.at(-1)?.selected).toBe(true);
  });

  it("hit-tests every projected row cell and rejects header, scrollbar, footer, and blanks", () => {
    const manyRows = [...ROWS, ...ROWS.map((row, index) => ({ ...row, id: `${row.id}-${index}` }))];
    const projection = projectActivitySurface(
      input({ width: 59, height: 6, rows: manyRows, selectedRowId: null }),
    );
    const row = projection.rows[1]!;
    const expected = {
      kind: "row",
      rowId: row.id,
      rowIndex: row.rowIndex,
      sequence: row.sequence,
    };
    expect(activityRowHitTest(projection, row.x, row.y)).toEqual(expected);
    expect(activityRowHitTest(projection, row.x + row.width - 1, row.y)).toEqual(expected);
    expect(activityRowHitTest(projection, 1, projection.header.y)).toBeNull();
    expect(activityRowHitTest(projection, projection.scrollbar.x, row.y)).toBeNull();
    expect(activityRowHitTest(projection, 1, projection.footer.y)).toBeNull();
    expect(activityRowHitTest(projection, -1, row.y)).toBeNull();
    expect(activityRowHitTest(projection, Number.NaN, row.y)).toBeNull();

    const blank = projectActivitySurface(input({ rows: ROWS.slice(0, 1), selectedRowId: null }));
    expect(activityRowHitTest(blank, 1, blank.body.y + 1)).toBeNull();
  });
});
