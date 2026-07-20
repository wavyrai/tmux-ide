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
    dockState: { mode: "open", preferredHeight: null, focusZone: "canvas" },
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

  it("never treats prototype properties as owned window, layout, dock, or floating ids", () => {
    for (const inheritedId of ["toString", "hasOwnProperty"]) {
      const inheritedFocus = { ...emptyAppWindowDocument(NOW), focusedWindowId: inheritedId };
      const inheritedLayout = { ...emptyAppWindowDocument(NOW), activeLayoutId: inheritedId };
      const inheritedDock = {
        ...emptyAppWindowDocument(NOW),
        dockRoot: {
          type: "stack",
          id: "stack",
          windowIds: [inheritedId],
          activeWindowId: inheritedId,
        },
      };
      const inheritedFloat = {
        ...emptyAppWindowDocument(NOW),
        floatingOrder: [inheritedId],
      };

      expect(AppWindowDocumentV1SchemaZ.safeParse(inheritedFocus).success).toBe(false);
      expect(AppWindowDocumentV1SchemaZ.safeParse(inheritedLayout).success).toBe(false);
      expect(AppWindowDocumentV1SchemaZ.safeParse(inheritedDock).success).toBe(false);
      expect(AppWindowDocumentV1SchemaZ.safeParse(inheritedFloat).success).toBe(false);
      expect(() => focusAppWindow(emptyAppWindowDocument(NOW), inheritedId, LATER)).toThrow(
        /unknown app window/u,
      );
      expect(() =>
        restoreAppWindowNamedLayout(emptyAppWindowDocument(NOW), inheritedId, LATER),
      ).toThrow(/unknown app window layout/u);
    }
  });

  it("requires focused floating windows to be top-most", () => {
    const invalid = structuredClone(floatingDocument());
    invalid.focusedWindowId = invalid.floatingOrder[0]!;

    expect(AppWindowDocumentV1SchemaZ.safeParse(invalid).success).toBe(false);
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
    expect(invalid.writeProtected).toBe(true);
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
    expect(Object.values(first.document.windows)).toHaveLength(9);
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
    const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(
      currentWorkspaceUiState({
        dock: {
          activeTab: "files",
          mode: "open",
          preferredHeight: null,
          focusZone: "canvas",
        },
      }),
      { migratedAt: NOW },
    );

    expect(
      Object.values(migrated.document.windows).some((window) => window.source.kind === "terminal"),
    ).toBe(false);
    expect(migrated.document.focusedWindowId).toBeNull();
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

  it.each([
    ["home", "home", "home-view"],
    ["files", "files", "files-view"],
    ["diff", "changes", "diff-view"],
    ["missions", "missions", "mission-view"],
  ] as const)(
    "preserves active %s full-panel view identity as a native %s instance",
    (panel, surface, viewId) => {
      const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(
        currentWorkspaceUiState({
          active: { viewId, panel },
          dock: {
            activeTab: "missions",
            mode: "maximized",
            preferredHeight: 22,
            focusZone: "canvas",
          },
          views: { [viewId]: { panel } },
        }),
        { migratedAt: NOW },
      );
      const focused = migrated.document.windows[migrated.document.focusedWindowId!];

      expect(focused?.source).toEqual({ kind: "native", surface, resourceId: viewId });
      expect(migrated.document.dockState).toEqual({
        mode: "maximized",
        preferredHeight: 22,
        focusZone: "canvas",
      });
      expect(AppWindowDocumentV1SchemaZ.safeParse(migrated.document).success).toBe(true);
    },
  );

  it("uses explicit semantic terminal focus and keeps dock selection independent", () => {
    const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(
      currentWorkspaceUiState({
        dock: {
          activeTab: "activity",
          mode: "collapsed",
          preferredHeight: 7,
          focusZone: "canvas",
        },
      }),
      {
        migratedAt: NOW,
        terminalSourceIds: ["agent-lead", "agent-reviewer"],
        focusedTerminalSourceId: "agent-reviewer",
      },
    );
    const focused = migrated.document.windows[migrated.document.focusedWindowId!];
    const root = migrated.document.dockRoot;

    expect(focused?.source).toEqual({
      kind: "terminal",
      terminalSourceId: "agent-reviewer",
    });
    expect(root).toMatchObject({
      type: "split",
      children: [
        { type: "stack", activeWindowId: migrated.document.focusedWindowId },
        { type: "stack" },
      ],
    });
    expect(migrated.document.dockState).toEqual({
      mode: "collapsed",
      preferredHeight: 7,
      focusZone: "canvas",
    });
    expect(() =>
      migrateWorkspaceUiStateV2ToAppWindowDocument(currentWorkspaceUiState(), {
        migratedAt: NOW,
        terminalSourceIds: ["agent-lead", "agent-reviewer"],
        focusedTerminalSourceId: "agent-missing",
      }),
    ).toThrow(/must belong/u);
  });

  it("preserves dock focus and reports composite layout state instead of silently flattening it", () => {
    const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(
      currentWorkspaceUiState({
        active: { viewId: "workspace-composite", panel: "files" },
        views: {
          "workspace-composite": {
            panel: "files",
            layout: { focusedLeafId: "files-leaf", activeTabs: {}, splitWeights: {} },
          },
        },
        dock: {
          activeTab: "missions",
          mode: "open",
          preferredHeight: null,
          focusZone: "dock-tabs",
        },
      }),
      { migratedAt: NOW },
    );
    const focused = migrated.document.windows[migrated.document.focusedWindowId!];

    expect(focused?.source).toEqual({ kind: "native", surface: "missions", resourceId: null });
    expect(migrated.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COMPOSITE_LAYOUT_DEFERRED" })]),
    );
    expect(
      Object.values(migrated.document.windows).some(
        (window) =>
          window.source.kind === "native" && window.source.resourceId === "workspace-composite",
      ),
    ).toBe(false);
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

  it("activates a focused docked window recursively and rejects backwards time", () => {
    const migrated = migrateWorkspaceUiStateV2ToAppWindowDocument(
      currentWorkspaceUiState({
        active: { viewId: "files-a", panel: "files" },
        views: {
          "files-a": { panel: "files" },
          "missions-a": { panel: "missions" },
        },
        dock: {
          activeTab: "files",
          mode: "open",
          preferredHeight: null,
          focusZone: "canvas",
        },
      }),
      { migratedAt: NOW },
    ).document;
    const missionsId = Object.values(migrated.windows).find(
      (window) => window.source.kind === "native" && window.source.resourceId === "missions-a",
    )!.id;
    const invalid = structuredClone(migrated);
    invalid.focusedWindowId = missionsId;

    expect(AppWindowDocumentV1SchemaZ.safeParse(invalid).success).toBe(false);
    const focused = focusAppWindow(migrated, missionsId, LATER);
    expect(focused.focusedWindowId).toBe(missionsId);
    expect(focused.dockRoot).toMatchObject({
      type: "split",
      children: [{ type: "stack", activeWindowId: missionsId }, { type: "stack" }],
    });
    expect(AppWindowDocumentV1SchemaZ.safeParse(focused).success).toBe(true);
    expect(() => focusAppWindow(focused, missionsId, NOW)).toThrow(/must not move backwards/u);
    expect(() =>
      saveAppWindowNamedLayout(focused, {
        id: "older",
        name: "Older",
        updatedAt: NOW,
      }),
    ).toThrow(/must not move backwards/u);
  });
});
