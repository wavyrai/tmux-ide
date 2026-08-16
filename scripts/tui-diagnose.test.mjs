import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
    panes: [
      {
        paneId: "%1",
        windowActive: true,
        paneActive: true,
        capture: "prompt\nDIAGNOSTIC_MARKER",
      },
    ],
    frame: "alpha Terminals\nDIAGNOSTIC_MARKER",
    timeline: [
      {
        phase: "generation-shell-lifecycle",
        clientPhase: "live",
        shellStatus: "live",
        inventoryResources: 1,
        inventoryAttachability: [{ status: "available", semanticPaneId: "pane.semantic.alpha" }],
        elapsedMs: 20,
      },
      {
        phase: "generation-runtime-progress",
        runtimePhase: "physical-ready",
        panes: 1,
        elapsedMs: 30,
      },
      {
        phase: "generation-runtime-progress",
        runtimePhase: "coherent",
        panes: 1,
        seededPanes: 1,
        elapsedMs: 40,
      },
      { phase: "generation-status", status: "live", daemonGeneration: generation, elapsedMs: 45 },
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

test("requires body evidence from every token-bearing pane in the active window", () => {
  const data = fixture();
  data.panes = [
    data.panes[0],
    {
      paneId: "%2",
      windowActive: true,
      paneActive: false,
      capture: "SECOND_PANE_UNIQUE_MARKER",
    },
  ];
  data.catalog.liveSessions[0].paneCount = 2;
  data.applicationShell.resource.terminalInventory.resources.push({
    attachability: { status: "available", semanticPaneId: "pane.semantic.beta" },
  });
  data.timeline = data.timeline.map((entry) => {
    if (entry.phase === "generation-shell-lifecycle") {
      return {
        ...entry,
        inventoryResources: 2,
        inventoryAttachability: [
          ...entry.inventoryAttachability,
          { status: "available", semanticPaneId: "pane.semantic.beta" },
        ],
      };
    }
    if (entry.phase === "generation-runtime-progress") {
      return {
        ...entry,
        panes: 2,
        ...(entry.runtimePhase === "coherent" ? { seededPanes: 2 } : {}),
      };
    }
    return entry;
  });

  const result = analyzeTuiDiagnostic(data);
  assert.equal(result.passed, false);
  assert.equal(result.firstFailure, "framebuffer-content");
  assert.equal(result.evidence.visiblePaneEvidence.length, 2);
});

test("requires active-window bodies but ignores an inactive window body", () => {
  const data = fixture();
  data.panes.push({
    paneId: "%9",
    windowActive: false,
    paneActive: false,
    capture: "INACTIVE_WINDOW_UNIQUE_MARKER",
  });
  data.catalog.liveSessions[0].paneCount = 2;
  data.applicationShell.resource.terminalInventory.resources.push({
    attachability: { status: "available", semanticPaneId: "pane.semantic.inactive" },
  });
  data.timeline = data.timeline.map((entry) => {
    if (entry.phase === "generation-shell-lifecycle") {
      return {
        ...entry,
        inventoryResources: 2,
        inventoryAttachability: [
          ...entry.inventoryAttachability,
          { status: "available", semanticPaneId: "pane.semantic.inactive" },
        ],
      };
    }
    if (entry.phase === "generation-runtime-progress") {
      return {
        ...entry,
        panes: 2,
        ...(entry.runtimePhase === "coherent" ? { seededPanes: 2 } : {}),
      };
    }
    return entry;
  });

  const result = analyzeTuiDiagnostic(data);
  assert.equal(result.passed, true);
  assert.equal(result.evidence.visiblePaneEvidence.length, 1);
  assert.deepEqual(result.evidence.matchedTokens, ["DIAGNOSTIC_MARKER"]);
});

test("identifies a false terminal-ready mark before lane connection", () => {
  const data = fixture();
  data.timeline = data.timeline.map((entry) =>
    entry.phase === "first-terminal-frame" ? { ...entry, elapsedMs: 35 } : entry,
  );
  const result = analyzeTuiDiagnostic(data);
  assert.equal(result.passed, false);
  assert.equal(result.firstFailure, "tui-painted-frame");
});

test("identifies a runtime lane connected to a stale daemon generation", () => {
  const data = fixture();
  data.timeline = data.timeline.map((entry) =>
    entry.phase === "generation-status" ? { ...entry, daemonGeneration: "stale" } : entry,
  );
  const result = analyzeTuiDiagnostic(data);
  assert.equal(result.passed, false);
  assert.equal(result.firstFailure, "terminal-fast-lane");
});

test("token extraction omits static shell chrome", () => {
  assert.deepEqual(diagnosticTokens("Terminal Files tmux-ide\nuseful-marker_123"), [
    "useful-marker_123",
  ]);
});

test("--help is side-effect free and documents the target contract", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("./tui-diagnose.mjs", import.meta.url).pathname, "--help"],
    {
      encoding: "utf8",
    },
  );
  assert.match(output, /OpenTUI causal diagnostic/u);
  assert.match(output, /--target <session>/u);
  assert.match(output, /never mutates or kills the target tmux session/u);
});
