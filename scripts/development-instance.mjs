#!/usr/bin/env node
/** Small warm launcher; compiler lives in a short-lived child on cache misses only. */
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureManager } from "./lib/development-manager-cache.mjs";
let pin;
try {
  pin = await ensureManager(dirname(dirname(fileURLToPath(import.meta.url))));
} catch (error) {
  if (process.argv.includes("--json"))
    process.stdout.write(
      `${JSON.stringify({ code: "DEVELOPMENT_MANAGER_UNAVAILABLE", reason: "compilation-or-cache-unavailable", next: "Check worktree source, private manager cache and pnpm install --frozen-lockfile" })}\n`,
    );
  else process.stderr.write(`Development manager unavailable: ${error.message}\n`);
  process.exitCode = [130, 143].includes(error.exitCode) ? error.exitCode : 1;
}
if (pin) {
  process.once("exit", pin.release);
  try {
    await import(pathToFileURL(pin.path).href);
  } finally {
    process.off("exit", pin.release);
    pin.release();
  }
}
