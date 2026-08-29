import { execFileSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

import {
  installTuiHostSignalShutdown,
  type TuiApplicationLifecycle,
} from "./application-lifecycle.ts";

export interface HostedTtySize {
  readonly width: number;
  readonly height: number;
}

export interface HostedTtySizeRenderer {
  readonly width: number;
  readonly height: number;
  resize(width: number, height: number): void;
  requestRender(): void;
  on(event: "resize", listener: (width: number, height: number) => void): unknown;
  off(event: "resize", listener: (width: number, height: number) => void): unknown;
  emit(event: "resize", width: number, height: number): boolean;
}

export interface HostedTtySizeSignalTarget {
  on(signal: "SIGWINCH", listener: () => void): unknown;
  off(signal: "SIGWINCH", listener: () => void): unknown;
}

export interface HostedTtySizeBridge {
  reconcile(): boolean;
  dispose(): void;
}

/** Register all process/TTY owners that exist only for the retained host. */
export function installHostedRuntimeOwnership(options: {
  lifecycle: TuiApplicationLifecycle;
  hosted: boolean;
  renderer: HostedTtySizeRenderer;
}): void {
  const hostSignals = installTuiHostSignalShutdown(options.lifecycle, {
    hosted: options.hosted,
  });
  options.lifecycle.registerCloser("host-death-signals", hostSignals.dispose);
  const sizeBridge = installHostedSizeBridge(options);
  options.lifecycle.registerCloser("hosted-tty-size-bridge", sizeBridge.dispose);
}

type HostedTtySizeTimer = ReturnType<typeof setTimeout> | number;

/**
 * OpenTUI debounces its own SIGWINCH read by 100ms. Bun can retain stale
 * `process.stdout.columns/rows`, so let that no-op settle before applying the
 * authoritative controlling-TTY geometry. One timer is coalesced per signal
 * burst; there is no polling or idle work.
 */
export const HOSTED_TTY_SIZE_SETTLE_MS = 125;

export function parseSttySize(value: string): HostedTtySize | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(value);
  if (!match) return null;
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    return null;
  return Object.freeze({ width, height });
}

/** Read the kernel winsize for the renderer's controlling TTY without a shell. */
export function readControllingTtySize(): HostedTtySize | null {
  let fd: number | null = null;
  try {
    fd = openSync("/dev/tty", "r");
    const output = execFileSync("stty", ["size"], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 128,
      stdio: [fd, "pipe", "ignore"],
    });
    return parseSttySize(output);
  } catch {
    return null;
  } finally {
    if (fd !== null)
      try {
        closeSync(fd);
      } catch {
        // A failed close cannot invalidate a winsize already applied.
      }
  }
}

/**
 * Hosted-only bridge from authoritative TTY winsize to OpenTUI's public resize
 * path. The daemon and semantic terminal contracts never participate.
 */
export function installHostedSizeBridge(
  options: Readonly<{
    hosted: boolean;
    renderer: HostedTtySizeRenderer;
    readSize?: () => HostedTtySize | null;
    signalTarget?: HostedTtySizeSignalTarget;
    settleMs?: number;
    setTimer?: (callback: () => void, delayMs: number) => HostedTtySizeTimer;
    clearTimer?: (timer: HostedTtySizeTimer) => void;
    queueRender?: (callback: () => void) => HostedTtySizeTimer;
    cancelQueuedRender?: (timer: HostedTtySizeTimer) => void;
  }>,
): HostedTtySizeBridge {
  const readSize = options.readSize ?? readControllingTtySize;
  const signalTarget = options.signalTarget ?? process;
  const settleMs = Math.max(0, options.settleMs ?? HOSTED_TTY_SIZE_SETTLE_MS);
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((value: HostedTtySizeTimer) => clearTimeout(value));
  // Solid applies custom-renderer prop effects after the current reactive
  // flush. A zero-delay task gives those effects ownership before the single
  // renderer frame; it is event-driven and never repeats while idle.
  const queueRender = options.queueRender ?? ((callback: () => void) => setTimeout(callback, 0));
  const cancelQueuedRender =
    options.cancelQueuedRender ?? ((value: HostedTtySizeTimer) => clearTimeout(value));
  let timer: HostedTtySizeTimer | null = null;
  let renderTimer: HostedTtySizeTimer | null = null;
  // Seed the last authoritative comparison from the renderer's creation
  // geometry. This keeps installation inert when the kernel and renderer
  // already agree, while a later SIGWINCH can still detect a kernel change
  // even if Bun has eagerly mutated the renderer's public dimensions.
  let observedSize: HostedTtySize = {
    width: options.renderer.width,
    height: options.renderer.height,
  };
  let publishedSize = observedSize;
  let disposed = false;
  const observeResize = (width: number, height: number): void => {
    publishedSize = { width, height };
  };

  const reconcile = (): boolean => {
    if (disposed || !options.hosted) return false;
    let size: HostedTtySize | null;
    try {
      size = readSize();
    } catch {
      return false;
    }
    if (!size) return false;
    const changed = observedSize.width !== size.width || observedSize.height !== size.height;
    observedSize = size;
    // Bun can mutate OpenTUI's public width/height while leaving its native
    // buffers, root and resize event at the prior geometry. A changed kernel
    // winsize must therefore traverse renderer.resize even when those public
    // properties already equal the new dimensions.
    if (
      !changed &&
      options.renderer.width === size.width &&
      options.renderer.height === size.height
    )
      return false;
    try {
      options.renderer.resize(size.width, size.height);
      // OpenTUI can already hold the correct private geometry when this
      // authoritative read settles, making resize() a no-op. Publish that one
      // missing edge for its canonical useTerminalDimensions owner.
      const repairPublication =
        publishedSize.width !== size.width || publishedSize.height !== size.height;
      if (repairPublication) options.renderer.emit("resize", size.width, size.height);
      if (repairPublication && renderTimer === null) {
        renderTimer = queueRender(() => {
          renderTimer = null;
          if (!disposed) options.renderer.requestRender();
        });
      }
      return true;
    } catch {
      return false;
    }
  };
  const onSigwinch = (): void => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      reconcile();
    }, settleMs);
  };

  if (options.hosted) {
    options.renderer.on("resize", observeResize);
    signalTarget.on("SIGWINCH", onSigwinch);
    // Reconcile a viewer that attached between renderer creation and bridge
    // ownership. No competing OpenTUI SIGWINCH callback exists for this read.
    reconcile();
  }

  return Object.freeze({
    reconcile,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (renderTimer !== null) {
        cancelQueuedRender(renderTimer);
        renderTimer = null;
      }
      if (options.hosted) {
        options.renderer.off("resize", observeResize);
        signalTarget.off("SIGWINCH", onSigwinch);
      }
    },
  });
}
