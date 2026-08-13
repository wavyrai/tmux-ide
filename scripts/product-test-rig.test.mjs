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
