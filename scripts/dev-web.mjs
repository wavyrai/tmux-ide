#!/usr/bin/env node

/**
 * Start the browser GUI against the canonical local daemon.
 *
 * Vite owns the reusable daemon credential and exposes only the reviewed
 * same-origin HTTP/WebSocket gateway. The bearer never appears in argv,
 * stdout, or browser JavaScript.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const daemonInfoPath = join(
  process.env.TMUX_IDE_DAEMON_INFO_DIR ||
    process.env.TMUX_IDE_REGISTRY_DIR ||
    join(homedir(), ".tmux-ide"),
  "daemon.json",
);

function fail(message) {
  process.stderr.write(`tmux-ide web: ${message}\n`);
  process.exit(1);
}

function readDaemonInfo() {
  let stat;
  let raw;
  try {
    stat = statSync(daemonInfoPath);
    raw = readFileSync(daemonInfoPath, "utf8");
  } catch {
    fail(
      `canonical daemon record not found at ${daemonInfoPath}; ` +
        'run "node bin/cli.js --headless" first',
    );
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    fail(`refusing unsafe daemon record at ${daemonInfoPath}; expected an owner-only regular file`);
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    fail(`canonical daemon record at ${daemonInfoPath} is not valid JSON`);
  }
  if (!Number.isInteger(info?.pid) || !Number.isInteger(info?.port)) {
    fail(`canonical daemon record at ${daemonInfoPath} is incomplete`);
  }
  if (typeof info.authToken !== "string" || info.authToken.length === 0) {
    fail('canonical daemon has no owner credential; restart it with "node bin/cli.js --headless"');
  }
  try {
    process.kill(info.pid, 0);
  } catch {
    fail(
      `canonical daemon pid ${info.pid} is not alive; ` +
        'restart it with "node bin/cli.js --headless"',
    );
  }
  return info;
}

const info = readDaemonInfo();
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
