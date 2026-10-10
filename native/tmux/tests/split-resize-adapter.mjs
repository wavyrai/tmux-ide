// Run with node --import tsx; adapter + real native prototype, no product daemon.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { resizeNativeSplit } from "../../../packages/daemon/src/terminal/protocol/native-split-resize.ts";

const binary = resolve(process.argv[2]);
const root = mkdtempSync("/tmp/tmux-split-adapter-");
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("TMUX")),
);
Object.assign(env, { HOME: root, XDG_CONFIG_HOME: root, TERM: "xterm-256color" });
const run = (args) =>
  execFileSync(binary, ["-S", `${root}/t.sock`, "-f", "/dev/null", ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 128 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const evidence = {
  binary,
  sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  cases: [],
  cleanup: false,
};
try {
  run(["new-session", "-d", "-s", "proof", "-x", "160", "-y", "80", "sleep 120"]);
  const windowId = run(["display-message", "-p", "-t", "proof", "#{window_id}"]);
  const sessionId = run(["display-message", "-p", "-t", "proof", "#{session_id}"]);
  run(["set-option", "-w", "-t", windowId, "pane-border-status", "off"]);
  const left = run(["list-panes", "-t", windowId, "-F", "#{pane_id}"]);
  const split = (pane, direction) =>
    run(["split-window", "-d", direction, "-t", pane, "-P", "-F", "#{pane_id}", "sleep 120"]);
  const right = split(left, "-h");
  for (const top of [left, right]) {
    const bottom = split(top, "-v");
    split(top, "-h");
    split(bottom, "-h");
  }
  const layout = () => run(["display-message", "-p", "-t", windowId, "#{window_layout}"]);
  const identities = () =>
    run(["list-panes", "-t", windowId, "-F", "#{pane_id}:#{pane_birth_id}:#{pane_pid}"]);
  const expectedLayout = layout(),
    beforeIds = identities();
  const calls = [];
  const runner = async (args) => {
    calls.push(args[0]);
    return run(args);
  };
  const request = { sessionId, windowId, expectedLayout, path: [0], axis: "cols", boundary: 83 };
  const moved = await resizeNativeSplit(request, runner);
  assert.equal(moved.status, "applied");
  assert.equal(moved.boundary, 83);
  assert.equal(moved.layout, layout());
  assert.equal(identities(), beforeIds);
  assert.deepEqual(calls, ["tmux-ide-resize-split", "tmux-ide-resize-split"]);
  assert.equal(moved.changed, true);
  evidence.cases.push({ kind: "ancestor-moved", boundary: moved.boundary });
  const stale = await resizeNativeSplit(request, runner);
  assert.deepEqual(stale, { status: "uncertain", reason: "command-failed" });
  assert.equal(layout(), moved.layout);
  evidence.cases.push({ kind: "stale-native-refusal", result: stale });
  const clamped = await resizeNativeSplit(
    { ...request, expectedLayout: layout(), boundary: 0 },
    runner,
  );
  assert.equal(clamped.status, "applied");
  assert.ok(clamped.boundary > 0 && clamped.boundary < 83);
  assert.equal(clamped.layout, layout());
  assert.equal(identities(), beforeIds);
  const repeated = await resizeNativeSplit(
    { ...request, expectedLayout: layout(), boundary: 0 },
    runner,
  );
  assert.equal(repeated.status, "applied");
  assert.equal(repeated.changed, false);
  assert.equal(repeated.boundary, clamped.boundary);
  evidence.cases.push({ kind: "clamp-and-repeat", boundary: clamped.boundary });
} finally {
  try {
    run(["kill-server"]);
    evidence.cleanup = true;
  } finally {
    rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify(evidence, null, 2));
  }
}
