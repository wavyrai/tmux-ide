import { describe, expect, it } from "vitest";

import {
  WorkspaceLayoutApplyPlanSchemaZ,
  WorkspaceObservationSchemaZ,
  WorkspacePaneCwdSchemaZ,
  WorkspacePaneTopologySchemaZ,
  WorkspacePaneTreeNodeSchemaZ,
  WorkspaceStateV1SchemaZ,
  type WorkspaceObservation,
} from "@tmux-ide/contracts";

import {
  applyWorkspaceLayout,
  captureWorkspaceObservation,
  createWorkspaceLayout,
  defaultWorkspaceState,
  deleteWorkspaceLayout,
  migrateWorkspaceUiStateV2,
  parseWorkspaceStateValue,
  projectWorkspaceTopology,
  renameWorkspaceLayout,
  saveWorkspaceLayout,
  serializeWorkspaceState,
} from "../workspace-state.ts";

const PROJECT = {
  identityKey: `git-${"a".repeat(64)}`,
  identitySource: "git-common-dir" as const,
  identityAnchor: "/repo/.git",
};
const NOW = "2026-07-20T10:00:00.000Z";
const LATER = "2026-07-20T10:01:00.000Z";

function observation(
  panes: WorkspaceObservation["panes"],
  overrides: Partial<WorkspaceObservation> = {},
): WorkspaceObservation {
  return {
    checkoutKey: "checkout-main",
    projectRoot: "/repo",
    observedAt: NOW,
    sessionName: "tmux-ide",
    windowIndex: 0,
    windowName: "workspace",
    panes,
    focusedPaneId: panes[0]?.semanticPaneId ?? null,
    workbench: {
      canvasPanel: "terminals",
      dock: {
        activeTab: "files",
        mode: "open",
        preferredHeight: 12,
        focusZone: "canvas",
      },
    },
    ...overrides,
  };
}

function pane(
  semanticPaneId: string,
  runtimePaneId: `%${number}`,
  left: number,
  overrides: Partial<WorkspaceObservation["panes"][number]> = {},
): WorkspaceObservation["panes"][number] {
  return {
    semanticPaneId,
    runtimePaneId,
    role: "agent",
    harness: "codex",
    title: "Implementer",
    command: "codex --yolo",
    cwd: "/repo",
    rect: { left, top: 0, width: 80, height: 40 },
    ...overrides,
  };
}

describe("workspace topology and capture", () => {
  it("keeps duplicate-looking panes distinct and assigns deterministic tree parent ids", () => {
    const panes = [pane("agent-alpha", "%1", 0), pane("agent-beta", "%2", 80)];
    const first = projectWorkspaceTopology(panes, "/repo");
    const second = projectWorkspaceTopology([...panes].reverse(), "/repo");

    expect(first).toEqual(second);
    expect(Object.keys(first.panes)).toEqual(["agent-alpha", "agent-beta"]);
    expect(first.root).toMatchObject({ type: "split", axis: "horizontal" });
    expect(first.panes["agent-alpha"]!.parentId).toBe(first.root?.nodeId);
    expect(first.panes["agent-beta"]!.parentId).toBe(first.root?.nodeId);
    expect(
      WorkspaceStateV1SchemaZ.safeParse({
        ...defaultWorkspaceState(PROJECT),
        checkouts: {
          main: {
            checkoutKey: "main",
            projectRoot: "/repo",
            activeLayoutId: null,
            topology: first,
            focusedPaneId: "agent-alpha",
            workbench: observation([]).workbench,
            bindings: {},
            recovery: {
              status: "clean",
              capturedAt: NOW,
              sessionName: "tmux-ide",
              windowIndex: 0,
              windowName: "workspace",
              missingPaneIds: [],
              externalPaneIds: [],
            },
          },
        },
      }).success,
    ).toBe(true);
  });

  it("preserves semantic pane identity while replacing checkout-scoped runtime bindings", () => {
    const initial = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("agent-alpha", "%1", 0)]),
    );
    const rebound = captureWorkspaceObservation(
      initial,
      observation([pane("agent-alpha", "%99", 0)], { observedAt: LATER }),
    );

    expect(rebound.checkouts["checkout-main"]!.topology).toEqual(
      initial.checkouts["checkout-main"]!.topology,
    );
    expect(rebound.checkouts["checkout-main"]!.bindings["agent-alpha"]).toEqual({
      semanticPaneId: "agent-alpha",
      runtimePaneId: "%99",
      lastSeenAt: LATER,
    });
    expect(
      captureWorkspaceObservation(
        rebound,
        observation([pane("agent-alpha", "%99", 0)], { observedAt: LATER }),
      ),
    ).toEqual(rebound);
  });

  it("rejects duplicate semantic/runtime ids and checkout-key/root mismatches", () => {
    const duplicateSemantic = observation([pane("agent", "%1", 0), pane("agent", "%2", 80)]);
    const duplicateRuntime = observation([pane("agent-a", "%1", 0), pane("agent-b", "%1", 80)]);

    expect(WorkspaceObservationSchemaZ.safeParse(duplicateSemantic).success).toBe(false);
    expect(WorkspaceObservationSchemaZ.safeParse(duplicateRuntime).success).toBe(false);
    expect(() =>
      captureWorkspaceObservation(defaultWorkspaceState(PROJECT), duplicateSemantic),
    ).toThrow(/semantic pane ids must be unique/u);
    expect(() =>
      captureWorkspaceObservation(defaultWorkspaceState(PROJECT), duplicateRuntime),
    ).toThrow(/runtime pane ids must be unique/u);

    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("agent", "%1", 0)]),
    );
    expect(() =>
      captureWorkspaceObservation(
        captured,
        observation([pane("agent", "%2", 0)], {
          projectRoot: "/different-repo",
          observedAt: LATER,
        }),
      ),
    ).toThrow(/different project root/u);

    const invalidBindings = structuredClone(captured);
    invalidBindings.checkouts["checkout-main"]!.topology = projectWorkspaceTopology(
      [pane("agent", "%1", 0), pane("second", "%2", 80)],
      "/repo",
    );
    invalidBindings.checkouts["checkout-main"]!.bindings.second = {
      semanticPaneId: "second",
      runtimePaneId: "%1",
      lastSeenAt: NOW,
    };
    expect(WorkspaceStateV1SchemaZ.safeParse(invalidBindings).success).toBe(false);
  });

  it("preserves the last recoverable topology on empty or older observations", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation(
        [
          pane("lead", "%7", 0, { command: "codex --yolo", cwd: "/repo/apps/web" }),
          pane("shell", "%8", 80, {
            role: "shell",
            harness: null,
            title: "Dev shell",
            command: "pnpm dev",
            cwd: "/repo/apps/site",
          }),
        ],
        { observedAt: LATER },
      ),
    );
    const partial = captureWorkspaceObservation(
      captured,
      observation([pane("lead", "%70", 0)], {
        observedAt: "2026-07-20T10:02:00.000Z",
      }),
    );
    const partialAgain = captureWorkspaceObservation(
      partial,
      observation([pane("lead", "%71", 0)], {
        observedAt: "2026-07-20T10:03:00.000Z",
      }),
    );
    const empty = captureWorkspaceObservation(
      partialAgain,
      observation([], { observedAt: "2026-07-20T10:04:00.000Z", focusedPaneId: null }),
    );
    const stale = captureWorkspaceObservation(
      empty,
      observation([pane("stale", "%1", 0)], { observedAt: NOW }),
    );

    expect(partial.checkouts["checkout-main"]!.topology.panes.shell).toEqual(
      captured.checkouts["checkout-main"]!.topology.panes.shell,
    );
    expect(partialAgain.checkouts["checkout-main"]!.topology.root).toEqual(
      captured.checkouts["checkout-main"]!.topology.root,
    );
    expect(partialAgain.checkouts["checkout-main"]!.bindings.shell).toEqual(
      captured.checkouts["checkout-main"]!.bindings.shell,
    );
    expect(empty.checkouts["checkout-main"]).toMatchObject({
      topology: partialAgain.checkouts["checkout-main"]!.topology,
      focusedPaneId: "lead",
      bindings: partialAgain.checkouts["checkout-main"]!.bindings,
      recovery: { status: "empty", missingPaneIds: ["lead", "shell"] },
    });
    expect(stale).toEqual(empty);
  });

  it("keeps the first observation when timestamps are equal", () => {
    const first = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0)]),
    );
    const equalTimestamp = captureWorkspaceObservation(
      first,
      observation([pane("replacement", "%9", 0)]),
    );

    expect(equalTimestamp).toEqual(first);
  });

  it("builds a schema-valid bounded tree for more than eight overlapping panes", () => {
    const overlapping = Array.from({ length: 9 }, (_, index) =>
      pane(`agent-${index}`, `%${index + 1}` as `%${number}`, 0),
    );
    const topology = projectWorkspaceTopology(overlapping, "/repo");

    expect(Object.keys(topology.panes)).toHaveLength(9);
    expect(
      WorkspaceStateV1SchemaZ.safeParse({
        ...defaultWorkspaceState(PROJECT),
        checkouts: {
          main: {
            ...captureWorkspaceObservation(
              defaultWorkspaceState(PROJECT),
              observation(overlapping, { checkoutKey: "main" }),
            ).checkouts.main,
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each([33, 128])("balances %i linear panes within tree depth limits", (count) => {
    const linear = Array.from({ length: count }, (_, index) =>
      pane(`agent-${index}`, `%${index + 1}` as `%${number}`, index * 2, {
        rect: { left: index * 2, top: 0, width: 1, height: 40 },
      }),
    );
    const topology = projectWorkspaceTopology(linear, "/repo");
    let depth = 0;
    const stack = topology.root ? [{ node: topology.root, depth: 1 }] : [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      depth = Math.max(depth, current.depth);
      if (current.node.type === "split") {
        for (const child of current.node.children) {
          stack.push({ node: child, depth: current.depth + 1 });
        }
      }
    }

    expect(WorkspacePaneTopologySchemaZ.safeParse(topology).success).toBe(true);
    expect(Object.keys(topology.panes)).toHaveLength(count);
    expect(depth).toBeLessThanOrEqual(9);
  });
});

describe("named workspace layouts", () => {
  it("round-trips create, rename, save, and delete without mutating earlier values", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0), pane("implementer", "%2", 80)]),
    );
    const created = createWorkspaceLayout(captured, {
      id: "pairing",
      name: "Pairing",
      checkoutKey: "checkout-main",
      now: NOW,
    });
    const renamed = renameWorkspaceLayout(created, "pairing", "Mission Pair", LATER);
    const changedLive = captureWorkspaceObservation(
      renamed,
      observation([pane("lead", "%1", 0)], { observedAt: LATER }),
    );
    const saved = saveWorkspaceLayout(changedLive, "pairing", "checkout-main", LATER);
    const deleted = deleteWorkspaceLayout(saved, "pairing");

    expect(captured.layouts).toEqual({});
    expect(created.layouts.pairing).toMatchObject({ name: "Pairing", revision: 1 });
    expect(renamed.layouts.pairing).toMatchObject({ name: "Mission Pair", revision: 2 });
    expect(Object.keys(saved.layouts.pairing!.snapshot.topology.panes)).toEqual(["lead"]);
    expect(saved.layouts.pairing!.revision).toBe(3);
    expect(deleted.layouts).toEqual({});
    expect(deleted.checkouts["checkout-main"]!.activeLayoutId).toBeNull();
  });

  it("returns the full desired topology in a pure apply plan while reporting drift", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0), pane("implementer", "%2", 80)]),
    );
    const withLayout = createWorkspaceLayout(captured, {
      id: "pairing",
      name: "Pairing",
      checkoutKey: "checkout-main",
      now: NOW,
    });
    const live = observation(
      [
        pane("lead", "%9", 0),
        pane("external-shell", "%10", 80, { role: "shell", harness: null, title: "Shell" }),
      ],
      { observedAt: LATER },
    );
    const beforeLayout = structuredClone(withLayout.layouts.pairing);
    const applied = applyWorkspaceLayout(withLayout, "pairing", live);

    expect(Object.keys(applied.plan.targetTopology.panes)).toEqual(["implementer", "lead"]);
    expect(applied.plan).toMatchObject({
      retainedPaneIds: ["lead"],
      missingPaneIds: ["implementer"],
      externalPaneIds: ["external-shell"],
      targetFocusedPaneId: "lead",
      liveFocusedPaneId: "lead",
      checkoutKey: "checkout-main",
      sessionName: "tmux-ide",
      windowIndex: 0,
      windowName: "workspace",
      retainedBindings: {
        lead: { semanticPaneId: "lead", runtimePaneId: "%9", lastSeenAt: LATER },
      },
    });
    expect(applied.state.checkouts["checkout-main"]!.topology.panes).toHaveProperty(
      "external-shell",
    );
    expect(withLayout.layouts.pairing).toEqual(beforeLayout);
    expect(WorkspaceLayoutApplyPlanSchemaZ.safeParse(applied.plan).success).toBe(true);
  });

  it("rebases project-relative cwd across linked checkouts and keeps absolute cwd absolute", () => {
    const main = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([
        pane("lead", "%1", 0, { cwd: "/repo/apps/web" }),
        pane("tool", "%2", 80, { cwd: "/opt/shared-tool" }),
      ]),
    );
    const withLayout = createWorkspaceLayout(main, {
      id: "portable",
      name: "Portable",
      checkoutKey: "checkout-main",
      now: NOW,
    });
    const linkedObservation = observation(
      [
        pane("lead", "%11", 0, { cwd: "/linked/repo/apps/web" }),
        pane("tool", "%12", 80, { cwd: "/opt/shared-tool" }),
      ],
      {
        checkoutKey: "checkout-linked",
        projectRoot: "/linked/repo",
        observedAt: LATER,
        sessionName: "linked-session",
        windowIndex: 3,
        windowName: "agents",
      },
    );
    const applied = applyWorkspaceLayout(withLayout, "portable", linkedObservation);

    expect(withLayout.layouts.portable!.snapshot.topology.panes.lead!.cwd).toEqual({
      kind: "project-relative",
      path: "apps/web",
    });
    expect(withLayout.layouts.portable!.snapshot.topology.panes.tool!.cwd).toEqual({
      kind: "absolute",
      path: "/opt/shared-tool",
    });
    expect(applied.plan).toMatchObject({
      checkoutKey: "checkout-linked",
      projectRoot: "/linked/repo",
      sessionName: "linked-session",
      windowIndex: 3,
      windowName: "agents",
      materializedPaneCwds: {
        lead: "/linked/repo/apps/web",
        tool: "/opt/shared-tool",
      },
    });
  });

  it("rejects project-relative traversal and materializes contained nested and dot paths", () => {
    for (const path of [
      "nested/../../../outside",
      "nested\\..\\..\\outside",
      "C:\\outside",
      "/outside",
    ]) {
      expect(WorkspacePaneCwdSchemaZ.safeParse({ kind: "project-relative", path }).success).toBe(
        false,
      );
    }
    for (const path of ["apps/web", ".", "apps/../web", "apps\\..\\web"]) {
      expect(WorkspacePaneCwdSchemaZ.safeParse({ kind: "project-relative", path }).success).toBe(
        true,
      );
    }

    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([
        pane("nested", "%1", 0, { cwd: "/repo/apps/web" }),
        pane("root", "%2", 80, { cwd: "/repo" }),
      ]),
    );
    const invalidSnapshot = structuredClone({
      topology: captured.checkouts["checkout-main"]!.topology,
      focusedPaneId: "nested",
      workbench: captured.checkouts["checkout-main"]!.workbench,
    });
    invalidSnapshot.topology.panes.nested!.cwd = {
      kind: "project-relative",
      path: "nested/../../../outside",
    };
    expect(() =>
      createWorkspaceLayout(captured, {
        id: "escaping",
        name: "Escaping",
        checkoutKey: "checkout-main",
        now: NOW,
        snapshot: invalidSnapshot,
      }),
    ).toThrow(/remain inside the checkout/u);

    const withLayout = createWorkspaceLayout(captured, {
      id: "contained",
      name: "Contained",
      checkoutKey: "checkout-main",
      now: NOW,
    });
    const applied = applyWorkspaceLayout(
      withLayout,
      "contained",
      observation(
        [
          pane("nested", "%10", 0, { cwd: "/linked/apps/web" }),
          pane("root", "%11", 80, { cwd: "/linked" }),
        ],
        {
          checkoutKey: "checkout-linked",
          projectRoot: "/linked",
          observedAt: LATER,
        },
      ),
    );
    expect(applied.plan.materializedPaneCwds).toEqual({
      nested: "/linked/apps/web",
      root: "/linked",
    });

    const corrupted = structuredClone(withLayout);
    corrupted.layouts.contained!.snapshot.topology.panes.nested!.cwd = {
      kind: "project-relative",
      path: "nested/../../../outside",
    };
    expect(() =>
      applyWorkspaceLayout(
        corrupted,
        "contained",
        observation([pane("nested", "%20", 0)], { observedAt: LATER }),
      ),
    ).toThrow(/remain inside the checkout/u);
  });

  it("keeps desired target focus separate from an external live focus", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0)]),
    );
    const withLayout = createWorkspaceLayout(captured, {
      id: "lead-only",
      name: "Lead only",
      checkoutKey: "checkout-main",
      now: NOW,
    });
    const applied = applyWorkspaceLayout(
      withLayout,
      "lead-only",
      observation([pane("external", "%9", 0, { active: true })], {
        observedAt: LATER,
        focusedPaneId: "external",
      }),
    );

    expect(applied.plan).toMatchObject({
      targetFocusedPaneId: "lead",
      liveFocusedPaneId: "external",
      missingPaneIds: ["lead"],
      externalPaneIds: ["external"],
    });
    expect(applied.state.checkouts["checkout-main"]!.focusedPaneId).toBe("external");
  });
});

describe("workspace state parsing and migration", () => {
  it("serializes records canonically and protects future versions", () => {
    const state = defaultWorkspaceState(PROJECT);
    const parsed = parseWorkspaceStateValue({ version: 99, opaque: { keep: true } }, PROJECT);
    expect(parsed.writeProtected).toBe(true);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({ code: "UNSUPPORTED_VERSION" }),
    );
    expect(parseWorkspaceStateValue({ version: "1" }, PROJECT).writeProtected).toBe(true);

    state.checkouts.zeta = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("z", "%1", 0)], { checkoutKey: "zeta" }),
    ).checkouts.zeta!;
    state.checkouts.alpha = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("a", "%2", 0)], { checkoutKey: "alpha" }),
    ).checkouts.alpha!;
    expect(serializeWorkspaceState(state).indexOf('"alpha"')).toBeLessThan(
      serializeWorkspaceState(state).indexOf('"zeta"'),
    );
  });

  it("preserves every schema-accepted canonical id, timestamp, and tree id", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("Agent.Mixed_id-1", "%7", 0)], {
        observedAt: "2026-07-20T10:00:00Z",
        focusedPaneId: "Agent.Mixed_id-1",
      }),
    );
    const state = createWorkspaceLayout(captured, {
      id: "Layout.Mixed_id-1",
      name: "  Exact name  ",
      checkoutKey: "checkout-main",
      now: "2026-07-20T10:00:00Z",
    });
    const wireValue = JSON.parse(serializeWorkspaceState(state));

    expect(WorkspaceStateV1SchemaZ.safeParse(wireValue).success).toBe(true);
    const parsed = parseWorkspaceStateValue(wireValue, PROJECT);
    expect(parsed).toMatchObject({ writeProtected: false, diagnostics: [] });
    expect(parsed.state).toEqual(state);
    expect(parsed.state.layouts["Layout.Mixed_id-1"]!.name).toBe("  Exact name  ");
    expect(parsed.state.layouts["Layout.Mixed_id-1"]!.createdAt).toBe("2026-07-20T10:00:00Z");
  });

  it("write-protects supported V1 structural corruption instead of dropping fields", () => {
    const state = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0)]),
    );
    const corrupt = structuredClone(state) as unknown as {
      checkouts: { "checkout-main": { topology: { panes: { lead: { id: string } } } } };
    };
    corrupt.checkouts["checkout-main"].topology.panes.lead.id = "different-id";
    const parsed = parseWorkspaceStateValue(corrupt, PROJECT);

    expect(parsed.writeProtected).toBe(true);
    expect(parsed.state).toEqual(defaultWorkspaceState(PROJECT));
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_FIELD" }));
  });

  it("throws on invalid CRUD snapshots and layout limit overflow", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0)]),
    );
    expect(() =>
      createWorkspaceLayout(captured, {
        id: "invalid",
        name: "Invalid",
        checkoutKey: "checkout-main",
        now: NOW,
        snapshot: {
          topology: { panes: {}, root: null },
          focusedPaneId: "missing",
          workbench: observation([]).workbench,
        },
      }),
    ).toThrow(/focused pane/u);

    const template = createWorkspaceLayout(captured, {
      id: "template",
      name: "Template",
      checkoutKey: "checkout-main",
      now: NOW,
    }).layouts.template!;
    const full = structuredClone(captured);
    full.layouts = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => {
        const id = `layout-${index}`;
        return [id, { ...template, id, name: id }];
      }),
    );
    expect(WorkspaceStateV1SchemaZ.safeParse(full).success).toBe(true);
    expect(() =>
      createWorkspaceLayout(full, {
        id: "overflow",
        name: "Overflow",
        checkoutKey: "checkout-main",
        now: LATER,
      }),
    ).toThrow(/layout limit exceeded/u);
  });

  it("enforces topology invariants and write-protects oversized records without truncation", () => {
    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0), pane("implementer", "%2", 80)]),
    );
    const invalidParent = structuredClone(captured);
    invalidParent.checkouts["checkout-main"]!.topology.panes.lead!.parentId = "wrong-parent";
    expect(WorkspaceStateV1SchemaZ.safeParse(invalidParent).success).toBe(false);

    const template = createWorkspaceLayout(captured, {
      id: "template",
      name: "Template",
      checkoutKey: "checkout-main",
      now: NOW,
    }).layouts.template!;
    const layouts = Object.fromEntries(
      Array.from({ length: 34 }, (_, index) => {
        const id = `layout-${String(33 - index).padStart(2, "0")}`;
        return [id, { ...template, id, name: id }];
      }),
    );
    const parsed = parseWorkspaceStateValue(
      { ...defaultWorkspaceState(PROJECT), layouts },
      PROJECT,
    );

    expect(parsed.state.layouts).toEqual({});
    expect(parsed.writeProtected).toBe(true);
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "OVERSIZED" }));
  });

  it("rejects deeply nested raw trees in an iterative preflight before recursive parsing", () => {
    let deepTree: unknown = { type: "pane", nodeId: "leaf-root", paneId: "lead" };
    for (let depth = 0; depth < 40; depth += 1) {
      deepTree = {
        type: "split",
        nodeId: `split-${depth}`,
        axis: "horizontal",
        children: [deepTree, { type: "pane", nodeId: `leaf-${depth}`, paneId: "lead" }],
        weights: [1, 1],
      };
    }
    expect(() => WorkspacePaneTreeNodeSchemaZ.safeParse(deepTree)).not.toThrow();
    expect(WorkspacePaneTreeNodeSchemaZ.safeParse(deepTree).success).toBe(false);

    const captured = captureWorkspaceObservation(
      defaultWorkspaceState(PROJECT),
      observation([pane("lead", "%1", 0)]),
    );
    const state = createWorkspaceLayout(captured, {
      id: "deep",
      name: "Deep",
      checkoutKey: "checkout-main",
      now: NOW,
    });
    const raw = structuredClone(state) as unknown as {
      layouts: { deep: { snapshot: { topology: { root: unknown } } } };
    };
    raw.layouts.deep.snapshot.topology.root = deepTree;
    const parsed = parseWorkspaceStateValue(raw, PROJECT);

    expect(parsed.state.layouts).toEqual({});
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: "OVERSIZED" }));
  });

  it("rejects pane trees whose total node count exceeds the bounded contract", () => {
    let sequence = 0;
    const broadTree = (remaining: number): unknown => {
      const id = sequence++;
      if (remaining === 0) return { type: "pane", nodeId: `leaf-${id}`, paneId: `pane-${id}` };
      return {
        type: "split",
        nodeId: `split-${id}`,
        axis: "vertical",
        children: [broadTree(remaining - 1), broadTree(remaining - 1)],
        weights: [1, 1],
      };
    };
    const value = broadTree(8);

    expect(() => WorkspacePaneTreeNodeSchemaZ.safeParse(value)).not.toThrow();
    expect(WorkspacePaneTreeNodeSchemaZ.safeParse(value).success).toBe(false);
  });

  it("migrates only compatible V2 workbench data without mutating the UI projection", () => {
    const legacy = {
      version: 2,
      active: { viewId: "missions", panel: "missions" },
      dock: {
        activeTab: "missions",
        mode: "maximized",
        preferredHeight: 20,
        focusZone: "dock-body",
      },
      surfaces: { missions: { selectedMissionId: "m-1" } },
      views: { missions: { panel: "missions", layout: { future: true } } },
      futureProjectionField: { preserve: true },
    };
    const before = structuredClone(legacy);
    const migrated = migrateWorkspaceUiStateV2(PROJECT, "checkout-main", "/repo", legacy, NOW);

    expect(legacy).toEqual(before);
    expect(migrated.layouts).toEqual({});
    expect(migrated.checkouts["checkout-main"]).toMatchObject({
      activeLayoutId: null,
      topology: { panes: {}, root: null },
      workbench: {
        canvasPanel: "terminals",
        dock: { activeTab: "missions", mode: "maximized" },
      },
    });
    expect(JSON.stringify(migrated)).not.toContain("futureProjectionField");
    expect(WorkspaceStateV1SchemaZ.safeParse(migrated).success).toBe(true);
  });
});
