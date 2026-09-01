import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLocalSourceImportGraph } from "../../../../test-support/source-import-graph.ts";
import {
  OPENTUI_PRODUCTION_APPLICATION_ROOT,
  OPENTUI_PRODUCTION_ROOT_SOURCES,
  OPENTUI_REQUIRED_PRODUCTION_MODULES,
  OPENTUI_RETIRED_PRODUCTION_MODULES,
} from "../../../../test-support/opentui-production-root-manifest.ts";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const productionGraph = await loadLocalSourceImportGraph(repoRoot, OPENTUI_PRODUCTION_ROOT_SOURCES);
const productionFiles = new Set(productionGraph.files);
const source = productionGraph.files
  .map(
    (path) => productionGraph.sourceByFile.get(path) ?? readFileSync(join(repoRoot, path), "utf8"),
  )
  .join("\n");
const applicationRootSource =
  productionGraph.sourceByFile.get(OPENTUI_PRODUCTION_APPLICATION_ROOT) ??
  readFileSync(join(repoRoot, OPENTUI_PRODUCTION_APPLICATION_ROOT), "utf8");
const terminalRendererSourcesPath =
  "packages/daemon/src/tui/mirror/runtime/application-terminal-renderer-sources.ts";

const RETIRED_FEATURE_PATHS = [
  /\/runtime\/application-optional-features\.ts$/u,
  /\/runtime\/(?:optional-feature-registry|tool-resource-(?:controller|projection)|terminal-tool-readiness)\.ts$/u,
  /\/features\//u,
  /\/(?:files|changes|missions|activity)-surface(?:-view)?\.tsx?$/u,
  /\/workspace\/agent-terminal-canvas(?:-view)?\.tsx?$/u,
  /\/widget-(?:fallback|surface|surface-model)\.tsx?$/u,
] as const;

const RETIRED_CONSTRUCTORS = [
  "connectOpenTuiApplicationShellAuthority(",
  "createApplicationShellSession(",
  "connectOpenTuiSessionRuntime(",
  "new OpenTuiTerminalWorkspaceAdapter(",
  "new PaneScopedTerminalOwner(",
  "dispatchTerminalInputWithAuthority(",
  "new OpenTuiWorkspaceHandoffClient(",
  "createApplicationOptionalFeatureRegistry(",
  "new OptionalFeatureRegistry(",
  "new ToolResourceController(",
  "<WidgetSurface",
  "<FilesSurface",
  "<ChangesSurface",
  "<MissionsSurface",
  "<ActivitySurface",
] as const;

function occurrences(pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe("production OpenTUI v2 data path", () => {
  it("boots the v2 root and never reaches the retired production stack", () => {
    for (const required of OPENTUI_REQUIRED_PRODUCTION_MODULES) {
      expect(productionFiles.has(required), `production graph is missing ${required}`).toBe(true);
    }
    for (const retired of OPENTUI_RETIRED_PRODUCTION_MODULES) {
      expect(productionFiles.has(retired), `production graph still reaches ${retired}`).toBe(false);
    }
    const featureDebt = productionGraph.files.filter((path) =>
      RETIRED_FEATURE_PATHS.some((pattern) => pattern.test(path)),
    );
    expect(featureDebt).toEqual([]);
  });

  it("contains no executable reference to a retired authority, replica, handoff, or tool owner", () => {
    for (const constructor of RETIRED_CONSTRUCTORS) {
      expect(source.includes(constructor), `production graph still references ${constructor}`).toBe(
        false,
      );
    }
    expect(source).not.toMatch(/\b(?:Missions|Activity|Files|Changes)\b/u);
  });

  it("constructs exactly one WorkspaceClient and one TerminalFastLane owner", () => {
    expect(occurrences(/\bcreateWorkspaceClient\s*\(/gu)).toBe(1);
    expect(occurrences(/\bcreateTerminalFastLane\s*\(/gu)).toBe(1);
    expect(source).toContain("new TerminalFastLaneRendererAdapter(");
    expect(source).toContain("<PaneScopedTerminalSurface");
  });

  it("stages candidate interests before prepare and trims only at atomic activation", () => {
    const generationHost = productionGraph.sourceByFile.get(
      "packages/daemon/src/tui/mirror/runtime/open-tui-generation-host.ts",
    )!;
    const productionBundleStart = generationHost.indexOf("function buildProductionBundle(");
    const connectStart = generationHost.indexOf("connectRuntime:", productionBundleStart);
    const connectBlock = generationHost.slice(
      connectStart,
      generationHost.indexOf("didActivateRuntime:", connectStart),
    );
    const activationStart = generationHost.indexOf(
      "didActivateRuntime: (runtime, inventory)",
      productionBundleStart,
    );
    const activationBlock = generationHost.slice(
      activationStart,
      generationHost.indexOf("didRetireRuntime:", activationStart),
    );
    expect(connectBlock).not.toContain("retainPanes(");
    expect(connectBlock).toContain("stagePanes(inventory.semanticPaneIds)");
    expect(connectBlock.indexOf("stagePanes(")).toBeLessThan(
      connectBlock.indexOf("connectOpenTuiWorkspaceRuntimePort("),
    );
    expect(activationBlock).toContain("retainPanes(inventory.semanticPaneIds)");
    expect(activationBlock.indexOf("retainPanes(")).toBeLessThan(
      activationBlock.indexOf("releaseStage?.()"),
    );
  });

  it("does not couple viewport fitting to terminal layout publications", () => {
    const terminalInputIngress = productionGraph.sourceByFile.get(
      "packages/daemon/src/tui/mirror/runtime/application-terminal-input-ingress.ts",
    )!;
    expect(applicationRootSource).not.toContain("layoutSnapshot();");
    expect(terminalInputIngress).toContain('active?.status === "live"');
    expect(terminalInputIngress).not.toContain("layoutSnapshot");
  });

  it("gates application-mouse ingress diagnostics before the workspace clock boundary", () => {
    expect(applicationRootSource).toMatch(
      /const applicationMouseIngress = applicationMousePointerIngressCapability\(\s*tuiPerfStream,\s*selectionOwner\.beginPointerIngress,\s*\)/u,
    );
    expect(applicationRootSource).toContain(
      "onApplicationMousePointerIngress={focusedApplicationMouseIngress}",
    );
    expect(applicationRootSource).toMatch(
      /const focusedApplicationMouseIngress = recoverHostFocus\.optional\(applicationMouseIngress\)/u,
    );
    expect(applicationRootSource).not.toContain(
      "onApplicationMousePointerIngress={selectionOwner.beginPointerIngress}",
    );
  });

  it("keeps the coherent terminal renderer resident while authority rebinds", () => {
    const owners = productionGraph.files.filter((path) => path === terminalRendererSourcesPath);
    expect(owners).toEqual([terminalRendererSourcesPath]);
    const rendererSources = productionGraph.sourceByFile.get(terminalRendererSourcesPath);
    expect(rendererSources).toMatch(
      /active\?\.adapter\s*&&\s*\(active\.status\s*===\s*["']live["']\s*\|\|\s*active\.status\s*===\s*["']rebinding["']\)/u,
    );
    expect(
      applicationRootSource.match(/createApplicationTerminalRendererSources\(generation\)/gu),
    ).toHaveLength(1);
    expect(applicationRootSource).not.toMatch(
      /active\?\.adapter\s*&&\s*\(active\.status\s*===\s*["']live["']\s*\|\|\s*active\.status\s*===\s*["']rebinding["']\)/u,
    );
  });

  it("keeps renderer startup and shutdown behind the lifecycle bootstrap", () => {
    expect(source).toContain("await startTuiApplication");
    expect(source).toContain("new TuiApplicationLifecycle");
    expect(source).toContain("renderer.destroy()");
    expect(source).not.toContain("process.exit(");
  });

  it("keeps renderer-local tmux calls isolated to clipboard policy", () => {
    const directTmuxOwners = productionGraph.files.filter((path) =>
      productionGraph.sourceByFile.get(path)?.match(/execFile\(\s*["']tmux["']/u),
    );
    expect(directTmuxOwners).toEqual([
      "packages/daemon/src/tui/mirror/runtime/host-local-tmux-adapter.ts",
    ]);
    const adapterSource = productionGraph.sourceByFile.get(directTmuxOwners[0]!)!;
    expect(adapterSource).toContain('["set-option", "-gq", "set-clipboard", "on"]');
    expect(adapterSource).toContain('["set-option", "-gq", "allow-passthrough", "on"]');
    expect(adapterSource).not.toMatch(
      /(?:switch|detach)-client|(?:select|resize|new|kill)-(?:pane|window|session)/u,
    );
  });

  it("keeps pure renderer composition free of host IO and authority owners", () => {
    for (const path of [
      "packages/daemon/src/tui/mirror/runtime/application-shell-view.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-terminal-workspace.tsx",
      "packages/daemon/src/tui/mirror/runtime/pane-scoped-terminal-surface.tsx",
      "packages/daemon/src/tui/mirror/workspace/application-shell-view.tsx",
      "packages/daemon/src/tui/mirror/shell-chrome-view.tsx",
    ]) {
      const renderer = productionGraph.sourceByFile.get(path);
      expect(renderer, `production graph is missing pure renderer ${path}`).toBeDefined();
      expect(renderer).not.toMatch(
        /(?:from\s+|import\s*\()["'](?:node:|[^"']*(?:canonical-daemon|daemon-transport|tmux-bridge))/u,
      );
      expect(renderer).not.toMatch(/\b(?:useKeyboard|usePaste|createCliRenderer)\b/u);
    }
  });

  it("keeps the production root reviewable as a small renderer client", () => {
    expect(applicationRootSource.trim().split(/\r?\n/u).length).toBeLessThanOrEqual(500);
    // The explicit ui/* primitive layer adds one small module per component family.
    // Keep enough headroom for that reviewable structure without admitting the
    // retired feature/surface graph guarded above.
    expect(productionGraph.files.length).toBeLessThan(110);
  });
});
