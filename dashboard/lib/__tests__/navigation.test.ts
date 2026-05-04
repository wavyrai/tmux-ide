import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetNavigationForTests,
  activateTab,
  activeSessionName,
  activeSkillName,
  activeView,
  closeTab,
  defaultTerminalTabId,
  ensureDefaultTerminal,
  getNavigationLive,
  getNavigationStateLive,
  isOverview,
  isSessions,
  isSettings,
  isSkills,
  openTab,
  openTerminalTab,
  pathFromState,
  reorderTabs,
  setActiveSession,
  setNavigation,
  settingsTab,
  skillTab,
  stateFromPath,
  terminalTab,
  viewTab,
  type LegacyNavigationState,
  type NavigationState,
} from "../navigation";

beforeEach(() => {
  window.localStorage.clear();
  __resetNavigationForTests({ type: "overview" });
});

describe("type guards on NavigationState", () => {
  it("isOverview when no session and no active tab", () => {
    const state: NavigationState = { sessionName: null, openTabs: [], activeTabId: null };
    expect(isOverview(state)).toBe(true);
    expect(isSessions(state)).toBe(false);
    expect(isSkills(state)).toBe(false);
    expect(isSettings(state)).toBe(false);
  });

  it("isSettings when active tab kind is settings", () => {
    const tab = settingsTab();
    const state: NavigationState = {
      sessionName: null,
      openTabs: [tab],
      activeTabId: tab.id,
    };
    expect(isSettings(state)).toBe(true);
    expect(isOverview(state)).toBe(false);
    expect(isSessions(state)).toBe(false);
  });

  it("isSkills when active tab kind is skill", () => {
    const tab = skillTab("alpha", "frontend");
    const state: NavigationState = {
      sessionName: "alpha",
      openTabs: [tab],
      activeTabId: tab.id,
    };
    expect(isSkills(state)).toBe(true);
    expect(isSessions(state)).toBe(false);
  });

  it("isSessions when sessionName set and active tab is not settings/skill", () => {
    const tab = viewTab("alpha", "kanban");
    const state: NavigationState = {
      sessionName: "alpha",
      openTabs: [tab],
      activeTabId: tab.id,
    };
    expect(isSessions(state)).toBe(true);
    expect(isSettings(state)).toBe(false);
    expect(isSkills(state)).toBe(false);
  });
});

describe("accessors", () => {
  it("activeView returns the project tab when active tab is a view", () => {
    const tab = viewTab("alpha", "plans");
    const state: NavigationState = {
      sessionName: "alpha",
      openTabs: [tab],
      activeTabId: tab.id,
    };
    expect(activeView(state)).toBe("plans");
    expect(activeSessionName(state)).toBe("alpha");
    expect(activeSkillName(state)).toBeNull();
  });

  it("activeSkillName returns the skill name when active tab is a skill", () => {
    const tab = skillTab("alpha", "frontend");
    const state: NavigationState = {
      sessionName: "alpha",
      openTabs: [tab],
      activeTabId: tab.id,
    };
    expect(activeSkillName(state)).toBe("frontend");
    expect(activeView(state)).toBeNull();
  });
});

describe("setActiveSession + tab actions", () => {
  it("opens a default kanban tab when activating a fresh session", () => {
    setActiveSession("alpha");
    const live = getNavigationLive();
    expect(live.type).toBe("sessions");
    if (live.type === "sessions") {
      expect(live.sessionName).toBe("alpha");
      expect(live.tab).toBe("kanban");
    }
  });

  it("openTab activates a heterogeneous tab", () => {
    setActiveSession("alpha");
    const skill = skillTab("alpha", "frontend");
    openTab(skill);
    const live = getNavigationLive();
    expect(live.type).toBe("skills");
    if (live.type === "skills") {
      expect(live.sessionName).toBe("alpha");
      expect(live.skillName).toBe("frontend");
    }
  });

  it("closeTab falls back to the previous tab when closing the active one", () => {
    setActiveSession("alpha");
    const skill = skillTab("alpha", "frontend");
    openTab(skill);
    closeTab(skill.id);
    const live = getNavigationLive();
    expect(live.type).toBe("sessions");
    if (live.type === "sessions") expect(live.tab).toBe("kanban");
  });

  it("activateTab switches active tab without changing session", () => {
    setActiveSession("alpha");
    openTab(viewTab("alpha", "plans"));
    activateTab("view:alpha:kanban");
    expect(activeView(getNavigationStateLive())).toBe("kanban");
  });

  it("reorderTabs respects the requested order", () => {
    setActiveSession("alpha");
    openTab(viewTab("alpha", "plans"));
    openTab(viewTab("alpha", "metrics"));
    reorderTabs([
      "view:alpha:metrics",
      "view:alpha:plans",
      "view:alpha:kanban",
    ]);
    const ids = getNavigationStateLive().openTabs.map((t) => t.id);
    expect(ids).toEqual([
      "view:alpha:metrics",
      "view:alpha:plans",
      "view:alpha:kanban",
    ]);
  });

  it("persists per-session tab strips so switching back restores them", () => {
    setActiveSession("alpha");
    openTab(viewTab("alpha", "plans"));
    setActiveSession("beta");
    openTab(viewTab("beta", "metrics"));
    setActiveSession("alpha");
    const ids = getNavigationStateLive().openTabs.map((t) => t.id);
    expect(ids).toContain("view:alpha:plans");
    expect(ids).toContain("view:alpha:kanban");
    expect(ids).not.toContain("view:beta:metrics");
  });
});

describe("terminal tabs", () => {
  it("terminalTab builds a terminal tab with the given metadata", () => {
    const tab = terminalTab("alpha", {
      id: "terminal:alpha:default",
      title: "tmux-ide",
      cmd: ["__login_shell__", "tmux-ide"],
      cwd: "/repos/alpha",
    });
    expect(tab.kind).toBe("terminal");
    if (tab.kind === "terminal") {
      expect(tab.sessionName).toBe("alpha");
      expect(tab.title).toBe("tmux-ide");
      expect(tab.cmd).toEqual(["__login_shell__", "tmux-ide"]);
      expect(tab.cwd).toBe("/repos/alpha");
    }
  });

  it("ensureDefaultTerminal creates the default terminal tab for a session", () => {
    setActiveSession("alpha");
    const tab = ensureDefaultTerminal("alpha");
    expect(tab.kind).toBe("terminal");
    expect(tab.id).toBe(defaultTerminalTabId("alpha"));
    const live = getNavigationStateLive();
    expect(live.activeTabId).toBe(tab.id);
    expect(live.openTabs.some((t) => t.id === tab.id)).toBe(true);
  });

  it("ensureDefaultTerminal is idempotent — second call activates the existing tab", () => {
    setActiveSession("alpha");
    const first = ensureDefaultTerminal("alpha");
    // Switch away and come back.
    activateTab("view:alpha:kanban");
    const second = ensureDefaultTerminal("alpha");
    expect(second.id).toBe(first.id);
    const live = getNavigationStateLive();
    expect(live.activeTabId).toBe(first.id);
    expect(live.openTabs.filter((t) => t.kind === "terminal").length).toBe(1);
  });

  it("openTerminalTab without an id creates a fresh ad-hoc shell each time", () => {
    setActiveSession("alpha");
    const a = openTerminalTab("alpha", { title: "shell" });
    const b = openTerminalTab("alpha", { title: "shell" });
    expect(a.id).not.toBe(b.id);
    const live = getNavigationStateLive();
    expect(live.openTabs.filter((t) => t.kind === "terminal").length).toBe(2);
  });

  it("isSessions stays true when a terminal tab is active (terminals are project-scoped)", () => {
    setActiveSession("alpha");
    ensureDefaultTerminal("alpha");
    const state = getNavigationStateLive();
    expect(isSessions(state)).toBe(true);
    expect(isSettings(state)).toBe(false);
    expect(isSkills(state)).toBe(false);
  });

  it("closeTab removes a terminal tab and falls back to a sibling tab", () => {
    setActiveSession("alpha");
    const term = ensureDefaultTerminal("alpha");
    closeTab(term.id);
    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === term.id)).toBe(false);
    expect(live.activeTabId).toBe("view:alpha:kanban");
  });

  // Regression: clicking the sidebar's "Terminal" leaf added a terminal
  // tab, but the next time something synced from the URL — a popstate
  // event, a re-mount of `useNavigation`, or any caller hitting the
  // legacy `setNavigation({ type: "sessions", sessionName, tab: "kanban" })`
  // path — the active tab snapped back to kanban and the user perceived
  // the terminal as gone. The terminal must remain in `openTabs` AND
  // remain active across each of those resyncs.
  it("regression: terminal tab survives a URL-driven resync", () => {
    // Arrange: user is on /project/alpha and clicked "Terminal".
    window.history.replaceState(null, "", "/project/alpha");
    setActiveSession("alpha");
    const term = ensureDefaultTerminal("alpha");

    // The popstate handler / mount-time URL sync feeds the store with
    // `stateFromPath(window.location)`. For `/project/alpha` (no
    // explicit ?tab=) this must NOT clobber the terminal active tab —
    // the implicit kanban default is for output only.
    const fromUrl = stateFromPath(window.location.pathname, window.location.search);
    setNavigation(fromUrl);

    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === term.id)).toBe(true);
    expect(live.activeTabId).toBe(term.id);

    // localStorage must also persist the terminal as the active tab so a
    // page reload restores it.
    const persisted = window.localStorage.getItem("tmux-ide.tabs.alpha");
    expect(persisted).toBeTruthy();
    const parsed = JSON.parse(persisted!) as {
      openTabs: Array<{ id: string }>;
      activeTabId: string;
    };
    expect(parsed.openTabs.some((t) => t.id === term.id)).toBe(true);
    expect(parsed.activeTabId).toBe(term.id);
  });

  it("regression: terminal tab survives a setNavigation resync to the same session", () => {
    setActiveSession("alpha");
    const term = ensureDefaultTerminal("alpha");

    // Implicit-default re-sync: AppSidebar's project header click and the
    // shell URL sync both call `setNavigation({ type: "sessions",
    // sessionName })` with no explicit `tab`. The terminal must remain
    // in openTabs AND remain the active tab, otherwise the click flicker
    // back to kanban is exactly the bug we are fixing.
    setNavigation({ type: "sessions", sessionName: "alpha" });

    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === term.id)).toBe(true);
    expect(live.activeTabId).toBe(term.id);
  });

  it("explicit setNavigation with tab:kanban still switches to kanban (terminal stays in openTabs)", () => {
    setActiveSession("alpha");
    const term = ensureDefaultTerminal("alpha");

    // Explicit user request for the kanban view (e.g. from the project
    // switcher or a future "view: kanban" leaf) should switch the active
    // tab — but the terminal tab must remain in openTabs so the user can
    // click back to it.
    setNavigation({ type: "sessions", sessionName: "alpha", tab: "kanban" });

    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === term.id)).toBe(true);
    expect(live.activeTabId).toBe("view:alpha:kanban");
  });

  it("regression: multiple terminals (Cmd-Shift-T) coexist with the default terminal", () => {
    setActiveSession("alpha");
    const def = ensureDefaultTerminal("alpha");
    const adhoc1 = openTerminalTab("alpha", { title: "shell" });
    const adhoc2 = openTerminalTab("alpha", { title: "shell" });

    // Resync from URL — implicit kanban default must NOT remove the
    // ad-hoc terminals. All three must remain in openTabs and the most
    // recently opened tab stays active.
    const fromUrl = stateFromPath("/project/alpha", "");
    setNavigation(fromUrl);

    const live = getNavigationStateLive();
    const terminalIds = live.openTabs.filter((t) => t.kind === "terminal").map((t) => t.id);
    expect(terminalIds).toContain(def.id);
    expect(terminalIds).toContain(adhoc1.id);
    expect(terminalIds).toContain(adhoc2.id);
    expect(live.activeTabId).toBe(adhoc2.id);
  });

  it("regression: terminal tab persists across a fresh-state rehydrate", () => {
    setActiveSession("alpha");
    const term = ensureDefaultTerminal("alpha");

    // Simulate a fresh hydrate: persisted strip is on disk; spinning
    // up a brand-new state from URL must restore the terminal AND keep
    // it active.
    __resetNavigationForTests({
      sessionName: null,
      openTabs: [],
      activeTabId: null,
    } as NavigationState);
    // Re-write the localStorage entry that the previous run produced
    // (the reset clears it). Mimics the post-reload condition.
    window.localStorage.setItem(
      "tmux-ide.tabs.alpha",
      JSON.stringify({
        openTabs: [
          { id: "view:alpha:kanban", kind: "view", sessionName: "alpha", view: "kanban", title: "kanban" },
          { id: term.id, kind: "terminal", sessionName: "alpha", title: "tmux-ide", cmd: ["__login_shell__", "tmux-ide"] },
        ],
        activeTabId: term.id,
      }),
    );

    setNavigation({ type: "sessions", sessionName: "alpha" });

    const live = getNavigationStateLive();
    expect(live.openTabs.some((t) => t.id === term.id)).toBe(true);
    expect(live.activeTabId).toBe(term.id);
  });
});

describe("legacy setNavigation compat", () => {
  it("translates type:sessions into a view tab", () => {
    setNavigation({ type: "sessions", sessionName: "alpha", tab: "plans" });
    const live = getNavigationLive();
    expect(live.type).toBe("sessions");
    if (live.type === "sessions") {
      expect(live.sessionName).toBe("alpha");
      expect(live.tab).toBe("plans");
    }
  });

  it("translates type:settings into a settings tab", () => {
    setNavigation({ type: "settings", section: "appearance" });
    const live = getNavigationLive();
    expect(live.type).toBe("settings");
    if (live.type === "settings") {
      expect(live.section).toBe("appearance");
    }
  });

  it("translates type:skills with sessionName + skillName into a skill tab", () => {
    setNavigation({ type: "skills", sessionName: "alpha", skillName: "frontend" });
    const live = getNavigationLive();
    expect(live.type).toBe("skills");
    if (live.type === "skills") {
      expect(live.sessionName).toBe("alpha");
      expect(live.skillName).toBe("frontend");
    }
  });

  it("translates type:overview by clearing the session", () => {
    setNavigation({ type: "sessions", sessionName: "alpha" });
    setNavigation({ type: "overview" });
    expect(getNavigationLive()).toEqual({ type: "overview" });
  });
});

describe("pathFromState", () => {
  it("renders overview at /", () => {
    expect(pathFromState({ type: "overview" })).toBe("/");
  });

  it("renders settings with mode=settings query param", () => {
    expect(pathFromState({ type: "settings" })).toBe("/?mode=settings");
    expect(pathFromState({ type: "settings", section: "general" })).toBe("/?mode=settings");
    expect(pathFromState({ type: "settings", section: "appearance" })).toBe(
      "/?mode=settings&section=appearance",
    );
  });

  it("renders skills with and without an active session", () => {
    expect(pathFromState({ type: "skills" })).toBe("/?mode=skills");
    expect(pathFromState({ type: "skills", sessionName: "alpha" })).toBe(
      "/project/alpha?mode=skills",
    );
    expect(pathFromState({ type: "skills", sessionName: "alpha", skillName: "frontend" })).toBe(
      "/project/alpha?mode=skills&skill=frontend",
    );
  });

  it("renders session paths and only includes ?tab= for non-default tabs", () => {
    expect(pathFromState({ type: "sessions" })).toBe("/");
    expect(pathFromState({ type: "sessions", sessionName: "alpha" })).toBe("/project/alpha");
    expect(pathFromState({ type: "sessions", sessionName: "alpha", tab: "kanban" })).toBe(
      "/project/alpha",
    );
    expect(pathFromState({ type: "sessions", sessionName: "alpha", tab: "plans" })).toBe(
      "/project/alpha?tab=plans",
    );
  });

  it("encodes session names with special characters", () => {
    expect(pathFromState({ type: "sessions", sessionName: "my project" })).toBe(
      "/project/my%20project",
    );
  });
});

describe("stateFromPath", () => {
  it("parses overview from /", () => {
    expect(stateFromPath("/", "")).toEqual({ type: "overview" });
  });

  it("parses settings with optional section", () => {
    expect(stateFromPath("/", "mode=settings")).toEqual({ type: "settings" });
    expect(stateFromPath("/", "mode=settings&section=keybinds")).toEqual({
      type: "settings",
      section: "keybinds",
    });
  });

  it("ignores unknown settings sections", () => {
    expect(stateFromPath("/", "mode=settings&section=bogus")).toEqual({ type: "settings" });
  });

  it("parses skills mode without a project", () => {
    expect(stateFromPath("/", "mode=skills")).toEqual({ type: "skills" });
  });

  it("parses session routes without an explicit ?tab= and omits the tab field", () => {
    // Implicit kanban: omit the field so applyLegacy can preserve any
    // non-view tab (terminal, skill, settings, file) the user already has
    // selected. The active tab is restored from the per-session strip.
    expect(stateFromPath("/project/alpha", "")).toEqual({
      type: "sessions",
      sessionName: "alpha",
    });
  });

  it("parses session routes with explicit tab and decodes session names", () => {
    expect(stateFromPath("/project/my%20app", "tab=plans")).toEqual({
      type: "sessions",
      sessionName: "my app",
      tab: "plans",
    });
  });

  it("omits the tab field when ?tab= is unknown", () => {
    // Same reasoning as the no-tab case: an unrecognised value should not
    // be treated as an explicit kanban request.
    expect(stateFromPath("/project/alpha", "tab=garbage")).toEqual({
      type: "sessions",
      sessionName: "alpha",
    });
  });

  it("parses skill routes with optional skill name", () => {
    expect(stateFromPath("/project/alpha", "mode=skills")).toEqual({
      type: "skills",
      sessionName: "alpha",
    });
    expect(stateFromPath("/project/alpha", "mode=skills&skill=frontend")).toEqual({
      type: "skills",
      sessionName: "alpha",
      skillName: "frontend",
    });
  });

  it("round-trips through pathFromState → stateFromPath", () => {
    const cases: LegacyNavigationState[] = [
      { type: "overview" },
      { type: "settings" },
      { type: "settings", section: "keybinds" },
      { type: "skills" },
      { type: "skills", sessionName: "alpha" },
      { type: "skills", sessionName: "alpha", skillName: "frontend" },
      { type: "sessions", sessionName: "alpha" },
      { type: "sessions", sessionName: "alpha", tab: "plans" },
      { type: "sessions", sessionName: "alpha", tab: "metrics" },
    ];
    for (const state of cases) {
      const url = pathFromState(state);
      const [pathname, search = ""] = url.split("?");
      const parsed = stateFromPath(pathname!, search);
      expect(parsed).toEqual(state);
    }
  });

  it("normalises kanban → no-tab through the round-trip", () => {
    // The implicit kanban default is omitted by `stateFromPath` so that
    // popstate / fresh-load syncs do not clobber non-view active tabs.
    // Inputs that explicitly declared `tab: "kanban"` still produce the
    // canonical `/project/<name>` URL on the way out.
    const url = pathFromState({ type: "sessions", sessionName: "alpha", tab: "kanban" });
    expect(url).toBe("/project/alpha");
    expect(stateFromPath("/project/alpha", "")).toEqual({
      type: "sessions",
      sessionName: "alpha",
    });
  });
});
