#!/usr/bin/env node

/**
 * Start the browser GUI against the canonical local daemon.
 *
 * Vite owns the reusable daemon credential and exposes only the reviewed
 * same-origin HTTP/WebSocket gateway. The bearer never appears in argv,
 * stdout, or browser JavaScript.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ensureCanonicalDaemon } from "../packages/daemon/src/lib/canonical-daemon-bootstrap.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function fail(message) {
  process.stderr.write(`tmux-ide web: ${message}\n`);
  process.exit(1);
}

let info;
try {
  ({ candidate: info } = await ensureCanonicalDaemon({
    entryPath: resolve(repoRoot, "bin/cli.js"),
    cwd: repoRoot,
  }));
} catch (error) {
  fail(
    `canonical daemon bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
if (!info.authToken) fail("canonical daemon did not publish an owner credential");
const port = process.env.TMUX_IDE_DEV_SERVER_PORT || "5173";
const child = spawn("pnpm", ["--filter", "@tmux-ide/desktop-renderer", "dev"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    TMUX_IDE_DEV_SERVER_PORT: port,
    VITE_TMUX_IDE_DEV_HOST: "1",
    VITE_TMUX_IDE_DEV_GATEWAY: "1",
    TMUX_IDE_DEV_DAEMON_URL: `http://127.0.0.1:${info.port}`,
    TMUX_IDE_DEV_OWNER_TOKEN: info.authToken,
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => fail(`could not start Vite: ${error.message}`));
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
