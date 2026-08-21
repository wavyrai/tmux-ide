import { createMemo, type Accessor } from "solid-js";

import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import { terminalGestureRuntimeIdentity } from "./application-terminal-selection-owner.ts";

export function createApplicationTerminalRendererSources(
  generation: Accessor<OpenTuiGenerationHostSnapshot | null>,
) {
  const terminalRendererSource = createMemo(() => {
    const active = generation();
    return active?.adapter && (active.status === "live" || active.status === "rebinding")
      ? Object.freeze({ adapter: active.adapter, rendererEpoch: active.rendererEpoch })
      : null;
  });
  const terminalGestureRuntime = createMemo(() => terminalGestureRuntimeIdentity(generation()));
  const focusRendererSource = createMemo(() => {
    const active = generation();
    if (!active?.adapter || active.status !== "live" || !active.daemonGeneration) return null;
    try {
      const clientGeneration = active.client?.getSnapshot().generation;
      if (!Number.isSafeInteger(clientGeneration)) return null;
      return Object.freeze({
        adapter: active.adapter,
        rendererEpoch: active.rendererEpoch,
        daemonGeneration: active.daemonGeneration,
        clientGeneration: clientGeneration!,
      });
    } catch {
      return null;
    }
  });
  return Object.freeze({ terminalRendererSource, terminalGestureRuntime, focusRendererSource });
}
