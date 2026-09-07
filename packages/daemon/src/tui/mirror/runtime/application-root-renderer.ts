import { createCliRenderer } from "@opentui/core";

import { tuiPerfMark } from "./application-performance-log.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";

/** Renderer construction boundary kept outside the application composition root. */
export async function createApplicationRootRenderer(kittyKeys: boolean) {
  // tmux consumes OSC 66 instead of displaying its payload. Early echoed input
  // can make OpenTUI's cursor-position probe falsely detect explicit-width
  // support, erasing Unicode chrome. Use ordinary Unicode under this host;
  // preserve an explicit user override and direct-terminal capability detection.
  if (process.env.TMUX && process.env.OPENTUI_FORCE_EXPLICIT_WIDTH === undefined)
    process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";
  tuiPerfMark("renderer-create-start");
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    autoFocus: false,
    // Explicitly forward the JS-side default (and user overrides) to the
    // native renderer before terminal setup.
    forwardEnvKeys: ["OPENTUI_FORCE_EXPLICIT_WIDTH"],
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
