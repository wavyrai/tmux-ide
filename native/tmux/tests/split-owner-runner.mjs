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

const binary = resolve(process.argv[2]);
const root = mkdtempSync("/tmp/tmi-owner-split-");
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

// Import after the isolated environment is established: native observation is opt-in.
process.env.TMUX_IDE_NATIVE_OBSERVATION = "1";
const { createNativeTmuxServerOwner } =
  await import("../../../packages/daemon/src/lib/tmux-server-owner.ts");
const { SessionRuntimeTransportBinder } =
  await import("../../../packages/daemon/src/terminal/session-runtime/transport-binding.ts");
let owner, subscription, binding, replacement;
const failures = [];
try {
  run(["new-session", "-d", "-s", "proof", "-x", "160", "-y", "80", "sleep 120"]);
  run(["split-window", "-h", "-d", "-t", "proof", "sleep 120"]);
  owner = await createNativeTmuxServerOwner({
    environmentId: randomUUID(),
    serverId: "tmux-server." + randomUUID().replaceAll("-", ""),
    generation: randomUUID(),
    tmuxAuthority: { executablePath: binary, socketSelector: { kind: "path", path: socketPath } },
    stateDirectory: root + "/state",
    webSocketUrl: "ws://127.0.0.1:45678/v2/terminal/pane-streams/redeem",
  });
  const catalog = await owner.catalog();
  const row = catalog.find((row) => row.sessionName === "proof");
  assert.ok(row);
  const opened = await owner.openSession(row.liveSessionId);
  const registry = owner.sessionRuntimeRegistry;
  const identity = await registry.describeSessionAuthority("proof");
  let latest;
  subscription = await registry.subscribeLayout("proof", () => {}, {
    expectedRuntimeSessionId: run(["display-message", "-p", "-t", "proof", "#{session_id}"]),
    expectedSemanticPaneIds: identity.description.panes.map((p) => p.semanticPaneId),
    onAuthority: (value) => {
      latest = value;
    },
  });
  const link = latest.windowLinks.links[0];
  const window = {
    liveSessionId: latest.windowLinks.liveSessionId,
    linkId: link.linkId,
    linkRevision: latest.windowLinks.linkRevision,
    expectedSemanticWindowId: link.semanticWindowId,
  };
  const resource = await owner.readWindowSplitLayout(opened.workspaceName, window);
  assert.equal(resource.splits.length, 1);
  const binder = new SessionRuntimeTransportBinder(registry);
  const bind = () =>
    binder.bind({
      transport: "pane-stream",
      transportLeaseId: randomUUID(),
      session: "proof",
      hostClientId: "gpui:owner-split-fixture",
      interactive: true,
      ownsGeometry: true,
      explicitAuthority: true,
      allowedSourcePaneIds: identity.description.panes.map((p) => p.semanticPaneId),
    });
  binding = bind();
  binding.requestAuthority("input");
  const intent = {
    verb: "workspace.window.split.resize",
    workspaceName: opened.workspaceName,
    target: {
      window,
      layoutId: resource.layoutId,
      splitId: resource.splits[0].splitId,
      boundary: 83,
    },
  };
  assert.throws(() => binding.submitIntent(randomUUID(), intent));
  binding.requestAuthority("geometry");
  const identities = () =>
    run(["list-panes", "-t", "proof", "-F", "#{pane_id}:#{pane_birth_id}:#{pane_pid}"]);
  const beforeIds = identities();
  const operationId = randomUUID();
  const result = await binding.submitIntent(operationId, intent);
  assert.equal(result.boundary, 83);
  assert.ok(result.successor, "canonical successor must be published for this isolated resize");
  assert.equal(identities(), beforeIds);
  const duplicate = await binding.submitIntent(operationId, intent);
  assert.deepEqual(duplicate, { ...result, outcome: "replayed" });
  let changed;
  for (let i = 0; i < 100; i++) {
    changed = await owner.readWindowSplitLayout(opened.workspaceName, window);
    if (changed.layoutId !== resource.layoutId) break;
    await delay(10);
  }
  assert.notEqual(changed.layoutId, resource.layoutId);
  assert.equal(changed.splits[0].boundary, 83);
  assert.deepEqual(result.successor.resource, changed);
  assert.equal(changed.splits.find((s) => s.splitId === result.successor.splitId)?.boundary, 83);
  await assert.rejects(binding.submitIntent(randomUUID(), intent));
  replacement = bind();
  replacement.requestAuthority("geometry");
  assert.throws(() =>
    binding.submitIntent(randomUUID(), {
      ...intent,
      target: {
        ...intent.target,
        layoutId: changed.layoutId,
        splitId: changed.splits[0].splitId,
        boundary: 70,
      },
    }),
  );
  assert.equal(
    (await owner.readWindowSplitLayout(opened.workspaceName, window)).splits[0].boundary,
    83,
  );
  evidence.cases.push({
    kind: "real-owner-observer-geometry-native-effect",
    boundary: 83,
    duplicateStable: true,
    canonicalSuccessorMatched: true,
    paneIdentitiesStable: true,
    inputOnlyRefused: true,
    staleTargetRefused: true,
    replacedGeometryRefused: true,
  });
} catch (error) {
  failures.push(error);
} finally {
  for (const cleanup of [
    () => replacement?.close(),
    () => binding?.close(),
    () => subscription?.close(),
    () => owner?.dispose(),
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
if (failures.length) throw new AggregateError(failures, "Owner split fixture failed");
