import { describe, expect, test } from "bun:test";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { createOpenTuiRuntimeLayoutPresentation } from "./runtime-layout-presentation.ts";

type Listener = (snapshot: OpenTuiWorkspaceLayoutSnapshot) => void;

function layout(name: string) {
  return {
    type: "layout" as const,
    workspaceName: "workspace",
    semanticWindowId: name,
    windowName: name,
    currentWindow: true,
    panes: [],
  };
}

function port(initial: OpenTuiWorkspaceLayoutSnapshot) {
  const listeners = new Set<Listener>();
  let snapshot = initial;
  return {
    onLayout(listener: Listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    publish(next: OpenTuiWorkspaceLayoutSnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

describe("OpenTUI runtime layout presentation", () => {
  test("retains the prior frame until a candidate publishes a coherent layout", () => {
    const presentation = createOpenTuiRuntimeLayoutPresentation();
    const firstLayout = layout("first");
    const secondLayout = layout("second");
    const first = port({ current: firstLayout, windows: [firstLayout] });
    const candidate = port({ current: null, windows: [] });
    const seen: Array<string | null> = [];
    presentation.subscribe((value) => seen.push(value?.windowName ?? null));

    presentation.adopt(first, 1);
    presentation.adopt(candidate, 2);
    expect(presentation.getSnapshot()?.windowName).toBe("first");
    expect(seen).toEqual([null, "first"]);
    expect(presentation.getWindowSnapshot().rendererEpoch).toBe(1);

    candidate.publish({ current: secondLayout, windows: [secondLayout] });
    expect(presentation.getSnapshot()?.windowName).toBe("second");
    expect(seen).toEqual([null, "first", "second"]);
    expect(presentation.getWindowSnapshot().rendererEpoch).toBe(2);
  });

  test("fences layouts arriving from a retired port", () => {
    const presentation = createOpenTuiRuntimeLayoutPresentation();
    const firstLayout = layout("first");
    const secondLayout = layout("second");
    const lateLayout = layout("late-first");
    const first = port({ current: firstLayout, windows: [firstLayout] });
    const second = port({ current: secondLayout, windows: [secondLayout] });

    presentation.adopt(first, 1);
    presentation.adopt(second, 2);
    first.publish({ current: lateLayout, windows: [lateLayout] });

    expect(presentation.getSnapshot()?.windowName).toBe("second");
    expect(presentation.getWindowSnapshot().rendererEpoch).toBe(2);
    presentation.clear();
    expect(presentation.getWindowSnapshot().rendererEpoch).toBeUndefined();
  });
});

test("stamps synchronous seeds without mutating or relabeling reused snapshots", () => {
  const presentation = createOpenTuiRuntimeLayoutPresentation();
  const frame = layout("shared");
  const shared = { current: frame, windows: [frame] };
  const seen: OpenTuiWorkspaceLayoutSnapshot[] = [];
  presentation.subscribeWindows((snapshot) => seen.push(snapshot));
  presentation.adopt(port(shared), 4);
  const retained = presentation.getWindowSnapshot();
  presentation.adopt(port(shared), 5);
  expect(retained.rendererEpoch).toBe(4);
  expect(presentation.getWindowSnapshot().rendererEpoch).toBe(5);
  expect(presentation.getWindowSnapshot()).not.toBe(retained);
  expect(shared).not.toHaveProperty("rendererEpoch");
  expect(seen.map((snapshot) => snapshot.rendererEpoch)).toEqual([undefined, 4, 5]);
});
