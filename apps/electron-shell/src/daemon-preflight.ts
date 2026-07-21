import type { DesktopDaemonPreflight } from "@tmux-ide/contracts";

export interface DaemonPreflight {
  probe(signal: AbortSignal): Promise<DesktopDaemonPreflight>;
}

/**
 * Card19b does not own or duplicate the unfinished canonical daemon launcher.
 * A later card injects the real probe at this seam.
 */
export const deferredDaemonPreflight: DaemonPreflight = {
  probe: async () => ({
    status: "deferred",
    reason: "Canonical headless daemon ownership is not part of the Electron shell foundation.",
  }),
};

export async function runDaemonPreflight(
  preflight: DaemonPreflight,
  timeoutMs = 1_500,
): Promise<DesktopDaemonPreflight> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DesktopDaemonPreflight>((resolve) => {
    timeout = setTimeout(() => {
      controller.abort();
      resolve({
        status: "unavailable",
        reason: `Daemon preflight timed out after ${timeoutMs}ms.`,
      });
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([
      preflight.probe(controller.signal).catch((error: unknown) => ({
        status: "unavailable" as const,
        reason: error instanceof Error ? error.message : "Daemon preflight failed.",
      })),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
