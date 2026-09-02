import { createCliRenderer } from "@opentui/core";

import { tuiPerfMark } from "./application-performance-log.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";

/** Renderer construction boundary kept outside the application composition root. */
export async function createApplicationRootRenderer(kittyKeys: boolean) {
  tuiPerfMark("renderer-create-start");
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    autoFocus: false,
    ...TUI_RENDERER_CADENCE,
    useKittyKeyboard: kittyKeys ? {} : null,
    consoleMode: process.env.TMUX_IDE_MIRROR_DEBUG ? "console-overlay" : "disabled",
    openConsoleOnError: Boolean(process.env.TMUX_IDE_MIRROR_DEBUG),
  });
  tuiPerfMark("renderer-create-end");
  return renderer;
}

export type ApplicationRootRenderer = Awaited<ReturnType<typeof createApplicationRootRenderer>>;

/** One-shot public readiness deferred for the bootstrap lifecycle. */
export function createApplicationRootReadiness() {
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  return { ready, resolveReady, rejectReady } as const;
}
