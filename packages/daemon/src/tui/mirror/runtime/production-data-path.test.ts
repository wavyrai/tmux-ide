import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLocalSourceImportGraph } from "../../../../test-support/source-import-graph.ts";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "../../../../test-support/opentui-production-root-manifest.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const productionGraph = await loadLocalSourceImportGraph(repoRoot, OPENTUI_PRODUCTION_ROOT_SOURCES);
const source = productionGraph.files
  .map(
    (path) => productionGraph.sourceByFile.get(path) ?? readFileSync(join(repoRoot, path), "utf8"),
  )
  .join("\n");
const applicationRootSource = readFileSync(
  join(repoRoot, "packages/daemon/src/tui/mirror/runtime/application-root.tsx"),
  "utf8",
);

describe("production OpenTUI data path", () => {
  it("keeps tmux mutation behind daemon authority except host-local client and clipboard setup", () => {
    const directTmuxCalls = applicationRootSource.match(/execFile\("tmux"/gu) ?? [];
    expect(directTmuxCalls).toHaveLength(4);
    expect(applicationRootSource).toContain('["switch-client", "-l"]');
    expect(applicationRootSource).toContain('["detach-client"]');
    expect(applicationRootSource).toContain('["set-option", "-gq", "set-clipboard", "on"]');
    expect(applicationRootSource).toContain('["set-option", "-gq", "allow-passthrough", "on"]');
    expect(applicationRootSource).not.toContain('"#{pane_current_path}"');
    expect(applicationRootSource).not.toContain('"@agent_launch"');
    expect(applicationRootSource).toContain("provisionFleetAgent({");
  });

  it("contains no recurring catalog work or legacy direct observation path", () => {
    const forbiddenPaths: ReadonlyArray<{
      readonly text: string;
      readonly compatibilityDefinitions?: readonly string[];
    }> = [
      { text: "setInterval(" },
      { text: 'team", "--json' },
      {
        text: "readMissionWorkspace",
        compatibilityDefinitions: [
          "packages/daemon/src/tui/mirror/legacy/missions-workspace-loader.ts",
        ],
      },
      {
        text: "MissionRepository",
        compatibilityDefinitions: [
          "packages/daemon/src/tui/mirror/legacy/missions-workspace-loader.ts",
          "packages/daemon/src/lib/mission-repository.ts",
        ],
      },
      { text: "watchDirectory" },
      { text: "filesStatusPoll" },
      { text: "fleetTimer" },
      { text: "diffTimer" },
      { text: "fleetRefresh" },
    ];
    for (const { text, compatibilityDefinitions = [] } of forbiddenPaths) {
      const offenders = productionGraph.files.filter(
        (path) =>
          !compatibilityDefinitions.includes(path) &&
          productionGraph.sourceByFile.get(path)?.includes(text),
      );
      expect(offenders, `production graph contains executable ${text}`).toEqual([]);
    }
  });

  it("follows literal dynamic imports through optional feature roots", () => {
    expect(productionGraph.files).toEqual(
      expect.arrayContaining([
        "packages/daemon/src/tui/mirror/runtime/application-entry.ts",
        "packages/daemon/src/tui/mirror/runtime/application-root.tsx",
        "packages/daemon/src/tui/mirror/runtime/application-optional-features.ts",
        "packages/daemon/src/tui/mirror/features/changes/feature.tsx",
        "packages/daemon/src/tui/mirror/features/missions-activity/feature.tsx",
        "packages/daemon/src/tui/mirror/features/dialogs/feature.tsx",
        "packages/daemon/src/tui/mirror/features/settings/feature.ts",
        "packages/daemon/src/tui/mirror/files-surface-view.tsx",
        "packages/daemon/src/tui/mirror/changes-surface-view.tsx",
        "packages/daemon/src/tui/mirror/missions-surface.tsx",
        "packages/daemon/src/tui/mirror/activity-surface-view.tsx",
        "packages/daemon/src/tui/mirror/workspace/command-palette-surface-view.tsx",
        "packages/daemon/src/tui/mirror/widget-surface.tsx",
      ]),
    );
  });

  it("publishes input readiness before admitting daemon tool demand", () => {
    const readiness = source.indexOf('publishTuiInputReady("app")');
    const demand = source.indexOf("publishToolReadiness()", readiness);
    expect(readiness).toBeGreaterThan(0);
    expect(demand).toBeGreaterThan(readiness);
  });

  it("cuts production through the lifecycle bootstrap, terminal adapter, and local view owner", () => {
    expect(source).toContain("await startTuiApplication");
    expect(source).toContain('await import("./application-root.tsx")');
    expect(source).toContain("new TuiApplicationLifecycle");
    expect(source).toContain("new OpenTuiTerminalWorkspaceAdapter");
    expect(source).toContain("new OpenTuiLocalViewController");
    expect(source).toContain('applicationLifecycle.registerCloser("tool-resources"');
    expect(source).toContain('applicationLifecycle.registerCloser("local-view"');
    expect(source).toContain('applicationLifecycle.registerCloser("terminal-workspace"');
    expect(source).toContain("adapter.renderSource");
    expect(source).toContain("replica.adapter.sendText");
    expect(source).toContain("terminalWorkspaceAdapter?.fitViewport");
  });

  it("fences tool projections by generation and applies same-millisecond resources by identity", () => {
    expect(source).toContain("state.generation !== toolResourceGeneration");
    expect(source).toContain("appliedToolSnapshots.clear()");
    expect(source).toContain("filesSession()?.resetCatalog()");
    expect(source).toContain("changesSession()?.reset()");
    expect(source).toContain("slot.resource.kind) !== slot.resource");
    expect(source).not.toContain("slot.resource.kind) !== slot.updatedAt");
  });

  it("admits targeted tool demand only after geometry and a committed native frame", () => {
    expect(source).toContain("runtimeLaneFitKey = fitKey");
    expect(source).toContain('appRenderer.on("frame", acknowledgeTerminalFramePublication)');
    expect(source).toContain("terminalToolReadiness.observeTerminalFrameCommitted()");
    expect(source).toContain('tuiPerfMark("first-terminal-frame")');
    expect(source).not.toContain('tuiPerfMark("tmux-geometry-ready")');
    expect(source).not.toContain("terminalToolReadiness.observeTerminalRender()");
    expect(source).toContain("toolResources.markCatalogReady()");
  });

  it("keeps the last drawable terminal projection through an atomic replacement handoff", () => {
    expect(source).toContain("new TerminalSessionHandoff(");
    expect(source).toContain("terminalSessionHandoff.observeInventory(");
    expect(source).toContain("terminalSessionHandoff.observeCurrentLayout(");
    expect(source).toContain("terminalSessionHandoff.observeFrameCommitted(");
    expect(source).toContain("presentedTerminalWorkspaceAdapter");
    expect(source).toContain("retiringTerminalWorkspaceAdapter =");
    expect(source).toContain("retireSessionRuntimeLane()");

    const attachStart = source.indexOf("const attach = (name: string) =>");
    const attachEnd = source.indexOf("createEffect(() =>", attachStart);
    const attachSource = source.slice(attachStart, attachEnd);
    expect(attachSource).not.toContain("setPanes([])");
    expect(attachSource).not.toContain("scrollOffsets.clear()");
    expect(attachSource).not.toContain("setFocusedPaneId(null)");
  });

  it("publishes terminal content through pane-scoped owners instead of root map clones", () => {
    expect(source).toContain("new PaneScopedTerminalOwner()");
    expect(source).toContain("candidateAdapter?.publishPaneVersion(");
    expect(source).toContain("<PaneScopedTerminalSurface");
    expect(source).not.toContain("semanticPaneVersions");
    expect(source).not.toContain("setSemanticPaneVersions");
    expect(source).not.toContain("pendingSemanticPaneVersions");
  });

  it("uses explicit daemon authority and atomic workspace handoff in the production host", () => {
    expect(source).toContain('appRenderer.on("focus", foregroundTerminalHost)');
    expect(source).toContain('appRenderer.on("blur", backgroundTerminalHost)');
    expect(source).toContain('lane.requestAuthority("input")');
    expect(source).toContain('lane.releaseAuthority("geometry")');
    expect(source).toContain("onAuthoritySnapshot: (snapshot)");
    expect(source).toContain("runtimeOwnsInput()");
    expect(source).toContain("dispatchTerminalInputWithAuthority({");
    expect(source).toContain("workspaceOpenHandoff.prepare({");
    expect(source).toMatch(/workspaceOpenHandoff\s*\.commit\(pending\.prepared\)/);
    expect(source).toContain("workspaceOpenHandoff.cancelCurrent()");
    expect(source).toContain("presentedTerminalWorkspaceAdapter = retired");
    expect(source).not.toContain("if (!sessionId) {\n        switchTarget(session);");
    expect(source).not.toContain('execFileChecked("tmux"');
    expect(source).not.toContain("setCurTarget(intent.session)");
  });

  it("keeps retained handoff presentation passive until its live authority lane exists", () => {
    const replicaProjection = source.slice(
      source.indexOf("const semanticReplicaForRuntime ="),
      source.indexOf("const retireSessionRuntimeLane ="),
    );
    expect(replicaProjection.indexOf("sessionRuntimeLane();")).toBeGreaterThanOrEqual(0);
    expect(replicaProjection.indexOf("sessionRuntimeLane();")).toBeLessThan(
      replicaProjection.indexOf("const lane = adapter.lane;"),
    );
    expect(source).toContain("const lane = adapter.lane;");
    expect(source).toContain("if (!lane) return null;");
    expect(source).toContain("return { adapter, lane, semanticPaneId };");
  });

  it("owns optional feature admission and metrics inside the application lifecycle", () => {
    expect(source).toContain("createApplicationOptionalFeatureRegistry()");
    expect(source).toContain('applicationLifecycle.registerCloser("optional-features"');
    expect(source).toContain('tuiPerfMark("optional-feature-metrics"');
    expect(source).toContain("optionalFeatures.dispose()");
    // Terminal-frame and configless-catalog readiness converge on one
    // idempotent lifecycle transition; call sites must not admit features
    // independently as bootstrap/recovery branches multiply.
    expect(source).toContain("const admitOptionalFeatures = () =>");
    expect(source).toContain("new TerminalToolReadinessGate(");
    expect(source).toContain("terminalToolReadiness.observeCatalogReady()");
    expect(source.match(/optionalFeatures\.admit\(\)/gu)).toHaveLength(1);
  });

  it("uses daemon identity and presence instead of a parallel root tmux probe", () => {
    expect(applicationRootSource).not.toContain('"list-panes", "-s", "-t", `=${sessionName}`');
    expect(applicationRootSource).not.toContain("SESSION_PANE_DESCRIPTOR_FORMAT");
    expect(applicationRootSource).not.toContain("candidate.setRuntimeDescriptors(");
    expect(applicationRootSource).not.toContain("candidate.setRuntimeAuthorityGeneration(");
    expect(applicationRootSource).not.toContain("refreshLocalRuntimeDescriptors(");
    expect(applicationRootSource).not.toContain("parseSessionPaneDescriptors(");
    expect(applicationRootSource).not.toContain("APP_FOCUS_OPTION");
    expect(applicationRootSource).not.toContain("APP_JUMP_OPTION");
    expect(applicationRootSource).not.toContain('"list-clients", "-t"');
    expect(applicationRootSource.match(/switchTarget\(/gu)).toHaveLength(1);
    expect(source).toContain('lane.setPresence("foreground")');
    expect(source).toContain('lane.setPresence("background")');
    expect(source).toContain("candidate.retireRuntimeAuthority()");
    expect(source).toContain("projectAuthoritativeAgentRows");
  });

  it("keeps named-session and existing-agent lifecycle off direct tmux", () => {
    expect(source).not.toContain('execFile("tmux", ["new-session"');
    expect(source).not.toContain('execFile("tmux", ["kill-pane"');
    expect(source).not.toContain('execFile("tmux", interruptArgs');
    expect(source).toContain("createFleetSession({");
    expect(source).toContain("mutateFleetAgent({");
  });

  it("releases tools only when the dock collapses", () => {
    expect(source).toContain('dockMode() === "collapsed"');
    expect(source).toContain("toolResources.setOpenDock(null)");
  });
});
