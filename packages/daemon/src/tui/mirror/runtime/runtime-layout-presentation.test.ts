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

    presentation.adopt(first);
    presentation.adopt(candidate);
    expect(presentation.getSnapshot()?.windowName).toBe("first");
    expect(seen).toEqual([null, "first"]);

    candidate.publish({ current: secondLayout, windows: [secondLayout] });
    expect(presentation.getSnapshot()?.windowName).toBe("second");
    expect(seen).toEqual([null, "first", "second"]);
  });

  test("fences layouts arriving from a retired port", () => {
    const presentation = createOpenTuiRuntimeLayoutPresentation();
    const firstLayout = layout("first");
    const secondLayout = layout("second");
    const lateLayout = layout("late-first");
    const first = port({ current: firstLayout, windows: [firstLayout] });
    const second = port({ current: secondLayout, windows: [secondLayout] });

    presentation.adopt(first);
    presentation.adopt(second);
    first.publish({ current: lateLayout, windows: [lateLayout] });

    expect(presentation.getSnapshot()?.windowName).toBe("second");
  });
});
