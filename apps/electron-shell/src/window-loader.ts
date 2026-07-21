export interface HiddenLoadWindow {
  once(event: "ready-to-show", listener: () => void): unknown;
  removeListener(event: "ready-to-show", listener: () => void): unknown;
  isDestroyed(): boolean;
  show(): void;
  destroy(): void;
}

export interface HiddenWindowLoadOptions {
  load: () => Promise<void>;
  rendererReady?: Promise<void>;
  timeoutMs?: number;
  reveal?: boolean;
}

/** Loads a hidden window and only reveals it after Electron reports readiness. */
export async function loadHiddenWindow(
  window: HiddenLoadWindow,
  options: HiddenWindowLoadOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let readyListener: (() => void) | undefined;

  const ready = new Promise<void>((resolve) => {
    readyListener = resolve;
    window.once("ready-to-show", readyListener);
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Desktop renderer did not become ready within ${timeoutMs}ms.`)),
      timeoutMs,
    );
    timeout.unref?.();
  });

  try {
    await Promise.race([
      Promise.all([options.load(), ready, options.rendererReady ?? Promise.resolve()]),
      deadline,
    ]);
    if (options.reveal !== false && !window.isDestroyed()) window.show();
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (readyListener) window.removeListener("ready-to-show", readyListener);
  }
}
