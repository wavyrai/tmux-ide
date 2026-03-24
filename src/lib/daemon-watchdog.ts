/**
 * Minimal crash-recovery watchdog for the tmux-ide daemon.
 * Respawns daemon.ts on unexpected exits with exponential backoff.
 * Gives up after 5 crashes within 60 seconds.
 *
 * Entry: bun src/lib/daemon-watchdog.ts <session> [port]
 *
 * ZERO imports from business logic — this file must never crash
 * due to broken application code.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sessionArg = process.argv[2];
const port = process.argv[3] ?? "0";

if (!sessionArg) {
  console.error("Usage: daemon-watchdog.ts <session> [port]");
  process.exit(1);
}

const session: string = sessionArg;

const daemonScript = resolve(__dirname, "daemon.ts");

let backoffMs = 1000;
let crashCount = 0;
let lastCrashTime = 0;
let child: ChildProcess | null = null;

function logError(msg: string): void {
  try {
    const tasksDir = resolve(process.cwd(), ".tasks");
    if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "error",
      source: "daemon-watchdog",
      message: msg,
    });
    appendFileSync(resolve(tasksDir, "events.log"), entry + "\n");
  } catch {
    // If even logging fails, silently continue
  }
}

function spawnDaemon(): void {
  child = spawn("bun", [daemonScript, session, port], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe child stdout/stderr to our own so logs are visible in the detached process
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  child.on("exit", (code) => {
    child = null;

    // Clean shutdown (code 0) — don't respawn
    if (code === 0) {
      process.exit(0);
    }

    const now = Date.now();

    // Reset crash counter if the last crash was more than 60s ago
    if (now - lastCrashTime > 60_000) {
      crashCount = 0;
      backoffMs = 1000;
    }

    crashCount++;
    lastCrashTime = now;

    if (crashCount > 5) {
      logError(`Daemon crashed ${crashCount} times in 60s — giving up`);
      process.exit(1);
    }

    logError(`Daemon exited with code ${code}, respawning in ${backoffMs}ms`);
    setTimeout(spawnDaemon, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30_000);
  });
}

// Forward termination signals to the child daemon
process.on("SIGTERM", () => {
  if (child) child.kill("SIGTERM");
  else process.exit(0);
});

process.on("SIGINT", () => {
  if (child) child.kill("SIGTERM");
  else process.exit(0);
});

spawnDaemon();
