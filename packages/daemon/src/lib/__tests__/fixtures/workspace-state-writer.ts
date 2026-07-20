import { existsSync, writeFileSync } from "node:fs";

import { createProjectRuntimeRepository } from "../../project-runtime-repository.ts";
import { captureWorkspaceObservation, createWorkspaceLayout } from "../../workspace-state.ts";
import {
  loadWorkspaceState,
  workspaceCheckoutKey,
  writeWorkspaceStateWithRetry,
} from "../../workspace-state-repository.ts";

const [home, projectRoot, layoutId, readyPath, goPath] = process.argv.slice(2);
if (!home || !projectRoot || !layoutId || !readyPath || !goPath) {
  throw new Error("home, projectRoot, layoutId, readyPath, and goPath are required");
}

const repository = createProjectRuntimeRepository(
  {
    inputDir: projectRoot,
    projectRoot,
    identityKey: `git-${"c".repeat(64)}`,
    identitySource: "git-common-dir",
    identityAnchor: "/shared/.git",
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
  },
  { home },
);
const loaded = loadWorkspaceState(repository);
const checkoutKey = workspaceCheckoutKey(projectRoot);
let next = captureWorkspaceObservation(loaded.state, {
  checkoutKey,
  projectRoot,
  observedAt: "2026-07-20T12:00:00.000Z",
  sessionName: null,
  windowIndex: null,
  windowName: null,
  panes: [],
  focusedPaneId: null,
  workbench: {
    canvasPanel: "home",
    dock: { activeTab: "files", mode: "open", preferredHeight: null, focusZone: "canvas" },
  },
});
next = createWorkspaceLayout(next, {
  id: layoutId,
  name: layoutId,
  checkoutKey,
  now: "2026-07-20T12:00:00.000Z",
});

writeFileSync(readyPath, "ready\n", "utf8");
while (!existsSync(goPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);

const result = writeWorkspaceStateWithRetry({
  repository,
  revision: loaded.revision,
  next,
  touchedLayoutIds: new Set([layoutId]),
  checkoutIntents: new Map([
    [checkoutKey, new Set(["live", "workbench", "focus", "active-layout"] as const)],
  ]),
  lock: { timeoutMs: 5_000 },
});
if (!result.saved) {
  process.stderr.write(`${JSON.stringify(result.diagnostics)}\n`);
  process.exitCode = 1;
}
