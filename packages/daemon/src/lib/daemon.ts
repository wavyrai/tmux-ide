/**
 * Orphaned legacy daemon entrypoint.
 *
 * The per-session daemon spawn path is removed. This file is retained only
 * for stale external invocations and starts the canonical headless daemon in
 * this process. Prefer `tmux-ide --headless`.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { runHeadlessDaemon } from "./headless-daemon.ts";

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
  try {
    await runHeadlessDaemon({ port, sessionName });
    process.exit(0);
  } catch (err) {
    console.error("[daemon] failed to start:", err);
    process.exit(1);
  }
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) void main();
