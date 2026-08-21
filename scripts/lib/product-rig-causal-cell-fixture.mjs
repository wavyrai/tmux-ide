#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";

import { createCausalFixtureGeometry } from "./product-rig-causal-fixture-geometry.mjs";

const OSC = "tmux-ide-causal-cell-v1";
const paneId = process.env.TMUX_PANE;
let buffer = "";
let restored = false;
let geometry;

const markReady = (value) => {
  if (!paneId) return;
  execFileSync("tmux", ["set-option", "-p", "-t", paneId, "@tmux_ide_causal_fixture", value], {
    stdio: "ignore",
  });
};

const restore = () => {
  if (restored) return;
  restored = true;
  geometry?.dispose();
  if (paneId) {
    try {
      execFileSync("tmux", ["set-option", "-pu", "-t", paneId, "@tmux_ide_causal_fixture"], {
        stdio: "ignore",
      });
    } catch {
      // The private ProductRig server may already be gone.
    }
  }
  try {
    // Restore the DEC mode changed for the fixed-cell fixture before the
    // interactive shell resumes. A tty reset alone does not restore DECAWM.
    writeSync(1, "\x1b[?7h\x1b[2J\x1b[3J\x1b[H");
  } catch {
    // The ephemeral pane may already be closed.
  }
  try {
    execFileSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
  } catch {
    // ProductRig owns the ephemeral pane; cleanup can still kill the session.
  }
};

const stop = () => {
  restore();
  process.exit(0);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", restore);
execFileSync("stty", ["raw", "-echo"], { stdio: ["inherit", "ignore", "ignore"] });
geometry = createCausalFixtureGeometry({
  readColumns: () => process.stdout.columns,
  write: (value, callback) => process.stdout.write(value, callback),
  markReady,
  subscribeResize: (listener) => {
    process.on("SIGWINCH", listener);
    return () => process.off("SIGWINCH", listener);
  },
});
geometry.start();

process.stdin.setEncoding("ascii");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("\x03")) return stop();
  buffer += chunk;
  for (;;) {
    const boundary = buffer.indexOf("\n");
    if (boundary < 0) break;
    const line = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 1);
    const reset = /^reset-v1;([A-Za-z0-9_-]{1,64})$/u.exec(line);
    if (reset) {
      geometry.reset(reset[1]);
      continue;
    }
    const separator = line.indexOf(";");
    const traceId = line.slice(0, separator);
    const encoded = line.slice(separator + 1);
    if (!/^[0-9a-f-]{36}$/u.test(traceId) || !/^[A-Za-z0-9+/=]+$/u.test(encoded)) continue;
    const text = Buffer.from(encoded, "base64").toString("ascii");
    if (!/^[\x20-\x7e]{1,64}$/u.test(text)) continue;
    process.stdout.write(
      `\x1b]6973;${OSC};start;${traceId}\x07${text}\x1b]6973;${OSC};end;${traceId}\x07`,
    );
  }
});
