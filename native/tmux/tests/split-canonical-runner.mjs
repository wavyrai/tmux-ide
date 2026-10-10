// Real retained control channel -> opaque split handle -> guarded native command.
// Run with node --import tsx and a split-patched tmux binary argument.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { MirrorService } from "../../../packages/daemon/src/terminal/mirror/mirror-service.ts";
import { MirrorControlChannel } from "../../../packages/daemon/src/terminal/mirror/control-channel.ts";
import { createGuardedNativeSplitResize } from "../../../packages/daemon/src/lib/guarded-native-split-resize.ts";
const binary = resolve(process.argv[2]);
const root = mkdtempSync("/tmp/tmi-canonical-split-");
const socketPath = root + "/s";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TMUX")));
Object.assign(env, { HOME: root, XDG_CONFIG_HOME: root, TERM: "xterm-256color" });
const run = (args) =>
  execFileSync(binary, ["-S", socketPath, "-f", "/dev/null", ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 128 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
for (const key of Object.keys(process.env)) if (key.startsWith("TMUX")) delete process.env[key];
Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: root });
const evidence = {
  sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  cases: [],
  cleanup: false,
};
let mirror, subscription;
const failures = [];
try {
  run(["new-session", "-d", "-s", "proof", "-x", "160", "-y", "80", "sleep 120"]);
  run(["set-option", "-w", "-t", "proof", "pane-border-status", "off"]);
  run(["split-window", "-h", "-d", "-t", "proof", "sleep 120"]);
  const capability = JSON.parse(run(["tmux-ide-events", "-e"]));
  const observer = {
    nativeServerEpoch: capability.serverEpoch,
    ownedOperationTransport: capability.ownedOperationTransport === "direct-wrapper-v1",
    ownedOperationEpochGuard: capability.ownedOperationEpochGuard === "server-epoch-v1",
    ownedOperationPaneGuard: capability.ownedOperationPaneGuard === "direct-pane-v1",
    ownedOperationSessionGuard: capability.ownedOperationSessionGuard === "direct-session-v1",
  };
  mirror = new MirrorService({
    socketPath,
    executable: binary,
    splitLayoutEpoch: () => capability.serverEpoch,
    createIo: (session, handlers) =>
      new MirrorControlChannel({
        session,
        handlers,
        socketPath,
        executable: binary,
        configFile: "/dev/null",
      }),
  });
  const identity = await mirror.describeSessionAuthority("proof");
  let latest;
  subscription = await mirror.subscribeLayout("proof", () => {}, {
    expectedRuntimeSessionId: run(["display-message", "-p", "-t", "proof", "#{session_id}"]),
    expectedSemanticPaneIds: identity.description.panes.map((p) => p.semanticPaneId),
    onAuthority: (s) => {
      latest = s;
    },
  });
  const link = latest.windowLinks.links[0];
  const window = {
    liveSessionId: latest.windowLinks.liveSessionId,
    linkId: link.linkId,
    linkRevision: latest.windowLinks.linkRevision,
    expectedSemanticWindowId: link.semanticWindowId,
  };
  const read = () => mirror.readWindowSplitLayout("proof", window);
  const resource = await read();
  assert.equal(resource.splits.length, 1);
  const target = {
    window,
    layoutId: resource.layoutId,
    splitId: resource.splits[0].splitId,
    boundary: 83,
  };
  const layout = () => run(["display-message", "-p", "-t", "proof", "#{window_layout}"]);
  const identities = () =>
    run(["list-panes", "-t", "proof", "-F", "#{pane_id}:#{pane_birth_id}:#{pane_pid}"]);
  const beforeIds = identities();
  let calls = 0;
  const native = createGuardedNativeSplitResize({
    observation: () => observer,
    runPinnedTmux: (args) => {
      calls++;
      return run(args);
    },
  });
  const result = await mirror.resizeWindowSplit("proof", target, randomUUID(), () => {}, native);
  assert.equal(result.status, "applied");
  assert.equal(result.boundary, 83);
  assert.equal(result.layout, layout());
  assert.equal(identities(), beforeIds);
  evidence.cases.push({ kind: "canonical-handle-native-effect", boundary: result.boundary, calls });
  // Wait for the canonical control notification rather than minting from native command output.
  let changed;
  for (let i = 0; i < 100; i++) {
    changed = await read();
    if (changed.layoutId !== resource.layoutId) break;
    await delay(10);
  }
  assert.notEqual(changed.layoutId, resource.layoutId);
  assert.equal(changed.splits[0].boundary, 83);
  const staleCalls = calls;
  await assert.rejects(mirror.resizeWindowSplit("proof", target, randomUUID(), () => {}, native));
  assert.equal(calls, staleCalls);
  const current = {
    window,
    layoutId: changed.layoutId,
    splitId: changed.splits[0].splitId,
    boundary: 70,
  };
  let allowed = true;
  const pending = mirror.resizeWindowSplit(
    "proof",
    current,
    randomUUID(),
    () => assert.ok(allowed),
    native,
  );
  allowed = false;
  assert.equal((await pending).status, "refused");
  assert.equal(layout(), result.layout);
  evidence.cases.push({ kind: "stale-handle-and-authority-refused", layoutUnchanged: true });
  await subscription.close();
  subscription = null;
  await assert.rejects(mirror.resizeWindowSplit("proof", current, randomUUID(), () => {}, native));
  evidence.cases.push({ kind: "released-channel-refused" });
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => subscription?.close(),
    () => mirror?.dispose(),
    () => {
      run(["kill-server"]);
      evidence.cleanup = true;
    },
    () => rmSync(root, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  console.log(JSON.stringify(evidence, null, 2));
}
if (failures.length) throw new AggregateError(failures, "Canonical split fixture failed");
