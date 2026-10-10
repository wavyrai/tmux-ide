// Run with node --import tsx; guarded runner + real native prototype, no product daemon.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { createGuardedNativeSplitResize } from "../../../packages/daemon/src/lib/guarded-native-split-resize.ts";

const binary = resolve(process.argv[2]);
const root = mkdtempSync("/tmp/tmux-split-guarded-");
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
  const capability = JSON.parse(run(["tmux-ide-events", "-e"]));
  const observer = {
    nativeServerEpoch: capability.serverEpoch,
    ownedOperationTransport: capability.ownedOperationTransport === "direct-wrapper-v1",
    ownedOperationEpochGuard: capability.ownedOperationEpochGuard === "server-epoch-v1",
    ownedOperationPaneGuard: capability.ownedOperationPaneGuard === "direct-pane-v1",
    ownedOperationSessionGuard: capability.ownedOperationSessionGuard === "direct-session-v1",
  };
  let authorized = true;
  const authority = () => ({
    operationId: randomUUID(),
    serverEpoch: capability.serverEpoch,
    session: {
      id: sessionId,
      name: "proof",
      created: run(["display-message", "-p", "-t", "proof:", "#{session_created}"]),
    },
    anchor: {
      paneId: left,
      paneBirthId: run(["display-message", "-p", "-t", left, "#{pane_birth_id}"]),
    },
    authorizeBeforeEffect: () => {
      assert.equal(authorized, true, "Geometry authority retired");
    },
  });
  const calls = [];
  const resize = createGuardedNativeSplitResize({
    observation: () => observer,
    runPinnedTmux: (args) => {
      calls.push(args);
      return run(args);
    },
  });
  const request = { sessionId, windowId, expectedLayout, path: [0], axis: "cols", boundary: 83 };
  const moved = await resize(request, authority());
  assert.equal(moved.status, "applied");
  assert.equal(moved.boundary, 83);
  assert.equal(moved.layout, layout());
  assert.equal(identities(), beforeIds);
  assert.equal(calls.length, 2);
  assert.ok(
    calls.every(
      (args) => args.includes("tmux-ide-run") && args.includes("-B") && args.includes("-C"),
    ),
  );
  assert.equal(moved.changed, true);
  evidence.cases.push({ kind: "ancestor-moved", boundary: moved.boundary });
  const stale = await resize(request, authority());
  assert.deepEqual(stale, { status: "uncertain", reason: "command-failed" });
  assert.equal(layout(), moved.layout);
  evidence.cases.push({ kind: "stale-native-refusal", result: stale });
  const clamped = await resize({ ...request, expectedLayout: layout(), boundary: 0 }, authority());
  assert.equal(clamped.status, "applied");
  assert.ok(clamped.boundary > 0 && clamped.boundary < 83);
  assert.equal(clamped.layout, layout());
  assert.equal(identities(), beforeIds);
  const repeated = await resize({ ...request, expectedLayout: layout(), boundary: 0 }, authority());
  assert.equal(repeated.status, "applied");
  assert.equal(repeated.changed, false);
  assert.equal(repeated.boundary, clamped.boundary);
  evidence.cases.push({ kind: "clamp-and-repeat", boundary: clamped.boundary });
  const prior = calls.length;
  const pending = resize({ ...request, expectedLayout: layout(), boundary: 83 }, authority());
  authorized = false;
  assert.deepEqual(await pending, { status: "refused", reason: "authority-retired" });
  assert.equal(calls.length, prior + 1, "Only capability probe may dispatch");
  assert.equal(layout(), clamped.layout);
  assert.equal(identities(), beforeIds);
  evidence.cases.push({ kind: "revoked-after-capability", mutationDispatches: 0 });
} finally {
  try {
    run(["kill-server"]);
    evidence.cleanup = true;
  } finally {
    rmSync(root, { recursive: true, force: true });
    console.log(JSON.stringify(evidence, null, 2));
  }
}
