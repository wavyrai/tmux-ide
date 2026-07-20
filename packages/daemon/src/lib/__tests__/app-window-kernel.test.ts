import { describe, expect, it } from "vitest";

import { AppWindowDocumentV1SchemaZ } from "@tmux-ide/contracts";

import {
  APP_WINDOW_FLOAT_MIN_HEIGHT,
  APP_WINDOW_FLOAT_MIN_WIDTH,
  AppWindowKernelError,
  applyAppWindowCommand,
} from "../app-window-kernel.ts";
import { migrateWorkspaceUiStateV2ToAppWindowDocument } from "../../tui/mirror/app-window-state.ts";

const NOW = "2026-07-20T12:00:00.000Z";
const T1 = "2026-07-20T12:01:00.000Z";
const T2 = "2026-07-20T12:02:00.000Z";
const T3 = "2026-07-20T12:03:00.000Z";
const T4 = "2026-07-20T12:04:00.000Z";

function timestamp(minute: number): string {
  return `2026-07-20T12:${String(minute).padStart(2, "0")}:00.000Z`;
}

function document() {
  return migrateWorkspaceUiStateV2ToAppWindowDocument(
    {
      version: 2,
      active: { viewId: "terminals", panel: "terminals" },
      dock: {
        activeTab: "files",
        mode: "open",
        preferredHeight: 12,
        focusZone: "canvas",
      },
      views: {
        files: { panel: "files" },
        missions: { panel: "missions" },
      },
      surfaces: {},
    },
    {
      migratedAt: NOW,
      terminalSourceIds: ["agent-lead", "agent-worker"],
      focusedTerminalSourceId: "agent-lead",
    },
  ).document;
}

function terminalId(state: ReturnType<typeof document>, sourceId: string): string {
  return Object.values(state.windows).find(
    (window) => window.source.kind === "terminal" && window.source.terminalSourceId === sourceId,
  )!.id;
}

function canvasStack(state: ReturnType<typeof document>) {
  const root = state.dockRoot!;
  if (root.type !== "split" || root.children[0]?.type !== "stack") throw new Error("fixture");
  return root.children[0];
}

describe("app window manipulation kernel", () => {
  it("floats, bounds, moves, resizes, and docks while preserving both placement memories", () => {
    const initial = document();
    const id = terminalId(initial, "agent-worker");
    const dockMemory = initial.windows[id]!.placement.docked;
    const floated = applyAppWindowCommand(
      initial,
      { type: "window.float", windowId: id, rect: { x: 4, y: 3, width: 2, height: 1 } },
      T1,
    );
    const moved = applyAppWindowCommand(
      floated,
      { type: "window.move", windowId: id, x: 2_000_000, y: -2_000_000 },
      T2,
    );
    expect(() =>
      applyAppWindowCommand(
        floated,
        { type: "window.dock", windowId: id, stackId: "missing-stack" },
        T2,
      ),
    ).toThrowError(expect.objectContaining({ code: "STACK_NOT_FOUND" }));
    const resized = applyAppWindowCommand(
      moved,
      { type: "window.resize", windowId: id, width: 1, height: 2 },
      T3,
    );
    const docked = applyAppWindowCommand(resized, { type: "window.dock", windowId: id }, T4);

    expect(floated.windows[id]?.placement).toEqual({
      mode: "floating",
      docked: dockMemory,
      floating: {
        x: 4,
        y: 3,
        width: APP_WINDOW_FLOAT_MIN_WIDTH,
        height: APP_WINDOW_FLOAT_MIN_HEIGHT,
      },
    });
    expect(moved.windows[id]?.placement.floating).toMatchObject({
      x: 1_000_000,
      y: -1_000_000,
    });
    expect(resized.windows[id]?.placement.floating).toMatchObject({
      width: APP_WINDOW_FLOAT_MIN_WIDTH,
      height: APP_WINDOW_FLOAT_MIN_HEIGHT,
    });
    expect(docked.windows[id]?.placement).toMatchObject({
      mode: "docked",
      floating: resized.windows[id]?.placement.floating,
    });
    expect(docked.windows[id]?.placement.docked?.stackId).toBe(dockMemory?.stackId);
    expect(docked.focusedWindowId).toBe(id);
    expect(canvasStack(docked).activeWindowId).toBe(id);
    expect(AppWindowDocumentV1SchemaZ.safeParse(docked).success).toBe(true);
    expect(docked.revision).toBe(initial.revision + 4);
  });

  it("raises focused floats and activates/reorders stack tabs through invariant-safe commands", () => {
    const initial = document();
    const lead = terminalId(initial, "agent-lead");
    const worker = terminalId(initial, "agent-worker");
    const firstFloat = applyAppWindowCommand(initial, { type: "window.float", windowId: lead }, T1);
    const secondFloat = applyAppWindowCommand(
      firstFloat,
      { type: "window.float", windowId: worker },
      T2,
    );
    const raised = applyAppWindowCommand(secondFloat, { type: "window.focus", windowId: lead }, T3);
    const redocked = applyAppWindowCommand(
      raised,
      { type: "window.dock", windowId: worker, stackId: "stack-canvas", index: 0 },
      T4,
    );
    const filesId = canvasStack(redocked).windowIds.find(
      (id) => redocked.windows[id]?.source.kind === "native",
    )!;
    const activated = applyAppWindowCommand(
      redocked,
      { type: "stack.activate", stackId: "stack-canvas", windowId: filesId },
      "2026-07-20T12:05:00.000Z",
    );
    const reordered = applyAppWindowCommand(
      activated,
      { type: "stack.reorder", stackId: "stack-canvas", windowId: worker, index: 99 },
      "2026-07-20T12:06:00.000Z",
    );

    expect(raised.floatingOrder.at(-1)).toBe(lead);
    expect(activated.focusedWindowId).toBe(filesId);
    expect(canvasStack(activated).activeWindowId).toBe(filesId);
    expect(canvasStack(reordered).windowIds.at(-1)).toBe(worker);
    expect(reordered.windows[worker]?.placement.docked?.index).toBe(
      canvasStack(reordered).windowIds.length - 1,
    );
    expect(AppWindowDocumentV1SchemaZ.safeParse(reordered).success).toBe(true);
  });

  it("saves, renames, restores, and deletes named layouts deterministically", () => {
    const initial = document();
    const saved = applyAppWindowCommand(
      initial,
      { type: "layout.save", layoutId: "review", name: "Review" },
      T1,
    );
    const renamed = applyAppWindowCommand(
      saved,
      { type: "layout.rename", layoutId: "review", name: "Review two" },
      T2,
    );
    const lead = terminalId(renamed, "agent-lead");
    const floated = applyAppWindowCommand(renamed, { type: "window.float", windowId: lead }, T3);
    const restored = applyAppWindowCommand(
      floated,
      { type: "layout.restore", layoutId: "review" },
      T4,
    );
    const deleted = applyAppWindowCommand(
      restored,
      { type: "layout.delete", layoutId: "review" },
      "2026-07-20T12:05:00.000Z",
    );

    expect(renamed.layouts.review).toMatchObject({ name: "Review two", revision: 2 });
    expect(restored.windows[lead]?.placement.mode).toBe("docked");
    expect(deleted.layouts.review).toBeUndefined();
    expect(deleted.activeLayoutId).toBeNull();
    expect(() =>
      applyAppWindowCommand(
        deleted,
        { type: "layout.restore", layoutId: "review" },
        "2026-07-20T12:06:00.000Z",
      ),
    ).toThrow(AppWindowKernelError);
  });

  it("rejects missing resources, invalid placement, and backwards timestamps with typed errors", () => {
    const initial = document();
    const lead = terminalId(initial, "agent-lead");

    expect(() =>
      applyAppWindowCommand(initial, { type: "window.move", windowId: lead, x: 1, y: 1 }, T1),
    ).toThrowError(expect.objectContaining({ code: "INVALID_PLACEMENT" }));
    expect(() =>
      applyAppWindowCommand(initial, { type: "window.focus", windowId: "missing" }, T1),
    ).toThrowError(expect.objectContaining({ code: "WINDOW_NOT_FOUND" }));
    expect(() =>
      applyAppWindowCommand(initial, { type: "window.focus", windowId: "invalid id" }, T1),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT", path: "$.windowId" }));
    const floated = applyAppWindowCommand(initial, { type: "window.float", windowId: lead }, T1);
    expect(() =>
      applyAppWindowCommand(floated, { type: "window.dock", windowId: lead, stackId: "" }, T2),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT", path: "$.stackId" }));
    expect(() =>
      applyAppWindowCommand(initial, { type: "window.focus", windowId: lead }, "not-a-time"),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT", path: "$.timestamp" }));
    expect(() =>
      applyAppWindowCommand(
        initial,
        { type: "window.focus", windowId: lead },
        "2020-01-01T00:00:00.000Z",
      ),
    ).toThrowError(expect.objectContaining({ code: "TIMESTAMP_REGRESSION" }));
  });

  it("collapses an emptied dock tree and deterministically recreates a root stack", () => {
    let state = document();
    const dockedIds = Object.values(state.windows)
      .filter((window) => window.placement.mode === "docked")
      .map((window) => window.id);

    for (const [index, windowId] of dockedIds.entries()) {
      state = applyAppWindowCommand(
        state,
        { type: "window.float", windowId },
        timestamp(index + 1),
      );
    }

    expect(state.dockRoot).toBeNull();
    expect(state.floatingOrder).toHaveLength(dockedIds.length);
    const restoredId = dockedIds.at(-1)!;
    const restored = applyAppWindowCommand(
      state,
      { type: "window.dock", windowId: restoredId },
      timestamp(dockedIds.length + 1),
    );

    expect(restored.dockRoot).toEqual({
      type: "stack",
      id: "stack-root",
      windowIds: [restoredId],
      activeWindowId: restoredId,
    });
    expect(restored.windows[restoredId]?.placement.docked).toEqual({
      stackId: "stack-root",
      index: 0,
    });
    expect(AppWindowDocumentV1SchemaZ.safeParse(restored).success).toBe(true);
  });

  it("does not turn the legacy bottom-dock mode into durable window maximize state", () => {
    const initial = AppWindowDocumentV1SchemaZ.parse({
      ...document(),
      dockState: { mode: "maximized", preferredHeight: 30, focusZone: "dock-body" },
    });
    const worker = terminalId(initial, "agent-worker");
    const floated = applyAppWindowCommand(initial, { type: "window.float", windowId: worker }, T1);
    const moved = applyAppWindowCommand(
      floated,
      { type: "window.move", windowId: worker, x: 10, y: 5 },
      T2,
    );
    const resized = applyAppWindowCommand(
      moved,
      { type: "window.resize", windowId: worker, width: 60, height: 20 },
      T3,
    );
    const docked = applyAppWindowCommand(resized, { type: "window.dock", windowId: worker }, T4);

    for (const state of [floated, moved, resized, docked]) {
      expect(state.dockState).toEqual(initial.dockState);
      expect(Object.keys(state.windows[worker]!)).not.toContain("maximized");
    }
  });

  it("rejects non-finite geometry before it can enter durable state", () => {
    const initial = document();
    const worker = terminalId(initial, "agent-worker");

    expect(() =>
      applyAppWindowCommand(
        initial,
        {
          type: "window.float",
          windowId: worker,
          rect: { x: Number.NaN, y: 0, width: 40, height: 12 },
        },
        T1,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT", path: "$.rect.x" }));
    const floated = applyAppWindowCommand(initial, { type: "window.float", windowId: worker }, T1);
    expect(() =>
      applyAppWindowCommand(
        floated,
        { type: "window.resize", windowId: worker, width: Number.POSITIVE_INFINITY, height: 10 },
        T2,
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_INPUT", path: "$.width" }));
  });
});
