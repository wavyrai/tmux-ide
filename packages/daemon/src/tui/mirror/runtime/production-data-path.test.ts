import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLocalSourceImportGraph } from "../../../../test-support/source-import-graph.ts";
import { OPENTUI_PRODUCTION_ROOT_SOURCES } from "./production-root-manifest.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const productionGraph = await loadLocalSourceImportGraph(repoRoot, OPENTUI_PRODUCTION_ROOT_SOURCES);
const source = productionGraph.files
  .map(
    (path) => productionGraph.sourceByFile.get(path) ?? readFileSync(join(repoRoot, path), "utf8"),
  )
  .join("\n");

describe("production OpenTUI data path", () => {
  it("contains no recurring catalog work or legacy direct observation path", () => {
    const forbiddenPaths: ReadonlyArray<{
      readonly text: string;
      readonly compatibilityDefinitions?: readonly string[];
    }> = [
      { text: "setInterval(" },
      { text: 'team", "--json' },
      {
        text: "readMissionWorkspace",
        compatibilityDefinitions: ["packages/daemon/src/tui/mirror/missions-workspace.ts"],
      },
      {
        text: "MissionRepository",
        compatibilityDefinitions: [
          "packages/daemon/src/tui/mirror/missions-workspace.ts",
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
        "packages/daemon/src/tui/mirror/files-surface.tsx",
        "packages/daemon/src/tui/mirror/changes-surface.tsx",
        "packages/daemon/src/tui/mirror/missions-surface.tsx",
        "packages/daemon/src/tui/mirror/activity-surface.tsx",
        "packages/daemon/src/tui/mirror/workspace/command-palette-surface.tsx",
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
    expect(source).toContain("state.generation !== appliedToolGeneration");
    expect(source).toContain("appliedToolSnapshots.clear()");
    expect(source).toContain("filesSession()?.resetCatalog()");
    expect(source).toContain("setDiffEntries([])");
    expect(source).toContain("slot.resource.kind) !== slot.resource");
    expect(source).not.toContain("slot.resource.kind) !== slot.updatedAt");
  });

  it("admits targeted tool demand only after geometry and a committed native frame", () => {
    expect(source).toContain("runtimeLaneFitKey = fitKey");
    expect(source).toContain('appRenderer.on("frame", acknowledgeTerminalFramePublication)');
    expect(source).toContain("terminalToolReadiness.observeTerminalFrameCommitted()");
    expect(source).not.toContain("terminalToolReadiness.observeTerminalRender()");
    expect(source).toContain("toolResources.markCatalogReady()");
  });

  it("owns optional feature admission and metrics inside the application lifecycle", () => {
    expect(source).toContain("createApplicationOptionalFeatureRegistry()");
    expect(source).toContain('applicationLifecycle.registerCloser("optional-features"');
    expect(source).toContain('tuiPerfMark("optional-feature-metrics"');
    expect(source).toContain("optionalFeatures.dispose()");
    expect(source.match(/optionalFeatures\.admit\(\)/gu)).toHaveLength(2);
  });

  it("builds actionable agent rows from generation-bound local tmux identity proof", () => {
    expect(source).toContain('"list-panes", "-s", "-t", `=${sessionName}`');
    expect(source).toContain("SESSION_PANE_DESCRIPTOR_FORMAT");
    expect(source).toContain("candidate.setRuntimeDescriptors(");
    expect(source).toContain("candidate.setRuntimeAuthorityGeneration(authorityGeneration)");
    expect(source).toContain("candidate.retireRuntimeAuthority()");
    expect(source).toContain(
      "refreshLocalRuntimeDescriptors(sessionName, candidate, authorityGeneration)",
    );
    expect(source).toContain("parseSessionPaneDescriptors(stdout.trimEnd().split");
    expect(source).toContain("projectAuthoritativeAgentRows");
  });

  it("releases tools only when the dock collapses", () => {
    expect(source).toContain('dockMode() === "collapsed"');
    expect(source).toContain("toolResources.setOpenDock(null)");
  });
});
