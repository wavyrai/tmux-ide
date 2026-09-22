#!/usr/bin/env node
/** Native Pilotty driver with a worktree-local socket namespace. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseTestdriveInputDocument,
  translateTestdriveInput,
  fullTerminalCapabilities,
} from "./lib/tui-testdrive-input.mjs";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const source = join(root, "context/pilotty");
const binary = join(source, "target/release/pilotty");
const sockets = join(root, ".tasks/pilotty-dev");
const args = process.argv.slice(2);
const env = { ...process.env, PILOTTY_SOCKET_DIR: sockets, PILOTTY_SESSION: "default" };
delete env.TMUX;
delete env.TMUX_PANE;

function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  return process.exitCode === 0;
}

if (args[0] === "build") {
  if (!existsSync(source)) {
    throw new Error("Clone https://github.com/msmps/pilotty into context/pilotty first.");
  }
  run("cargo", ["build", "--release", "--locked", "--manifest-path", join(source, "Cargo.toml")]);
} else {
  if (!existsSync(binary)) throw new Error("Run pnpm dev:pilotty build first.");
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  if (args[0] === "app") {
    if (args.length !== 1) throw new Error("Usage: pnpm dev:pilotty app");
    // The existing manager owns build validation, tmux isolation and app admission.
    // Rebuild explicitly first; never fall back to the user's installed daemon.
    const manager = join(root, "scripts/development-instance.mjs");
    if (run(process.execPath, [manager, "up", "--name", "pilotty", "--json"])) {
      run(binary, [
        "spawn",
        "--name",
        "ide",
        "--cwd",
        root,
        process.execPath,
        manager,
        "app",
        "--name",
        "pilotty",
      ]);
    }
  } else if (args[0] === "input") {
    if (args.length !== 4 || args[1] !== "-s" || !/^[a-zA-Z0-9_-]+$/.test(args[2]))
      throw new Error("Usage: pnpm dev:pilotty input -s <session> '<JSON mouse command>'");
    const command = parseTestdriveInputDocument(args[3]);
    if (command.kind !== "application-mouse")
      throw new Error("Pilotty input supports application-mouse gestures only.");
    const capture = spawnSync(binary, ["snapshot", "-s", args[2], "--format", "full", "--strict"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    if (capture.error) throw capture.error;
    if (capture.status !== 0) throw new Error("Cannot inspect a running Pilotty session.");
    const snapshot = JSON.parse(capture.stdout);
    const translated = translateTestdriveInput(command, {
      capabilities: fullTerminalCapabilities(),
      geometry: snapshot.size,
    });
    for (const phase of translated.phases) {
      // Pilotty type interprets escapes: serialize every byte to prevent it
      // from reinterpreting any literal backslashes in the input protocol.
      const text = [...Buffer.from(phase.bytes)]
        .map((byte) => `\\x${byte.toString(16).padStart(2, "0")}`)
        .join("");
      if (!run(binary, ["type", "-s", args[2], text])) break;
      if (phase.delayMs) await delay(phase.delayMs);
    }
  } else {
    run(binary, args.length ? args : ["--help"]);
  }
}
