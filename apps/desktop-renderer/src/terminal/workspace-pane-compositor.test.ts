import { PANE_STREAM_MAX_PANES } from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";

import { createScriptedPaneStream } from "./mirror-pane-fixture.ts";
import { WorkspacePaneCompositor } from "./workspace-pane-compositor.ts";

const PANE_A = "pane.workspace.a";
const PANE_B = "pane.workspace.b";

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("Workspace pane compositor", () => {
  it("atomically replaces the full layout batch and prunes an absent window", async () => {
    const stream = createScriptedPaneStream();
    const compositor = new WorkspacePaneCompositor({
      transport: stream.transport,
      workspaceName: "workspace-a",
      panes: [PANE_A, PANE_B],
    });
    compositor.start();
    await settle();
    const layout = (window: string, pane: string, current: boolean) => ({
      semanticWindowId: window,
      windowName: window,
      currentWindow: current,
      cols: 80,
      rows: 24,
      zoomed: false,
      paneBorderStatus: "off" as const,
      panes: [{ pane, left: 0, top: 0, width: 80, height: 24, active: true }],
    });
    stream.latest().layoutSnapshot({
      topologyEpoch: 1,
      layouts: [layout("window-a", PANE_A, true), layout("window-b", PANE_B, false)],
    });
    expect(compositor.state().layouts.map(({ semanticWindowId }) => semanticWindowId)).toEqual([
      "window-a",
      "window-b",
    ]);
    stream.latest().layoutSnapshot({
      topologyEpoch: 2,
      layouts: [
        {
          ...layout("window-a", PANE_A, true),
          panes: [
            { pane: PANE_A, left: 0, top: 0, width: 40, height: 24, active: true },
            { pane: PANE_B, left: 40, top: 0, width: 40, height: 24, active: false },
          ],
        },
      ],
    });
    expect(compositor.state().layouts.map(({ semanticWindowId }) => semanticWindowId)).toEqual([
      "window-a",
    ]);
    compositor.dispose();
  });

  it("serializes sink backpressure and retains one authoritative replay while unmounted", async () => {
    const stream = createScriptedPaneStream();
    const compositor = new WorkspacePaneCompositor({
      transport: stream.transport,
      workspaceName: "workspace-a",
      panes: [PANE_A],
    });
    compositor.start();
    await settle();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const output = vi.fn(async () => await blocked);
    compositor.registerPaneSink(PANE_A, {
      applySeedBatch: vi.fn(),
      applyGeometry: vi.fn(),
      applyOutput: output,
      applyCursor: vi.fn(),
    });
    const first = stream.latest().emit(PANE_A, {
      type: "output",
      bytes: new Uint8Array([1]),
      replay: () => ({ reset: null, seed: new Uint8Array([1]), held: [], cursor: null }),
    });
    await settle();
    expect(output).toHaveBeenCalledTimes(1);
    let secondSettled = false;
    const second = Promise.resolve(
      stream.latest().emit(PANE_A, {
        type: "output",
        bytes: new Uint8Array([2]),
        replay: () => ({ reset: null, seed: new Uint8Array([2]), held: [], cursor: null }),
      }),
    ).then(() => (secondSettled = true));
    await settle();
    expect(secondSettled).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(output).toHaveBeenCalledTimes(2);
    compositor.dispose();
  });

  it("fences a retired pane-set session without becoming a second document-presence owner", async () => {
    const stream = createScriptedPaneStream();
    const compositor = new WorkspacePaneCompositor({
      transport: stream.transport,
      workspaceName: "workspace-a",
      panes: [PANE_A],
    });
    compositor.start();
    await settle();
    const first = stream.latest();
    compositor.setPanes([PANE_B]);
    await settle();
    expect(stream.sessions).toHaveLength(2);
    await first.emit(PANE_A, { type: "cursor", x: 4, y: 5 });
    expect(compositor.state().panes.has(PANE_A)).toBe(false);
    expect(stream.latest().presence).toEqual([]);
    expect(stream.latest().activity).toEqual([]);
    compositor.dispose();
    expect(stream.latest().disposed).toBe(true);
  });

  it("keeps a retained pane sink's unregister authority across a pane-set restamp", async () => {
    const stream = createScriptedPaneStream();
    const compositor = new WorkspacePaneCompositor({
      transport: stream.transport,
      workspaceName: "workspace-a",
      panes: [PANE_A],
    });
    compositor.start();
    await settle();
    const output = vi.fn();
    const unregister = compositor.registerPaneSink(PANE_A, {
      applySeedBatch: vi.fn(),
      applyGeometry: vi.fn(),
      applyOutput: output,
      applyCursor: vi.fn(),
    });
    compositor.setPanes([PANE_A, PANE_B]);
    await settle();
    unregister();
    await stream.latest().emit(PANE_A, { type: "output", bytes: new Uint8Array([3]) });
    await settle();
    expect(output).not.toHaveBeenCalled();
    compositor.dispose();
  });

  it("coalesces a blocked layout flood to one latest geometry before later output", async () => {
    const stream = createScriptedPaneStream();
    const compositor = new WorkspacePaneCompositor({
      transport: stream.transport,
      workspaceName: "workspace-a",
      panes: [PANE_A],
    });
    compositor.start();
    await settle();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const geometries: Array<[number, number]> = [];
    compositor.registerPaneSink(PANE_A, {
      applySeedBatch: vi.fn(),
      applyGeometry: (cols, rows) => geometries.push([cols, rows]),
      applyOutput: async () => await blocked,
      applyCursor: vi.fn(),
    });
    const output = stream.latest().emit(PANE_A, { type: "output", bytes: new Uint8Array([1]) });
    await settle();
    for (let index = 0; index < 5_000; index += 1)
      stream.latest().layout({
        semanticWindowId: "window-a",
        windowName: "window-a",
        currentWindow: true,
        cols: 80 + index,
        rows: 24,
        zoomed: false,
        paneBorderStatus: "off",
        panes: [
          {
            pane: PANE_A,
            left: 0,
            top: 0,
            width: 80 + index,
            height: 24,
            active: true,
          },
        ],
      });
    expect(geometries).toEqual([]);
    release();
    await output;
    await settle();
    expect(geometries).toEqual([[5_079, 24]]);
    compositor.dispose();
  });

  it("bounds unique window churn and prunes layouts against an authoritative pane restamp", async () => {
    const stream = createScriptedPaneStream();
    const compositor = new WorkspacePaneCompositor({
      transport: stream.transport,
      workspaceName: "workspace-a",
      panes: [PANE_A, PANE_B],
    });
    compositor.start();
    await settle();
    for (let index = 0; index < 5_000; index += 1)
      stream.latest().layout({
        semanticWindowId: `window-a-${index}`,
        windowName: `window-a-${index}`,
        currentWindow: index === 4_999,
        cols: 80,
        rows: 24,
        zoomed: false,
        paneBorderStatus: "off",
        panes: [{ pane: PANE_A, left: 0, top: 0, width: 80, height: 24, active: true }],
      });
    stream.latest().layout({
      semanticWindowId: "window-b",
      windowName: "window-b",
      currentWindow: false,
      cols: 90,
      rows: 30,
      zoomed: false,
      paneBorderStatus: "off",
      panes: [{ pane: PANE_B, left: 0, top: 0, width: 90, height: 30, active: true }],
    });
    expect(compositor.state().layouts).toHaveLength(PANE_STREAM_MAX_PANES);
    expect(compositor.state().layouts.at(-1)?.semanticWindowId).toBe("window-b");

    compositor.setPanes([PANE_B]);
    await settle();
    expect(compositor.state().layouts.map(({ semanticWindowId }) => semanticWindowId)).toEqual([
      "window-b",
    ]);
    compositor.dispose();
  });
});
