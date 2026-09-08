import { CliRenderEvents, createCliRenderer } from "@opentui/core";

import { tuiPerfMark, tuiPerfStream } from "./application-performance-log.ts";
import { createRendererOutputTransport } from "./renderer-output-transport.ts";
import { TUI_RENDERER_CADENCE } from "./renderer-cadence.ts";

/** Renderer construction boundary kept outside the application composition root. */
export async function createApplicationRootRenderer(
  kittyKeys: boolean,
  onOutputError?: (error: Error) => Promise<unknown> | undefined,
) {
  // tmux consumes OSC 66 instead of displaying its payload. Early echoed input
  // can make OpenTUI's cursor-position probe falsely detect explicit-width
  // support, erasing Unicode chrome. Use ordinary Unicode under this host;
  // preserve an explicit user override and direct-terminal capability detection.
  if (process.env.TMUX && process.env.OPENTUI_FORCE_EXPLICIT_WIDTH === undefined)
    process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";
  tuiPerfMark("renderer-create-start");
  const transport =
    process.env.TMUX_IDE_FRAME_OUTPUT === "1" ? createRendererOutputTransport() : null;
  let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
  let outputError: Error | undefined;
  const failOutput = (error: Error) => {
    if (outputError) return;
    outputError = error;
    if (renderer) {
      process.stderr.write("tmux-ide: terminal output failed; closing the TUI.\n");
      if (!onOutputError?.(error)) renderer.destroy();
    }
  };
  transport?.stdout.on("error", failOutput);
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resize = () => {};
  let removeCapabilityObserver: (() => void) | undefined;
  const preserveCaptureDump = ["true", "1", "on", "yes"].includes(
    (process.env.OTUI_DUMP_CAPTURES ?? "").toLowerCase(),
  );
  const disposeOutput = () => {
    removeCapabilityObserver?.();
    removeCapabilityObserver = undefined;
    clearTimeout(resizeTimer);
    transport?.stdout.off("resize", resize);
    transport?.stdout.off("error", failOutput);
    transport?.dispose();
  };
  try {
    renderer = await createCliRenderer({
      ...(transport ? { stdout: transport.stdout, remote: false } : {}),
      onDestroy: () => {
        disposeOutput();
        // Release captured Error arguments after the UI closes, unless the
        // user explicitly requested OpenTUI's post-exit diagnostic dump.
        if (!preserveCaptureDump) renderer?.console?.clear();
      },
      exitOnCtrlC: false,
      autoFocus: false,
      // Explicitly forward the JS-side default (and user overrides) to the
      // native renderer before terminal setup.
      forwardEnvKeys: ["OPENTUI_FORCE_EXPLICIT_WIDTH"],
      ...TUI_RENDERER_CADENCE,
      useKittyKeyboard: kittyKeys ? {} : null,
      // Uncaught/render errors must go through OpenTUI's framed overlay.
      // Disabling capture lets Bun print source excerpts over the live TUI.
      consoleMode: "console-overlay",
      openConsoleOnError: true,
      consoleOptions: {
        title: "tmux-ide diagnostics",
        maxStoredLogs: 100,
        maxDisplayLines: 500,
      },
    });
    if (outputError) {
      renderer.destroy();
      throw outputError;
    }
  } catch (error) {
    disposeOutput();
    throw error;
  }
  const activeRenderer = renderer;
  if (tuiPerfStream) {
    let previous: string | undefined;
    const boundedLabel = (value: string | undefined) =>
      value === undefined ? null : value.slice(0, 128).replace(/[^\x20-\x7e]/gu, "");
    const observeCapabilities = () => {
      // Detected protocol support is host evidence, not proof of presentation.
      // This opt-in observer never reads terminal contents or environment labels.
      try {
        const capabilities = activeRenderer.capabilities;
        const details = {
          capabilitiesAvailable: capabilities !== null,
          sync: capabilities?.sync ?? null,
          explicit_width: capabilities?.explicit_width ?? null,
          sgr_pixels: capabilities?.sgr_pixels ?? null,
          multiplexer: boundedLabel(capabilities?.multiplexer),
          terminalName: boundedLabel(capabilities?.terminal?.name),
          terminalVersion: boundedLabel(capabilities?.terminal?.version),
          cols: activeRenderer.width,
          rows: activeRenderer.height,
          targetFps: activeRenderer.targetFps,
          maxFps:
            activeRenderer.maxFps === Number.POSITIVE_INFINITY
              ? "unlimited"
              : activeRenderer.maxFps,
        };
        const key = JSON.stringify(details);
        if (key === previous) return;
        previous = key;
        tuiPerfMark("renderer-host-capabilities", details);
      } catch {
        // Diagnostics cannot interrupt renderer startup or capability detection.
      }
    };
    const observeFrame = ({ frameId }: { frameId: number }) => {
      try {
        tuiPerfMark("renderer-frame-scheduler", {
          frameId,
          ...activeRenderer.getSchedulerState(),
          liveRequestCount: activeRenderer.liveRequestCount,
        });
      } catch {
        // Opt-in scheduling evidence must never interrupt presentation.
      }
    };
    activeRenderer.on(CliRenderEvents.CAPABILITIES, observeCapabilities);
    activeRenderer.on(CliRenderEvents.FRAME, observeFrame);
    removeCapabilityObserver = () => {
      activeRenderer.off(CliRenderEvents.CAPABILITIES, observeCapabilities);
      activeRenderer.off(CliRenderEvents.FRAME, observeFrame);
    };
    observeCapabilities();
  }
  if (transport) {
    resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const { columns, rows } = transport.stdout;
        if (columns > 0 && rows > 0) activeRenderer.resize(columns, rows);
      }, 100);
    };
    transport.stdout.on("resize", resize);
  }
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
