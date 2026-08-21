import { describe, expect, it, vi } from "vitest";

import { createPaneSurfaceHostFocusTransitionOwner } from "../pane-surface.tsx";
import { createApplicationHostFocusPresentation } from "./application-host-focus-presentation.ts";

describe("application host focus presentation", () => {
  it("waits for an exact post-paint frame and rejects a rebind before the fence", () => {
    const listeners = new Map<string, Set<() => void>>();
    let renderRequests = 0;
    const renderer = {
      on: (event: string, listener: () => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
      },
      off: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
      requestRender: () => {
        renderRequests += 1;
      },
    };
    const emit = (event: string) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    };
    const identity = {
      generation: "generation-1",
      incarnation: "incarnation-1",
      revision: 1,
      stateHash: "0a63b052b8f1d994",
      cols: 10,
      rows: 6,
      sourceEpoch: 4,
    } as const;
    let daemonGeneration = identity.generation;
    const source = () => ({
      rendererEpoch: 3,
      daemonGeneration,
      clientGeneration: 7,
      adapter: { paneCanonicalIdentity: () => identity },
    });
    let focused = true;
    let epoch = 0;
    const fences = vi.fn();
    const owner = createPaneSurfaceHostFocusTransitionOwner(() => renderer.requestRender());
    const presentation = createApplicationHostFocusPresentation({
      renderer: renderer as never,
      owner,
      sink: { terminalFocusFence: fences } as never,
      hostFocus: {
        rendererBlur: () => ++epoch,
        rendererFocus: () => ++epoch,
      } as never,
      focusedPane: () => "pane-1",
      rendererFocused: () => focused,
      setRendererFocused: (next) => {
        focused = next;
      },
      rendererSource: () => source() as never,
    });
    const event = (diagnosticEpoch: number, nextFocused: boolean) =>
      ({
        processId: "opentui:123",
        clockId: "opentui-performance-now",
        clockKind: "performance-now",
        atMicros: 100,
        semanticPaneId: "pane-1",
        ...identity,
        rendererEpoch: 3,
        viewportCols: 10,
        viewportRows: 5,
        focused: nextFocused,
        diagnosticEpoch,
        full: false,
        writtenRows: [2],
      }) as const;

    emit("blur");
    expect(renderRequests).toBe(1);
    emit("frame");
    expect(fences).not.toHaveBeenCalled();
    expect(owner.complete(1, event(1, false))).toBe(true);
    expect(renderRequests).toBe(2);
    emit("frame");
    expect(fences).toHaveBeenCalledTimes(1);

    emit("focus");
    expect(owner.complete(2, event(2, true))).toBe(true);
    daemonGeneration = "generation-2";
    emit("frame");
    expect(fences).toHaveBeenCalledTimes(1);
    presentation.dispose();
    expect(listeners.get("focus")?.size ?? 0).toBe(0);
    expect(listeners.get("blur")?.size ?? 0).toBe(0);
  });
});
