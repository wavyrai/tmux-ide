import { describe, expect, it } from "vitest";

import type { LayoutFrame } from "./workspace-layout-tiles.ts";
import {
  beginWorkspacePaneDrag,
  beginWorkspacePaneResize,
  cancelWorkspacePaneManipulation,
  createWorkspacePaneIdle,
  finishWorkspacePaneManipulation,
  flushWorkspacePaneResizeWire,
  paneManipulationPresentation,
  PANE_DRAG_THRESHOLD_PX,
  PANE_RESIZE_WIRE_INTERVAL_MS,
  previewWorkspacePaneManipulation,
  updateWorkspacePaneManipulation,
  type WorkspacePaneDrag,
  type WorkspacePaneResize,
  type WorkspacePointerSample,
} from "./workspace-pane-manipulation.ts";

function frame(): LayoutFrame {
  return {
    semanticWindowId: "window.main",
    windowName: "main",
    currentWindow: true,
    cols: 100,
    rows: 50,
    zoomed: false,
    panes: [
      { pane: "pane.a", left: 0, top: 0, width: 39, height: 50, active: true },
      { pane: "pane.b", left: 40, top: 0, width: 60, height: 19, active: false },
      { pane: "pane.c", left: 40, top: 20, width: 60, height: 30, active: false },
    ],
  };
}

const BOX = { left: 100, top: 50, width: 1_000, height: 500 };

function pointer(
  x: number,
  y: number,
  atMs: number,
  input: Partial<WorkspacePointerSample> = {},
): WorkspacePointerSample {
  return { pointerId: 7, x, y, atMs, ...input };
}

function resize(): WorkspacePaneResize {
  const started = beginWorkspacePaneResize(createWorkspacePaneIdle(frame()), {
    borderId: "pane.a:cols",
    pointer: pointer(495, 200, 10),
    gridBox: BOX,
  });
  expect(started.kind).toBe("resize");
  return started as WorkspacePaneResize;
}

function drag(): WorkspacePaneDrag {
  const started = beginWorkspacePaneDrag(createWorkspacePaneIdle(frame()), {
    pane: "pane.a",
    pointer: pointer(200, 200, 10),
    gridBox: BOX,
  });
  expect(started.kind).toBe("drag");
  return started as WorkspacePaneDrag;
}

describe("workspace pane manipulation", () => {
  it("takes an immutable layout snapshot rather than observing later frame mutations", () => {
    const mutable = frame();
    const idle = createWorkspacePaneIdle(mutable);
    (mutable.panes[0] as { width: number }).width = 2;

    expect(idle.snapshot.frame.panes[0]?.width).toBe(39);
    expect(idle.snapshot.tiles.find((tile) => tile.pane === "pane.a")?.cells.cols).toBe(39);
    expect(Object.isFrozen(idle.snapshot.frame)).toBe(true);
    expect(Object.isFrozen(idle.snapshot.frame.panes)).toBe(true);
    expect(Object.isFrozen(idle.snapshot.tiles[0]?.rect)).toBe(true);
  });

  it("advertises immediate compositor-only feedback and disables settling for reduced motion", () => {
    expect(paneManipulationPresentation(false)).toMatchObject({
      reducedMotion: false,
      inputDelayMs: 0,
      liveProperties: ["transform", "opacity"],
      liveTransitionMs: 0,
      settleTransition: { durationMs: 150, easing: "var(--ease-smooth)" },
    });
    expect(paneManipulationPresentation(true).settleTransition.durationMs).toBe(0);
  });

  it("refuses invalid geometry, unknown handles, and non-primary starts", () => {
    const idle = createWorkspacePaneIdle(frame());
    expect(
      beginWorkspacePaneResize(idle, {
        borderId: "missing",
        pointer: pointer(0, 0, 0),
        gridBox: BOX,
      }),
    ).toBe(idle);
    expect(
      beginWorkspacePaneDrag(idle, {
        pane: "pane.a",
        pointer: pointer(0, 0, 0, { isPrimary: false }),
        gridBox: BOX,
      }),
    ).toBe(idle);
    expect(
      beginWorkspacePaneDrag(idle, {
        pane: "pane.a",
        pointer: pointer(0, 0, 0),
        gridBox: { ...BOX, width: 0 },
      }),
    ).toBe(idle);
  });

  it("keeps the first pointer as owner and ignores foreign or secondary samples", () => {
    const started = drag();
    expect(
      beginWorkspacePaneResize(started, {
        borderId: "pane.a:cols",
        pointer: pointer(500, 200, 10, { pointerId: 8 }),
        gridBox: BOX,
      }),
    ).toBe(started);

    const foreign = updateWorkspacePaneManipulation(
      started,
      pointer(800, 100, 20, { pointerId: 8 }),
    );
    const secondary = updateWorkspacePaneManipulation(
      started,
      pointer(800, 100, 20, { isPrimary: false }),
    );
    expect(foreign.state).toBe(started);
    expect(foreign.ignored).toBe(true);
    expect(secondary.state).toBe(started);
    expect(secondary.ignored).toBe(true);
  });

  it("snaps every resize preview to measured cells without waiting for the wire", () => {
    const started = resize();
    const subcell = updateWorkspacePaneManipulation(started, pointer(499, 200, 20));
    expect(subcell.preview).toMatchObject({
      kind: "resize",
      originalCells: 39,
      cells: 39,
      movedCells: 0,
      guideTransform: { translateX: 0, translateY: 0 },
    });
    expect(subcell.wire.dispatch).toBeNull();

    const snapped = updateWorkspacePaneManipulation(subcell.state, pointer(509, 200, 30));
    expect(snapped.preview).toMatchObject({
      kind: "resize",
      cells: 40,
      movedCells: 1,
      guideTransform: { translateX: 10, translateY: 0 },
    });
    expect(snapped.wire.dispatch).toEqual({
      command: { pane: "pane.a", axis: "cols", cells: 40 },
      reason: "live",
    });
  });

  it("clamps resize previews to the frozen window bounds", () => {
    const started = resize();
    expect(
      updateWorkspacePaneManipulation(started, pointer(-10_000, 200, 20)).preview,
    ).toMatchObject({ kind: "resize", cells: 1 });
    expect(
      updateWorkspacePaneManipulation(started, pointer(10_000, 200, 20)).preview,
    ).toMatchObject({ kind: "resize", cells: 100 });
  });

  it("emits at most one live resize per 80ms and replaces its trailing target", () => {
    expect(PANE_RESIZE_WIRE_INTERVAL_MS).toBe(80);
    const first = updateWorkspacePaneManipulation(resize(), pointer(515, 200, 10));
    expect(first.wire.dispatch).toMatchObject({
      command: { cells: 41 },
      reason: "live",
    });

    const second = updateWorkspacePaneManipulation(first.state, pointer(525, 200, 30));
    expect(second.wire).toEqual({
      dispatch: null,
      trailing: {
        dueAtMs: 90,
        delayMs: 60,
        command: { pane: "pane.a", axis: "cols", cells: 42 },
      },
    });

    const latest = updateWorkspacePaneManipulation(second.state, pointer(535, 200, 50));
    expect(latest.wire.trailing).toEqual({
      dueAtMs: 90,
      delayMs: 40,
      command: { pane: "pane.a", axis: "cols", cells: 43 },
    });
  });

  it("flushes only the latest trailing resize when its pure deadline arrives", () => {
    const first = updateWorkspacePaneManipulation(resize(), pointer(515, 200, 10));
    const pending = updateWorkspacePaneManipulation(first.state, pointer(535, 200, 30));
    const early = flushWorkspacePaneResizeWire(pending.state, 89);
    expect(early.wire.dispatch).toBeNull();
    expect(early.wire.trailing?.delayMs).toBe(1);

    const due = flushWorkspacePaneResizeWire(early.state, 90);
    expect(due.wire).toEqual({
      dispatch: {
        command: { pane: "pane.a", axis: "cols", cells: 43 },
        reason: "timer",
      },
      trailing: null,
    });
    expect((due.state as WorkspacePaneResize).lastWiredCells).toBe(43);
  });

  it("cancels a stale trailing target when the pointer returns to the wired cell", () => {
    const first = updateWorkspacePaneManipulation(resize(), pointer(515, 200, 10));
    const pending = updateWorkspacePaneManipulation(first.state, pointer(535, 200, 30));
    const returned = updateWorkspacePaneManipulation(pending.state, pointer(515, 200, 40));
    expect(returned.wire).toEqual({ dispatch: null, trailing: null });
    expect((returned.state as WorkspacePaneResize).pendingWire).toBeNull();
  });

  it("flushes the release cell and returns to the frozen idle frame", () => {
    const first = updateWorkspacePaneManipulation(resize(), pointer(515, 200, 10));
    const pending = updateWorkspacePaneManipulation(first.state, pointer(525, 200, 30));
    const finished = finishWorkspacePaneManipulation(pending.state, pointer(545, 200, 35));

    expect(finished.completion).toEqual({
      kind: "resize",
      pane: "pane.a",
      axis: "cols",
      cells: 44,
      changed: true,
    });
    expect(finished.wire).toEqual({
      dispatch: {
        command: { pane: "pane.a", axis: "cols", cells: 44 },
        reason: "final",
      },
      trailing: null,
    });
    expect(finished.state.kind).toBe("idle");
    expect(finished.preview.kind).toBe("idle");
  });

  it("flushes the original cell on release after a live resize moved tmux away", () => {
    const moved = updateWorkspacePaneManipulation(resize(), pointer(515, 200, 10));
    const returned = finishWorkspacePaneManipulation(moved.state, pointer(495, 200, 20));

    expect(returned.completion).toMatchObject({ kind: "resize", cells: 39, changed: false });
    expect(returned.wire.dispatch).toEqual({
      command: { pane: "pane.a", axis: "cols", cells: 39 },
      reason: "final",
    });
  });

  it("rolls live resize effects back on cancel and drops unsent trailing work", () => {
    const first = updateWorkspacePaneManipulation(resize(), pointer(515, 200, 10));
    const pending = updateWorkspacePaneManipulation(first.state, pointer(535, 200, 30));
    const cancelled = cancelWorkspacePaneManipulation(pending.state, { pointerId: 7 });

    expect(cancelled.completion).toEqual({ kind: "cancelled", rolledBack: true });
    expect(cancelled.wire).toEqual({
      dispatch: {
        command: { pane: "pane.a", axis: "cols", cells: 39 },
        reason: "rollback",
      },
      trailing: null,
    });
    expect(cancelled.state.kind).toBe("idle");
  });

  it("ignores a foreign release or cancellation without ending the transaction", () => {
    const started = resize();
    const released = finishWorkspacePaneManipulation(
      started,
      pointer(600, 200, 20, { pointerId: 8 }),
    );
    const cancelled = cancelWorkspacePaneManipulation(started, { pointerId: 8 });
    expect(released.state).toBe(started);
    expect(released.completion).toBeNull();
    expect(cancelled.state).toBe(started);
    expect(cancelled.completion).toBeNull();
  });

  it("uses a five-pixel threshold without delaying the activated drag", () => {
    expect(PANE_DRAG_THRESHOLD_PX).toBe(5);
    const started = beginWorkspacePaneDrag(createWorkspacePaneIdle(frame()), {
      pane: "pane.a",
      pointer: pointer(200, 200, 10),
      gridBox: BOX,
    });
    const clickRange = updateWorkspacePaneManipulation(started, pointer(203, 203, 11));
    expect(clickRange.preview).toMatchObject({ kind: "drag", activated: false });

    const activated = updateWorkspacePaneManipulation(clickRange.state, pointer(203, 204, 12));
    expect(activated.preview).toMatchObject({ kind: "drag", activated: true });
    expect((activated.state as WorkspacePaneDrag).current).toEqual(pointer(203, 204, 12));
  });

  it("targets unequal panes from the cursor and keeps pane identity stable in local previews", () => {
    const upper = updateWorkspacePaneManipulation(drag(), pointer(800, 100, 20));
    expect(upper.preview).toMatchObject({
      kind: "drag",
      sourcePane: "pane.a",
      targetPane: "pane.b",
      activated: true,
    });
    if (upper.preview.kind !== "drag") throw new Error("expected drag preview");
    expect(upper.preview.placements.map((placement) => placement.pane)).toEqual([
      "pane.a",
      "pane.b",
      "pane.c",
    ]);
    expect(upper.preview.placements[0]).toMatchObject({
      pane: "pane.a",
      transform: { translateX: 600, translateY: -100, scaleX: 1, scaleY: 1 },
      opacity: 0.92,
      elevated: true,
    });
    expect(upper.preview.placements[1]?.transform.scaleY).toBeGreaterThan(2);

    const lower = updateWorkspacePaneManipulation(upper.state, pointer(800, 400, 30));
    expect(lower.preview).toMatchObject({ kind: "drag", targetPane: "pane.c" });
    if (lower.preview.kind !== "drag") throw new Error("expected drag preview");
    expect(lower.preview.placements.map((placement) => placement.pane)).toEqual([
      "pane.a",
      "pane.b",
      "pane.c",
    ]);
    expect(lower.preview.placements[1]?.transform).toEqual({
      translateX: 0,
      translateY: 0,
      scaleX: 1,
      scaleY: 1,
    });
    expect(lower.preview.placements[2]?.transform.scaleY).toBeGreaterThan(1);
  });

  it("commits one cursor-selected swap, while clicks, outside drops, and cancels roll back", () => {
    const clicked = finishWorkspacePaneManipulation(drag(), pointer(203, 203, 20));
    expect(clicked.completion).toEqual({ kind: "noop" });

    const outside = finishWorkspacePaneManipulation(drag(), pointer(1_500, 900, 20));
    expect(outside.completion).toEqual({ kind: "noop" });

    const dropped = finishWorkspacePaneManipulation(drag(), pointer(800, 400, 20));
    expect(dropped.completion).toEqual({
      kind: "swap",
      sourcePane: "pane.a",
      targetPane: "pane.c",
    });

    const moved = updateWorkspacePaneManipulation(drag(), pointer(800, 400, 20));
    const cancelled = cancelWorkspacePaneManipulation(moved.state);
    expect(cancelled.completion).toEqual({ kind: "cancelled", rolledBack: true });
    expect(cancelled.preview).toEqual(previewWorkspacePaneManipulation(cancelled.state));
    expect(cancelled.preview.kind).toBe("idle");
  });
});
