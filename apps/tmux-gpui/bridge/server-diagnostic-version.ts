import { readTmuxServerDiagnostics } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { verifiedHostCurrent } from "./diagnostic-versions.ts";
import type { PreviewHost } from "./config.ts";

/** Optional scope metadata only: never awaited by terminal admission or discovery. */
export function createServerDiagnosticVersion(host: PreviewHost, read = readTmuxServerDiagnostics) {
  const controller = new AbortController();
  let started = false;
  let value: string | null = null;
  let notify: (() => void) | undefined;
  const current = () => !controller.signal.aborted && verifiedHostCurrent(host);
  return {
    get(onChanged: () => void): string | null {
      if (!current()) return null;
      notify = onChanged;
      if (!started) {
        started = true;
        void read(
          { ...host, hostClientId: "gpui-diagnostics", origin: "tmux-ide://app", timeoutMs: 2500 },
          host.scope,
          controller.signal,
        )
          .then((result) => {
            if (!current()) return;
            value = result?.tmuxVersion ?? null;
            notify?.();
          })
          .catch(() => {
            /* Optional metadata never changes terminal state or normal UI. */
          });
      }
      return value;
    },
    dispose() {
      controller.abort();
      notify = undefined;
      value = null;
    },
  };
}
