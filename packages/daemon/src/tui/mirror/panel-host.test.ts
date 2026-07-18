import { describe, expect, it } from "vitest";
import type { WorkspaceConfigV1, WorkspaceFullPanelView } from "@tmux-ide/contracts";
import {
  CANONICAL_PANEL_VIEWS,
  PanelHostLoadGeneration,
  buildHostedPanelViews,
  findFirstHostedViewForPanel,
  findHostedViewById,
  hostedActivationEffects,
  initialHostedSelection,
  isHostedPanelInert,
  legacyTabFromPanelKind,
  navigateHostedPanel,
  panelCell,
  panelKindFromLegacyTab,
  panelMode,
  panelSpans,
  planHostedInitialActivation,
  planHostedReconciledActivation,
  planHostedViewActivation,
  reconcileHostedSelection,
  shortcutForHostedViewIndex,
  terminalDisplayWidth,
  viewsFromResolvedConfig,
  viewsFromWorkspaceConfig,
} from "./panel-host.ts";

describe("panel-host", () => {
  it("builds canonical fallback views with stable IDs/order/titles/panels and detached output", () => {
    const views = buildHostedPanelViews(null);

    expect(views.map((view) => [view.id, view.order, view.title, view.panel])).toEqual([
      ["home", 0, "Home", "home"],
      ["terminals", 1, "Terminals", "terminals"],
      ["files", 2, "Files", "files"],
      ["diff", 3, "Diff", "diff"],
      ["missions", 4, "Missions", "missions"],
    ]);

    views[0]!.title = "Changed";
    expect(CANONICAL_PANEL_VIEWS[0]!.title).toBe("Home");
    expect(buildHostedPanelViews(null)[0]!.title).toBe("Home");
  });

  it("preserves configured order, custom titles, duplicates, and input immutability", () => {
    const configured: WorkspaceFullPanelView[] = [
      { id: "code", title: "Code", panel: "files" },
      { id: "term-a", panel: "terminals" },
      { id: "term-b", title: "Logs", panel: "terminals" },
      { id: "home-alt", title: "Launchpad", panel: "home" },
    ];
    const before = JSON.stringify(configured);

    const views = buildHostedPanelViews(configured);

    expect(views.map((view) => [view.id, view.title, view.panel])).toEqual([
      ["code", "Code", "files"],
      ["term-a", "Terminals", "terminals"],
      ["term-b", "Logs", "terminals"],
      ["home-alt", "Launchpad", "home"],
    ]);
    expect(JSON.stringify(configured)).toBe(before);
  });

  it("resolves glyphs and skips F5 for the palette in deterministic shortcut order", () => {
    const configured = Array.from(
      { length: 13 },
      (_, index): WorkspaceFullPanelView => ({
        id: `view-${index}`,
        panel: index % 2 === 0 ? "missions" : "diff",
      }),
    );

    const views = buildHostedPanelViews(configured);

    expect(views[0]).toMatchObject({
      title: "Missions",
      glyph: "◆",
      shortcut: { key: "f1", label: "F1" },
    });
    expect(views.map((view) => view.shortcut?.label ?? null)).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
      "F6",
      "F7",
      "F8",
      "F9",
      "F10",
      "F11",
      "F12",
      "F13",
      null,
    ]);
    expect(views.map((view) => view.shortcut?.label)).not.toContain("F5");
    expect(views[12]!.shortcut).toBeNull();
    expect(shortcutForHostedViewIndex(4)).toEqual({ key: "f6", label: "F6" });
  });

  it("selects by ID, first matching panel, and reconciles ID then panel then first view", () => {
    const views = buildHostedPanelViews([
      { id: "files-a", panel: "files" },
      { id: "diff-a", panel: "diff" },
      { id: "files-b", panel: "files" },
    ]);

    expect(findHostedViewById(views, "files-b")?.id).toBe("files-b");
    expect(findFirstHostedViewForPanel(views, "files")?.id).toBe("files-a");
    expect(reconcileHostedSelection(views, { id: "files-b", panel: "diff" })?.id).toBe("files-b");
    expect(reconcileHostedSelection(views, { id: "gone", panel: "diff" })?.id).toBe("diff-a");
    expect(reconcileHostedSelection(views, { id: "gone", panel: "home" })?.id).toBe("files-a");
  });

  it("honors initial selection precedence: explicit panel, persisted panel, first view", () => {
    const views = buildHostedPanelViews([
      { id: "files-a", panel: "files" },
      { id: "mission-a", panel: "missions" },
      { id: "diff-a", panel: "diff" },
    ]);

    expect(initialHostedSelection(views, "diff", "missions")?.id).toBe("diff-a");
    expect(initialHostedSelection(views, "home", "missions")?.id).toBe("mission-a");
    expect(initialHostedSelection(views, "home", "terminals")?.id).toBe("files-a");
  });

  it("uses the same rendered labels for span geometry", () => {
    const views = buildHostedPanelViews([
      { id: "one", title: "One", panel: "home" },
      { id: "two", title: "Two", panel: "diff" },
    ]);

    expect(views.map(panelCell)).toEqual([" ⌂ One ", " ± Two "]);
    expect(panelSpans(views)).toEqual([
      { start: 0, width: " ⌂ One ".length },
      { start: " ⌂ One ".length, width: " ± Two ".length },
    ]);
  });

  it("uses terminal display width for custom Unicode titles in consecutive tab hit spans", () => {
    const views = buildHostedPanelViews([
      { id: "mixed", title: "Pair 👨‍💻", panel: "terminals" },
      { id: "combining", title: "Café", panel: "files" },
      { id: "wide", title: "分析", panel: "diff" },
      { id: "flag", title: "Flag 🇳🇱", panel: "terminals" },
      { id: "keycap", title: "Key 1️⃣", panel: "terminals" },
    ]);

    expect(terminalDisplayWidth("Pair 👨‍💻")).toBe(7);
    expect(terminalDisplayWidth("Café")).toBe(4);
    expect(terminalDisplayWidth("分析")).toBe(4);
    expect(terminalDisplayWidth("Flag 🇳🇱")).toBe(7);
    expect(terminalDisplayWidth("Key 1️⃣")).toBe(6);
    const widths = views.map((view) => terminalDisplayWidth(panelCell(view)));
    expect(widths).toEqual([11, 8, 8, 11, 10]);
    expect(panelSpans(views)).toEqual([
      { start: 0, width: 11 },
      { start: 11, width: 8 },
      { start: 19, width: 8 },
      { start: 27, width: 11 },
      { start: 38, width: 10 },
    ]);
  });

  it("maps workspace, legacy-projected, absent app, and load failure fallback inputs", () => {
    const workspace: WorkspaceConfigV1 = {
      version: 1,
      app: { views: [{ id: "custom", title: "Custom Files", panel: "files" }] },
    };

    expect(viewsFromWorkspaceConfig(workspace).map((view) => view.id)).toEqual(["custom"]);
    expect(viewsFromResolvedConfig({ workspace }).map((view) => view.id)).toEqual(["custom"]);
    expect(viewsFromWorkspaceConfig({ version: 1 }).map((view) => view.id)).toEqual([
      "home",
      "terminals",
      "files",
      "diff",
      "missions",
    ]);
    expect(viewsFromResolvedConfig(null).map((view) => view.id)).toEqual([
      "home",
      "terminals",
      "files",
      "diff",
      "missions",
    ]);
  });

  it("keeps stale async config generations from winning", () => {
    const generations = new PanelHostLoadGeneration();
    const slow = generations.next();
    const fast = generations.next();

    expect(generations.isCurrent(slow)).toBe(false);
    expect(generations.isCurrent(fast)).toBe(true);
  });

  it("returns deterministic no-op navigation when a panel is missing", () => {
    const views = buildHostedPanelViews([{ id: "only-files", panel: "files" }]);

    expect(navigateHostedPanel(views, "only-files", "diff")).toEqual({
      activeViewId: "only-files",
      view: views[0],
      changed: false,
      note: "No configured Diff view",
    });
  });

  it("maps persisted legacy tabs to hosted panels and modes", () => {
    expect(panelKindFromLegacyTab("terminal")).toBe("terminals");
    expect(legacyTabFromPanelKind("terminals")).toBe("terminal");
    expect(legacyTabFromPanelKind("missions")).toBe("home");
    expect(panelMode("terminals")).toBe("mirror");
    expect(panelMode("missions")).toBe("missions");
  });

  it("plans hosted activation side effects without encoding recursive tab switches", () => {
    expect(hostedActivationEffects("files", { filesLoaded: false, diffLoaded: false })).toEqual([
      "load-files",
    ]);
    expect(hostedActivationEffects("files", { filesLoaded: true, diffLoaded: false })).toEqual([
      "catch-up-files",
    ]);
    expect(hostedActivationEffects("diff", { filesLoaded: false, diffLoaded: false })).toEqual([
      "enter-diff",
    ]);
    expect(hostedActivationEffects("diff", { filesLoaded: false, diffLoaded: true })).toEqual([]);
    expect(hostedActivationEffects("terminals", { filesLoaded: false, diffLoaded: false })).toEqual(
      [],
    );
  });

  it("plans direct hosted activation by view ID while preserving duplicate panel identity", () => {
    const views = buildHostedPanelViews([
      { id: "diff-a", title: "Diff A", panel: "diff" },
      { id: "diff-b", title: "Diff B", panel: "diff" },
      { id: "files-b", title: "Files B", panel: "files" },
    ]);

    expect(
      planHostedViewActivation(views, "diff-b", { filesLoaded: false, diffLoaded: false }),
    ).toMatchObject({
      activeViewId: "diff-b",
      view: { id: "diff-b", panel: "diff" },
      effects: ["enter-diff"],
      note: null,
    });
    expect(
      planHostedViewActivation(views, "files-b", { filesLoaded: true, diffLoaded: true }),
    ).toMatchObject({
      activeViewId: "files-b",
      view: { id: "files-b", panel: "files" },
      effects: ["catch-up-files"],
      note: null,
    });
    expect(
      planHostedViewActivation(views, "missing", { filesLoaded: true, diffLoaded: true }),
    ).toEqual({
      activeViewId: null,
      view: null,
      effects: [],
      note: "that view is no longer configured",
    });
  });

  it("plans reload activation only when resolved reconciliation changes panel kind", () => {
    const filesOnly = buildHostedPanelViews([{ id: "configured-files", panel: "files" }]);
    const diffOnly = buildHostedPanelViews([{ id: "configured-diff", panel: "diff" }]);

    expect(
      planHostedReconciledActivation(
        filesOnly,
        { id: "home", panel: "home" },
        { filesLoaded: false, diffLoaded: false },
      ),
    ).toMatchObject({
      activeViewId: "configured-files",
      effects: ["load-files"],
    });
    expect(
      planHostedReconciledActivation(
        diffOnly,
        { id: "home", panel: "home" },
        { filesLoaded: false, diffLoaded: false },
      ),
    ).toMatchObject({
      activeViewId: "configured-diff",
      effects: ["enter-diff"],
    });
    expect(
      planHostedReconciledActivation(
        buildHostedPanelViews([
          { id: "files-a", panel: "files" },
          { id: "files-b", panel: "files" },
        ]),
        { id: "files-gone", panel: "files" },
        { filesLoaded: false, diffLoaded: false },
      ),
    ).toMatchObject({
      activeViewId: "files-a",
      effects: [],
    });
  });

  it("plans first async config load by requested/persisted/first precedence despite fallback ID collisions", () => {
    const views = buildHostedPanelViews([
      { id: "home", title: "Review", panel: "diff" },
      { id: "files-view", title: "Code", panel: "files" },
      { id: "terminal-view", title: "Shell", panel: "terminals" },
    ]);

    expect(
      planHostedInitialActivation(
        views,
        "files",
        "terminals",
        { filesLoaded: false, diffLoaded: false },
        "home",
      ),
    ).toMatchObject({
      activeViewId: "files-view",
      view: { id: "files-view", panel: "files" },
      effects: ["load-files"],
    });
    expect(
      planHostedReconciledActivation(
        views,
        { id: "home", panel: "home" },
        { filesLoaded: false, diffLoaded: false },
      ),
    ).toMatchObject({
      activeViewId: "home",
      view: { id: "home", panel: "diff" },
      effects: ["enter-diff"],
    });
  });

  it("lets persisted panel win on bare-home first load when there is no explicit request", () => {
    const views = buildHostedPanelViews([
      { id: "home", title: "Launchpad", panel: "home" },
      { id: "files-view", title: "Code", panel: "files" },
      { id: "diff-view", title: "Changes", panel: "diff" },
      { id: "term-view", title: "Shell", panel: "terminals" },
    ]);

    expect(
      planHostedInitialActivation(
        views,
        null,
        "files",
        { filesLoaded: false, diffLoaded: false },
        "home",
      ),
    ).toMatchObject({
      activeViewId: "files-view",
      effects: ["load-files"],
    });
    expect(
      planHostedInitialActivation(
        views,
        null,
        "diff",
        { filesLoaded: true, diffLoaded: false },
        "home",
      ),
    ).toMatchObject({
      activeViewId: "diff-view",
      effects: ["enter-diff"],
    });
    expect(
      planHostedInitialActivation(
        views,
        null,
        "terminals",
        { filesLoaded: true, diffLoaded: true },
        "home",
      ),
    ).toMatchObject({
      activeViewId: "term-view",
      effects: [],
    });
  });

  it("keeps Missions first-class but inert to hidden terminal panes", () => {
    expect(panelMode("missions")).toBe("missions");
    expect(isHostedPanelInert("missions")).toBe(true);
    expect(isHostedPanelInert("terminals")).toBe(false);
  });
});
