/**
 * Orphaned legacy daemon entrypoint.
 *
 * The per-session daemon spawn path is removed. This file is retained only
 * for stale external invocations and starts the canonical headless daemon in
 * this process. Prefer `tmux-ide --headless`.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { startEmbeddedDaemon, type EmbeddedDaemonHandle } from "./daemon-embed.ts";

async function main(): Promise<void> {
  // Accept the legacy `node daemon.ts <session> <port>` invocation: the
  // first positional may be a session name OR (when omitted) a port. We
  // sniff by digit-shape and forward both. Without this, an explicit
  // session name was silently dropped on the floor and the daemon booted
  // as `__embedded__` — leaving the workspace registry empty for live
  // tmux sessions the operator clearly meant to expose.
  const arg2 = process.argv[2];
  const arg3 = process.argv[3];
  const arg2IsPort = arg2 != null && /^\d+$/.test(arg2);
  const sessionName = arg2IsPort ? undefined : arg2;
  const rawPort = arg2IsPort ? arg2 : arg3;
  const port = rawPort === undefined || rawPort === "0" ? undefined : Number.parseInt(rawPort, 10);
  let handle: EmbeddedDaemonHandle;
  try {
    handle = await startEmbeddedDaemon({
      port,
      bindHostname: "127.0.0.1",
      ...(sessionName ? { sessionName } : {}),
    });
  } catch (err) {
    console.error("[daemon] failed to start:", err);
    process.exit(1);
  }

  let stopping = false;
  const exitAfterStop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    // Defer one tick so any awaiter of handle.stop() observes the resolved
    // promise before we tear the process down.
    process.nextTick(() => process.exit(code));
  };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    try {
      await handle.stop();
      exitAfterStop(0);
    } catch (err) {
      console.error("[daemon] failed to stop:", err);
      exitAfterStop(1);
    }
  };

  // Wrap handle.stop so non-signal stop paths terminate the process. Without
  // this, the canonical-daemon takeover action (POST /api/v2/action/daemon.shutdown
  // from a competing launcher), the tick() that calls stopSelf when the
  // tmux session disappears, and the remote-access restart backend all
  // close the HTTP listener but leave the Node event loop spinning on
  // task-store WAL timers and other handles. The visible symptom is a
  // ghost daemon: process alive, port 6060 dead, takeover falls back to
  // its 10s SIGTERM/SIGKILL deadline before the next launch can bind.
  const origStop = handle.stop.bind(handle);
  handle.stop = async (opts) => {
    try {
      await origStop(opts);
    } finally {
      exitAfterStop(0);
    }
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) void main();
