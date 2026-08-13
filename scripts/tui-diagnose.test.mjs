import assert from "node:assert/strict";
import test from "node:test";

import { analyzeTuiDiagnostic, diagnosticTokens } from "./lib/tui-diagnostics.mjs";

const generation = "00000000-0000-4000-8000-000000000001";

function fixture(overrides = {}) {
  return {
    target: "alpha",
    daemon: { instanceId: generation, pid: 42, protocolVersion: 1 },
    health: { ok: true },
    identity: { ok: true, instanceId: generation, pid: 42, protocolVersion: 1 },
    catalog: {
      daemon: { instanceId: generation },
      liveSessions: [{ sessionName: "alpha", paneCount: 1 }],
    },
    applicationShell: {
      daemon: { instanceId: generation },
      resource: {
        terminalInventory: {
          resources: [
            {
              attachability: { status: "available", semanticPaneId: "pane.semantic.alpha" },
            },
          ],
        },
      },
    },
    panes: [{ paneId: "%1", capture: "prompt\nDIAGNOSTIC_MARKER" }],
    frame: "alpha Terminals\nDIAGNOSTIC_MARKER",
    timeline: [
      { phase: "application-shell-inventory-applied", descriptorCount: 1, elapsedMs: 20 },
      { phase: "runtime-lane-layout", currentWindow: true, paneCount: 1, elapsedMs: 30 },
      { phase: "runtime-lane-connected", generation, elapsedMs: 40 },
      { phase: "first-terminal-frame", elapsedMs: 50 },
    ],
    ...overrides,
  };
}

test("passes only when daemon, semantic runtime, frame ordering and content converge", () => {
  const result = analyzeTuiDiagnostic(fixture());
  assert.equal(result.passed, true);
  assert.equal(result.firstFailure, null);
  assert.deepEqual(result.evidence.matchedTokens, ["DIAGNOSTIC_MARKER"]);
});

test("identifies a blank framebuffer after a healthy runtime lane", () => {
  const result = analyzeTuiDiagnostic(fixture({ frame: "alpha Terminals" }));
  assert.equal(result.passed, false);
  assert.equal(result.firstFailure, "framebuffer-content");
});

test("identifies a false terminal-ready mark before lane connection", () => {
  const data = fixture();
  data.timeline = data.timeline.map((entry) =>
    entry.phase === "first-terminal-frame" ? { ...entry, elapsedMs: 35 } : entry,
  );
  const result = analyzeTuiDiagnostic(data);
  assert.equal(result.passed, false);
  assert.equal(result.firstFailure, "terminal-frame");
});

test("identifies a runtime lane connected to a stale daemon generation", () => {
  const data = fixture();
  data.timeline = data.timeline.map((entry) =>
    entry.phase === "runtime-lane-connected" ? { ...entry, generation: "stale" } : entry,
  );
  const result = analyzeTuiDiagnostic(data);
  assert.equal(result.passed, false);
  assert.equal(result.firstFailure, "runtime-lane");
});

test("token extraction omits static shell chrome", () => {
  assert.deepEqual(diagnosticTokens("Terminal Files tmux-ide\nuseful-marker_123"), [
    "useful-marker_123",
  ]);
});
