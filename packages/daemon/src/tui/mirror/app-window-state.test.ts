import { describe, expect, it } from "vitest";

import {
  APP_WINDOW_DOCUMENT_VERSION,
  AppWindowDocumentV1SchemaZ,
  AppWindowSourceSchemaZ,
  type AppWindowDocumentV1,
} from "@tmux-ide/contracts";

import {
  emptyAppWindowDocument,
  focusAppWindow,
  migrateWorkspaceUiStateV2ToAppWindowDocument,
  parseAppWindowDocument,
  restoreAppWindowNamedLayout,
  saveAppWindowNamedLayout,
  serializeAppWindowDocument,
  stableAppWindowInstanceId,
} from "./app-window-state.ts";

const NOW = "2026-07-20T12:00:00.000Z";
const LATER = "2026-07-20T12:01:00.000Z";

function currentWorkspaceUiState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    active: { viewId: "terminals", panel: "terminals" },
    dock: {
      activeTab: "changes",
      mode: "open",
      preferredHeight: 14,
      focusZone: "dock-body",
    },
    surfaces: {
      files: { openPath: null, selectedPath: "src" },
      diff: { selectedPath: "src/index.ts" },
      missions: { selectedMissionId: null, selectedTaskId: null },
      activity: { selectedRowId: null, scrollOffset: 0 },
    },
    views: {
      terminals: { panel: "terminals" },
      files: { panel: "files" },
      diff: { panel: "diff" },
      missions: { panel: "missions" },
    },
    ...overrides,
  };
}

function floatingDocument(): AppWindowDocumentV1 {
  const source = { kind: "native" as const, surface: "files" as const, resourceId: null };
  const firstId = stableAppWindowInstanceId(source);
  const secondSource = {
    kind: "native" as const,
    surface: "changes" as const,
    resourceId: null,
  };
  const secondId = stableAppWindowInstanceId(secondSource);
  return AppWindowDocumentV1SchemaZ.parse({
    version: APP_WINDOW_DOCUMENT_VERSION,
    revision: 0,
    updatedAt: NOW,
    windows: {
      [firstId]: {
        id: firstId,
        source,
        title: "Files",
        placement: {
          mode: "floating",
          docked: { stackId: "main-stack", index: 0 },
          floating: { x: 8, y: 4, width: 72, height: 32 },
        },
      },
      [secondId]: {
        id: secondId,
        source: secondSource,
        title: "Changes",
        placement: {
          mode: "floating",
          docked: null,
          floating: { x: 12, y: 6, width: 80, height: 36 },
        },
      },
    },
    dockRoot: null,
    floatingOrder: [firstId, secondId],
    focusedWindowId: secondId,
    activeLayoutId: null,
    layouts: {},
  });
}

describe("app window state contract", () => {
  it("keeps terminal identity semantic and excludes live tmux correlation", () => {
    const source = { kind: "terminal" as const, terminalSourceId: "agent-lead" };
    const first = stableAppWindowInstanceId(source);
    const second = stableAppWindowInstanceId(source);

    expect(first).toBe(second);
    expect(first).toMatch(/^window-terminal-agent-lead-0-/u);
    expect(AppWindowSourceSchemaZ.safeParse(source).success).toBe(true);
    expect(
      AppWindowSourceSchemaZ.safeParse({
        kind: "terminal",
        terminalSourceId: "agent-lead",
        runtimePaneId: "%19",
      }).success,
    ).toBe(false);
    expect(
      AppWindowSourceSchemaZ.safeParse({ kind: "terminal", terminalSourceId: "%19" }).success,
    ).toBe(false);
  });

  it("validates dock membership, placement memory, floating rects, z-order, and focus", () => {
    const valid = floatingDocument();
    expect(AppWindowDocumentV1SchemaZ.safeParse(valid).success).toBe(true);

    const duplicateZ = structuredClone(valid);
    duplicateZ.floatingOrder.push(duplicateZ.floatingOrder[0]!);
    expect(AppWindowDocumentV1SchemaZ.safeParse(duplicateZ).success).toBe(false);

    const missingRect = structuredClone(valid);
    missingRect.windows[missingRect.floatingOrder[0]!]!.placement.floating = null;
    expect(AppWindowDocumentV1SchemaZ.safeParse(missingRect).success).toBe(false);

    const unknownFocus = structuredClone(valid);
    unknownFocus.focusedWindowId = "window-missing";
    expect(AppWindowDocumentV1SchemaZ.safeParse(unknownFocus).success).toBe(false);
  });

  it("sanitizes invalid V1 and write-protects future documents", () => {
    const invalid = parseAppWindowDocument(
      {
        ...emptyAppWindowDocument(NOW),
        windows: {
          bad: {
            id: "different",
            source: { kind: "terminal", terminalSourceId: "agent" },
            title: null,
            placement: { mode: "floating", docked: null, floating: null },
          },
        },
      },
      NOW,
    );
    const future = parseAppWindowDocument({ version: 99, secret: "keep" }, NOW);

    expect(invalid.document).toEqual(emptyAppWindowDocument(NOW));
    expect(invalid.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "INVALID_FIELD" })]),
    );
    expect(invalid.writeProtected).toBe(false);
    expect(future.writeProtected).toBe(true);
    expect(future.diagnostics[0]?.code).toBe("UNSUPPORTED_VERSION");
  });
});

describe("WorkspaceUiStateV2 app-window migration", () => {
  it("deterministically migrates native surfaces and supplied semantic terminals", () => {
    const first = migrateWorkspaceUiStateV2ToAppWindowDocument(currentWorkspaceUiState(), {
      migratedAt: NOW,
      terminalSourceIds: ["agent-lead", "agent-worker"],
    });
    const second = migrateWorkspaceUiStateV2ToAppWindowDocument(currentWorkspaceUiState(), {
      migratedAt: NOW,
      terminalSourceIds: ["agent-lead", "agent-worker"],
    });

    expect(serializeAppWindowDocument(first.document)).toBe(
      serializeAppWindowDocument(second.document),
    );
    expect(Object.values(first.document.windows)).toHaveLength(6);
    expect(
      Object.values(first.document.windows).filter((window) => window.source.kind === "terminal"),
    ).toHaveLength(2);
    expect(JSON.stringify(first.document)).not.toContain("%pane");
    expect(first.document.dockRoot).toMatchObject({
      type: "split",
      axis: "vertical",
      children: [
        { type: "stack", id: "stack-canvas" },
        { type: "stack", id: "stack-native-dock" },
      ],
    });
    const focused = first.document.windows[first.document.focusedWindowId!];
    expect(focused?.source).toEqual({ kind: "native", surface: "changes", resourceId: null });
    expect(first.document.layouts[first.document.activeLayoutId!]).toMatchObject({
      name: "Migrated workspace",
      revision: 1,
      createdAt: NOW,
    });
  });

  it("never invents a durable terminal identity from the legacy canvas", () => {
    const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(currentWorkspaceUiState(), {
      migratedAt: NOW,
    });

    expect(
      Object.values(migrated.document.windows).some((window) => window.source.kind === "terminal"),
    ).toBe(false);
    expect(migrated.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TERMINAL_SOURCE_REQUIRED" })]),
    );
    expect(AppWindowDocumentV1SchemaZ.safeParse(migrated.document).success).toBe(true);
  });

  it("rejects live tmux pane ids passed as terminal sources", () => {
    expect(() =>
      migrateWorkspaceUiStateV2ToAppWindowDocument(currentWorkspaceUiState(), {
        migratedAt: NOW,
        terminalSourceIds: ["%42"],
      }),
    ).toThrow();
  });
});

describe("app window layout kernel", () => {
  it("saves versioned named layouts and restores exact scene memory", () => {
    const initial = floatingDocument();
    const saved = saveAppWindowNamedLayout(initial, {
      id: "review-layout",
      name: "Review layout",
      description: "Diff beside files",
      updatedAt: NOW,
    });
    const firstId = saved.floatingOrder[0]!;
    const focused = focusAppWindow(saved, firstId, LATER);
    const restored = restoreAppWindowNamedLayout(focused, "review-layout", LATER);

    expect(saved.layouts["review-layout"]).toMatchObject({ revision: 1, createdAt: NOW });
    expect(focused.focusedWindowId).toBe(firstId);
    expect(focused.floatingOrder.at(-1)).toBe(firstId);
    expect(restored.focusedWindowId).toBe(initial.focusedWindowId);
    expect(restored.floatingOrder).toEqual(initial.floatingOrder);
    expect(restored.activeLayoutId).toBe("review-layout");
    expect(restored.revision).toBe(3);
  });

  it("increments existing layout metadata without changing its creation time", () => {
    const initial = floatingDocument();
    const saved = saveAppWindowNamedLayout(initial, {
      id: "review-layout",
      name: "Review",
      updatedAt: NOW,
    });
    const updated = saveAppWindowNamedLayout(saved, {
      id: "review-layout",
      name: "Review updated",
      updatedAt: LATER,
    });

    expect(updated.layouts["review-layout"]).toMatchObject({
      name: "Review updated",
      revision: 2,
      createdAt: NOW,
      updatedAt: LATER,
    });
  });
});
