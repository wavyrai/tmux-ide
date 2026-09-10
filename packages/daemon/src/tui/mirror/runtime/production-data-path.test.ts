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
const PURE_PRESENTATION_MODULE =
  /packages\/daemon\/src\/tui\/mirror\/(?:ui\/|workspace\/|shell-chrome-view\.tsx$|runtime\/application-(?:shell-(?:catalog|home|overlay-stack|overlays|sidebar)|machine-sidebar|add-machine-dialog)\.tsx$)/u;

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

const RAW_RENDER_COLOR = /RGBA\.fromInts\(|#[0-9a-fA-F]{6}\b|\b0x[0-9a-fA-F]{6}\b|colour[0-9]+/u;
const DESIGN_SYSTEM_COLOR_OWNERS = [
  // User-facing semantic defaults; not a rendered surface.
  "packages/daemon/src/lib/app-config.ts",
  // Native renderable constructor safety before semantic props arrive.
  "packages/daemon/src/tui/mirror/pane-surface.tsx",
  // The sole OpenTUI token/palette projection boundary.
  "packages/daemon/src/tui/mirror/theme.ts",
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
    // Home may label observed pane activity; the retired ActivitySurface and its
    // feature module remain forbidden by the constructor/import checks above.
    expect(source).not.toMatch(/\b(?:Missions|Files|Changes)\b/u);
  });

  it("keeps raw colors out of every production app-owned surface", () => {
    const owners = productionGraph.files.filter((path) =>
      RAW_RENDER_COLOR.test(productionGraph.sourceByFile.get(path) ?? ""),
    );
    expect(owners).toEqual([...DESIGN_SYSTEM_COLOR_OWNERS].sort());
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

  it("owns keyboard and paste ingress exactly once at the application root", () => {
    expect(occurrences(/\buseKeyboard\s*\(/gu)).toBe(1);
    expect(occurrences(/\busePaste\s*\(/gu)).toBe(1);
    expect(applicationRootSource).toContain("createKeyboardRouteOwner()");
    expect(applicationRootSource).toContain("componentKeyboardRoutes.route(event)");
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
      "packages/daemon/src/tui/mirror/runtime/terminal-copy-cursor.ts",
      "packages/daemon/src/tui/mirror/runtime/terminal-copy-selection.ts",
      "packages/daemon/src/tui/mirror/runtime/terminal-links.ts",
      "packages/daemon/src/tui/mirror/runtime/terminal-selection-units.ts",
      "packages/daemon/src/tui/mirror/runtime/application-shell-view.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-machine-sidebar.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-add-machine-dialog.tsx",
      "packages/daemon/src/tui/mirror/runtime/application-terminal-workspace.tsx",
      "packages/daemon/src/tui/mirror/runtime/pane-scoped-terminal-surface.tsx",
      "packages/daemon/src/tui/mirror/workspace/application-shell-view.tsx",
      "packages/daemon/src/tui/mirror/shell-chrome-view.tsx",
    ]) {
      const renderer = productionGraph.sourceByFile.get(path);
      expect(renderer, `production graph is missing pure renderer ${path}`).toBeDefined();
      expect(renderer).not.toMatch(
        /(?:from\s+|import\s*\()["'](?:node:|[^"']*(?:canonical-daemon|daemon-transport|tmux-bridge|application-machine-authority|application-daemon-authority))/u,
      );
      expect(renderer).not.toMatch(/\b(?:useKeyboard|usePaste|createCliRenderer)\b/u);
    }
  });

  it("retires the active workspace before selecting another machine", () => {
    const navigation = productionGraph.sourceByFile.get(
      "packages/daemon/src/tui/mirror/runtime/application-machine-navigation.ts",
    )!;
    expect(navigation).toBeDefined();
    const select = navigation.slice(
      navigation.indexOf("const select ="),
      navigation.indexOf("const open ="),
    );
    expect(select.indexOf("options.cancelOpen()")).toBeGreaterThanOrEqual(0);
    expect(select.indexOf("options.cancelOpen()")).toBeLessThan(
      select.indexOf("options.resetWorkspace(id"),
    );
    expect(select.indexOf("options.resetWorkspace(id")).toBeLessThan(
      select.indexOf("manager.select(id)"),
    );
    expect(applicationRootSource).toContain("createApplicationMachineNavigation({");
    const reset = applicationRootSource.slice(
      applicationRootSource.indexOf("resetWorkspace(machineId, expectedLiveSessionId) {"),
      applicationRootSource.indexOf("cancelOpen: () => {"),
    );
    expect(reset.indexOf("sessionOwner?.dispose()")).toBeGreaterThanOrEqual(0);
    expect(reset.indexOf("sessionOwner?.dispose()")).toBeLessThan(
      reset.indexOf("sessionOwner = makeSessionOwner(machineId, expectedLiveSessionId)"),
    );
    expect(applicationRootSource).toContain("if (ownedEpoch !== sessionOwnerEpoch) return;");
  });

  it("keeps the production root reviewable as a small renderer client", () => {
    // Includes the one root-owned keyboard/paste ingress and the three-line
    // composition seam for shared receipt presence, copy feedback, and link/activity callbacks
    // and the renderer-destroyed callback into the existing lifecycle (no new transport owner).
    // Two additional composition lines separate lifecycle logging from explicit
    // performance diagnostics; decoding and log policy remain outside this root.
    // Ten SSH composition lines attach authority disposal, identify the selected machine,
    // and hide local-only creation. Transport, reconnect, and identity policy remain in their owner.
    // Machine navigation adds workspace-owner retirement/recreation, keyboard focus,
    // and the Add machine dialog composition. Per-machine discovery, catalog polling,
    // reconnect and profile parsing stay in the separately bounded owners below.
    // Four additional lines route focused input and absorb rejection when retiring
    // late initial connection preparation; they add no discovery or transport owner.
    // One admission callback cancels initial auto-open after explicit machine navigation.
    // Machine-scoped agent navigation composes cancellation and exact-target input admission.
    expect(applicationRootSource.trim().split(/\r?\n/u).length).toBeLessThanOrEqual(640);
    // Component leaves are reviewable presentation modules, not authority/data-path
    // owners. Their import boundary is enforced by production-design-system-contract;
    // retain the original budget for the runtime and authority graph itself.
    const authorityDataPathFiles = productionGraph.files.filter(
      (path) => !PURE_PRESENTATION_MODULE.test(path),
    );
    // Includes two pure copy-coordinate/extraction helpers, checked above for
    // host IO and ingress ownership. No new daemon or transport owner is added.
    const nativeIntegration = [
      "packages/daemon/src/terminal/protocol/native-backing-client.ts",
      "packages/daemon/src/terminal/mirror/native-grid-capture.ts",
      "packages/daemon/src/terminal/mirror/native-grid-projection.ts",
      "packages/daemon/src/terminal/mirror/native-grid-reflow.ts",
      "packages/daemon/src/terminal/mirror/native-frozen-grid.ts",
      "packages/daemon/src/tui/mirror/runtime/application-pane-activity-owner.ts",
    ];
    // Bounded physical-grid transport and reflow are renderer-neutral helpers.
    // Keep these explicit and retain a fixed bound on the complete runtime graph;
    // the singular replica/transport ownership checks above remain unchanged.
    for (const path of nativeIntegration) expect(authorityDataPathFiles).toContain(path);
    // Local rendering helpers own ANSI compaction, stdout delivery, and bounded
    // clean-row projection reuse.
    // They must not acquire daemon, replica or tmux authority of their own.
    for (const name of [
      "renderer-frame-optimizer",
      "renderer-output-transport",
      "terminal-row-projection-cache",
    ]) {
      const path = `packages/daemon/src/tui/mirror/runtime/${name}.ts`;
      expect(authorityDataPathFiles).toContain(path);
      expect(productionGraph.sourceByFile.get(path)).not.toMatch(
        /(?:from\s+|import\s*\()["'][^"']*(?:daemon-client|canonical-daemon|daemon-transport|tmux-bridge|replica)/u,
      );
    }
    // Two pure pointer helpers and one explicit host URL opener add no stream,
    // replica, polling or daemon owner. The row cache above adds one pure
    // rendering module; keep its cost visible in this bound.
    // The selected-authority facade now delegates to a machine registry. The six
    // additional non-presentation modules are the extracted single-machine owner,
    // registry, catalog, navigation, startup parsing, and existing saved-profile reader.
    // Inactive machines own catalog/connection state, never terminal replicas.
    expect(authorityDataPathFiles).toContain(
      "packages/daemon/src/tui/mirror/runtime/application-daemon-authority.ts",
    );
    expect(authorityDataPathFiles).toContain("packages/daemon/src/lib/ssh-daemon-transport.ts");
    for (const name of [
      "application-daemon-authority-owner",
      "application-machine-authority",
      "application-machine-catalog",
      "application-machine-navigation",
      "application-machine-startup",
    ]) {
      const path = `packages/daemon/src/tui/mirror/runtime/${name}.ts`;
      expect(authorityDataPathFiles).toContain(path);
      expect(productionGraph.sourceByFile.get(path)).not.toMatch(
        /\b(?:createWorkspaceClient|createTerminalFastLane|createOpenTuiSessionOwner|TerminalFastLaneRendererAdapter)\s*\(/u,
      );
    }
    expect(authorityDataPathFiles).toContain("packages/daemon/src/lib/saved-machines.ts");
    // Includes the background machine agent roster and its fenced navigation adapter.
    // Four local fleet persistence modules add owner-fenced cache and profile writes.
    // Preview request owner, bounded tab targets and fixed-route connection adapter.
    expect(authorityDataPathFiles.length).toBeLessThanOrEqual(142);
  });
});
