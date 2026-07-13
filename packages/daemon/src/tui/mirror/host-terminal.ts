/**
 * Host-terminal modes owned by the unified app.
 *
 * OpenTUI renders each changed row as ANSI runs. With DECAWM (host autowrap)
 * enabled, a wide/right-edge run can physically wrap into column 1 of the next
 * row while OpenTUI's shadow records the intended cells. That strands pane text
 * over the left sidebar until an outer full repaint. The app never relies on
 * host autowrap—it positions runs absolutely—so disable it for the app's
 * lifetime and restore it exactly once on every exit path.
 */

export const HOST_AUTOWRAP_DISABLE = "\x1b[?7l";
export const HOST_AUTOWRAP_ENABLE = "\x1b[?7h";

export interface HostTerminalExitLifecycle {
  onExit(listener: () => void): void;
  offExit(listener: () => void): void;
}

export interface HostAutowrapGuard {
  restore(): void;
}

/**
 * Disable host autowrap immediately and arm an exit fallback. `restore` is
 * idempotent and removes the fallback before writing the enable sequence, so a
 * normal renderer teardown followed by process exit cannot double-write it.
 *
 * The caller supplies a synchronous writer: process `exit` listeners cannot
 * rely on queued/asynchronous stdout writes being flushed.
 */
export function installHostAutowrapGuard(
  write: (sequence: string) => void,
  lifecycle: HostTerminalExitLifecycle,
): HostAutowrapGuard {
  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    lifecycle.offExit(restore);
    write(HOST_AUTOWRAP_ENABLE);
  };

  write(HOST_AUTOWRAP_DISABLE);
  lifecycle.onExit(restore);

  return { restore };
}
