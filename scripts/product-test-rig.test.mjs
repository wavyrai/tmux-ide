import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PRODUCT_RIG_STATE_VERSION,
  coherentReadiness,
  publicRigStatus,
  readJson,
  writeJsonAtomic,
} from "./product-test-rig-lib.mjs";
import { sourceArchitectureInventory } from "./architecture-debt-inventory.mjs";

test("coherent readiness never aliases app chrome to terminal readiness", () => {
  assert.deepEqual(coherentReadiness({ chromeMs: 12.4, terminalMs: null }), {
    appChromeFrameMs: 12,
    coherentTerminalFrameMs: null,
    ready: false,
  });
  assert.equal(coherentReadiness({ chromeMs: 12, terminalMs: 31 }).ready, true);
});

test("state artifacts are atomic and public status redacts browser authority", () => {
  const root = mkdtempSync(join(tmpdir(), "tmi-product-rig-test-"));
  try {
    const path = join(root, "state.json");
    writeJsonAtomic(path, {
      version: PRODUCT_RIG_STATE_VERSION,
      status: "ready",
      ownerPid: process.pid,
      runtimeNamespace: { tmuxSocketPath: "/tmp/test.sock" },
      web: { pageUrl: "http://127.0.0.1:5173/?devHost=1", browserWsEndpoint: "secret" },
      daemon: { pid: process.pid, port: 1234, instanceId: "generation", authToken: "secret" },
    });
    assert.equal(readJson(path).status, "ready");
    const publicStatus = publicRigStatus(readJson(path));
    assert.equal(publicStatus.running, true);
    assert.equal("browserWsEndpoint" in publicStatus.web, false);
    assert.equal("authToken" in publicStatus.daemon, false);
    assert.doesNotMatch(readFileSync(path, "utf8"), /\.tmp/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("architecture inventory emits grouped, machine-readable deletion reports", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const report = sourceArchitectureInventory(repo);
  assert.equal(report.version, 1);
  assert.equal("generatedAt" in report, false);
  assert.deepEqual(Object.keys(report.groups).sort(), [
    "direct-tmux",
    "grouped-pty",
    "v1-catalog",
    "v1-default-authority",
    "v1-standalone-authority",
  ]);
  for (const group of Object.values(report.groups)) {
    assert.equal(group.remainingUseCount, group.entries.length);
    assert.equal(group.remainingFileCount, group.uses.length);
    assert.equal(group.zeroUse, group.remainingUseCount === 0);
    assert.deepEqual(
      [...group.uses].sort((left, right) => left.localeCompare(right)),
      group.uses,
    );
    for (const entry of group.entries) {
      assert.ok(entry.line > 0);
      assert.ok(group.uses.includes(entry.file));
    }
  }
});

test("architecture debt cannot grow beyond the checked-in deletion budget", () => {
  const repo = new URL("../", import.meta.url).pathname;
  const report = sourceArchitectureInventory(repo);
  const budget = JSON.parse(
    readFileSync(new URL("./architecture-debt-budget.json", import.meta.url), "utf8"),
  );
  assert.equal(budget.version, 1);
  for (const [name, groupBudget] of Object.entries(budget.groups)) {
    const group = report.groups[name];
    assert.ok(group, `missing inventory group ${name}`);
    assert.ok(
      group.remainingUseCount <= groupBudget.maximumUses,
      `${name} grew from budget ${groupBudget.maximumUses} to ${group.remainingUseCount}`,
    );
    assert.equal(groupBudget.targetUses, 0, `${name} must retain an explicit zero-use target`);
  }
});

test("checked-in product baseline is honest and safe to inventory", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("../docs/product/product-baseline.json", import.meta.url), "utf8"),
  );
  assert.equal(baseline.qualification, "not-product-qualified");
  assert.deepEqual(baseline.defaultProduct.primarySurfaces, ["home", "terminals"]);
  assert.deepEqual(baseline.defaultProduct.quarantinedSurfaces, [
    "files",
    "changes",
    "missions",
    "activity",
  ]);
  assert.equal(baseline.portablePerformance.status, "passed-with-limitations");
  assert.equal(baseline.portablePerformance.coherentTerminalFrame, "not-measured");
  assert.equal(baseline.portablePerformance.inputToPaint, "not-measured");
  assert.ok(baseline.knownDefects.every((defect) => defect.reproduce.length > 0));
  assert.match(baseline.completionPolicy, /not Done/u);
  const lineCount = (path) =>
    readFileSync(new URL(path, import.meta.url), "utf8").split("\n").length;
  assert.equal(
    lineCount("../packages/daemon/src/tui/mirror/runtime/application-root.tsx"),
    baseline.sourceMeasurements.openTuiApplicationRootLines + 1,
  );
  assert.equal(
    lineCount("../apps/desktop-renderer/src/experience/application-shell.tsx"),
    baseline.sourceMeasurements.webApplicationShellLines + 1,
  );
  assert.equal(
    lineCount("../apps/desktop-renderer/src/experience/workspace-tiled-surface.tsx"),
    baseline.sourceMeasurements.webWorkspaceTiledSurfaceLines + 1,
  );
});
