import { describe, expect, it } from "vitest";

import {
  WORKSPACE_SEMANTIC_PANE_OPTION,
  WorkspaceObservationSchemaZ,
  type WorkspacePaneBinding,
} from "@tmux-ide/contracts";

import {
  finalizeWorkspaceTmuxReconciliation,
  planWorkspaceTmuxReconciliation,
  workspaceObservationFromTmux,
  type WorkspaceTmuxPaneSnapshot,
} from "./workspace-tmux-adapter.ts";

const NOW = "2026-07-20T10:00:00.000Z";
const WORKBENCH = {
  canvasPanel: "terminals" as const,
  dock: {
    activeTab: "files" as const,
    mode: "open" as const,
    preferredHeight: 12,
    focusZone: "canvas" as const,
  },
};

function pane(
  runtimePaneId: string,
  semanticPaneId: string | null,
  overrides: Partial<WorkspaceTmuxPaneSnapshot> = {},
): WorkspaceTmuxPaneSnapshot {
  return {
    runtimePaneId,
    semanticPaneId,
    role: "shell",
    type: "shell",
    currentCommand: "zsh",
    cwd: "/repo",
    title: "Shell",
    rect: { left: 0, top: 0, width: 80, height: 40 },
    active: false,
    ...overrides,
  };
}

function generator(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? "generator-exhausted";
}

describe("workspace/tmux identity reconciliation", () => {
  it("accepts unique valid pane-local stamps without emitting effects", () => {
    const plan = planWorkspaceTmuxReconciliation({
      panes: [pane("%1", "agent-alpha"), pane("%2", "shell-beta")],
      generateSemanticPaneId: () => "unused",
    });

    expect(
      plan.panes.map(({ semanticPaneId, identitySource }) => ({ semanticPaneId, identitySource })),
    ).toEqual([
      { semanticPaneId: "agent-alpha", identitySource: "stamp" },
      { semanticPaneId: "shell-beta", identitySource: "stamp" },
    ]);
    expect(plan.stampEffects).toEqual([]);
    expect(plan.degraded).toBe(false);
  });

  it("heals missing, invalid, and every duplicate stamp with explicit unique stamp-back effects", () => {
    const plan = planWorkspaceTmuxReconciliation({
      panes: [
        pane("%1", null),
        pane("%2", "bad stamp"),
        pane("%3", "duplicate"),
        pane("%4", "duplicate"),
      ],
      generateSemanticPaneId: generator(["fresh-a", "fresh-b", "fresh-c", "fresh-d"]),
    });

    expect(plan.panes.map((item) => item.semanticPaneId)).toEqual([
      "fresh-a",
      "fresh-b",
      "fresh-c",
      "fresh-d",
    ]);
    expect(plan.stampEffects).toEqual([
      {
        kind: "set-pane-option",
        runtimePaneId: "%1",
        option: WORKSPACE_SEMANTIC_PANE_OPTION,
        value: "fresh-a",
      },
      {
        kind: "set-pane-option",
        runtimePaneId: "%2",
        option: WORKSPACE_SEMANTIC_PANE_OPTION,
        value: "fresh-b",
      },
      {
        kind: "set-pane-option",
        runtimePaneId: "%3",
        option: WORKSPACE_SEMANTIC_PANE_OPTION,
        value: "fresh-c",
      },
      {
        kind: "set-pane-option",
        runtimePaneId: "%4",
        option: WORKSPACE_SEMANTIC_PANE_OPTION,
        value: "fresh-d",
      },
    ]);
    expect(plan.diagnostics.map((item) => item.code)).toEqual([
      "MISSING_SEMANTIC_STAMP",
      "INVALID_SEMANTIC_STAMP",
      "DUPLICATE_SEMANTIC_STAMP",
      "DUPLICATE_SEMANTIC_STAMP",
    ]);
    expect(plan.degraded).toBe(false);
  });

  it("never revives a persisted semantic identity when tmux reuses a runtime pane id", () => {
    const previousBindings: Record<string, WorkspacePaneBinding> = {
      "old-agent": {
        semanticPaneId: "old-agent",
        runtimePaneId: "%7",
        lastSeenAt: NOW,
      },
    };
    const plan = planWorkspaceTmuxReconciliation({
      panes: [pane("%7", "new-shell")],
      previousBindings,
      generateSemanticPaneId: () => "unused",
    });

    expect(plan.panes[0]?.semanticPaneId).toBe("new-shell");
    expect(plan.panes[0]?.semanticPaneId).not.toBe("old-agent");
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "STALE_RUNTIME_BINDING_IGNORED",
        runtimePaneId: "%7",
        semanticPaneId: "old-agent",
      }),
    );
  });

  it("degrades and omits a pane when the injected id generator cannot produce a valid unique id", () => {
    const plan = planWorkspaceTmuxReconciliation({
      panes: [pane("%8", null)],
      generateSemanticPaneId: () => "bad id",
      maxGenerationAttempts: 2,
    });

    expect(plan.panes).toEqual([]);
    expect(plan.stampEffects).toEqual([]);
    expect(plan.degraded).toBe(true);
    expect(plan.diagnostics.at(-1)?.code).toBe("SEMANTIC_ID_GENERATION_FAILED");
  });

  it("excludes a generated identity when stamp-back fails and reports degraded truth", () => {
    const plan = planWorkspaceTmuxReconciliation({
      panes: [pane("%1", "stable"), pane("%2", null)],
      generateSemanticPaneId: () => "generated",
    });
    const finalized = finalizeWorkspaceTmuxReconciliation(plan, [
      { runtimePaneId: "%2", ok: false, error: "pane disappeared" },
    ]);

    expect(finalized.panes.map((item) => item.semanticPaneId)).toEqual(["stable"]);
    expect(finalized.degraded).toBe(true);
    expect(finalized.diagnostics.at(-1)).toMatchObject({
      code: "SEMANTIC_STAMP_BACK_FAILED",
      runtimePaneId: "%2",
      semanticPaneId: "generated",
    });
  });

  it("maps live focus to semantic focus and projects harness/window metadata", () => {
    const plan = planWorkspaceTmuxReconciliation({
      panes: [
        pane("%11", "shell-left", { active: true }),
        pane("%22", "agent-right", {
          role: "lead",
          type: "agent",
          currentCommand: "/usr/local/bin/codex --yolo",
          cwd: "/repo/apps/web",
          title: "Implementer",
          rect: { left: 81, top: 0, width: 79, height: 40 },
        }),
      ],
      generateSemanticPaneId: () => "unused",
    });
    const finalized = finalizeWorkspaceTmuxReconciliation(plan, []);
    const projection = workspaceObservationFromTmux(finalized, {
      checkoutKey: "checkout-main",
      projectRoot: "/repo",
      observedAt: NOW,
      sessionName: "tmux-ide",
      windowIndex: 3,
      windowName: "mission-one",
      focusedRuntimePaneId: "%22",
      workbench: WORKBENCH,
    });
    const observation = projection.observation;

    expect(WorkspaceObservationSchemaZ.safeParse(observation).success).toBe(true);
    expect(observation.focusedPaneId).toBe("agent-right");
    expect(observation.windowIndex).toBe(3);
    expect(observation.windowName).toBe("mission-one");
    expect(observation.panes[1]).toMatchObject({
      semanticPaneId: "agent-right",
      runtimePaneId: "%22",
      role: "agent",
      harness: "codex",
      command: "/usr/local/bin/codex --yolo",
      cwd: "/repo/apps/web",
      title: "Implementer",
    });
  });

  it("normalizes oversized and NUL-bearing live metadata without throwing", () => {
    const longHarness = `codex-${"h".repeat(200)}`;
    const plan = planWorkspaceTmuxReconciliation({
      panes: [
        pane("%31", "agent-long", {
          role: "agent",
          type: "agent",
          currentCommand: `/usr/local/bin/${longHarness}\0${"c".repeat(700)}`,
          cwd: `/repo/${"d".repeat(5000)}\0tail`,
          title: `${"t".repeat(120)}\0tail`,
        }),
      ],
      generateSemanticPaneId: () => "unused",
    });
    const projection = workspaceObservationFromTmux(finalizeWorkspaceTmuxReconciliation(plan, []), {
      checkoutKey: "checkout-main",
      projectRoot: "/repo",
      observedAt: NOW,
      sessionName: `${"s".repeat(300)}\0tail`,
      windowIndex: 0,
      windowName: `${"w".repeat(300)}\0tail`,
      focusedRuntimePaneId: "%31",
      workbench: WORKBENCH,
    });

    expect(WorkspaceObservationSchemaZ.safeParse(projection.observation).success).toBe(true);
    expect(projection.observation.sessionName).toHaveLength(256);
    expect(projection.observation.windowName).toHaveLength(256);
    expect(projection.observation.panes[0]!.harness).toHaveLength(80);
    expect(projection.observation.panes[0]!.title).toHaveLength(80);
    expect(projection.observation.panes[0]!.command).toHaveLength(512);
    expect(projection.observation.panes[0]!.cwd).toHaveLength(4096);
    expect(JSON.stringify(projection.observation)).not.toContain("\\u0000");
    expect(
      projection.diagnostics.filter((diagnostic) => diagnostic.code === "LIVE_METADATA_NORMALIZED"),
    ).toHaveLength(6);
    expect(projection.degraded).toBe(true);
  });
});
