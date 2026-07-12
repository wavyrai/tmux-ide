import { describe, expect, it } from "vitest";
import {
  agentMetadataFor,
  buildAgentEntry,
  excludeSidebarPanes,
  isListableSession,
  rollupStatus,
  rollupWindows,
} from "./sessions.ts";
import type { AgentStatus } from "../detect/classify.ts";
import type { AgentManifest } from "../detect/manifest.ts";

describe("excludeSidebarPanes", () => {
  it("drops panes marked as the app sidebar", () => {
    const panes = [
      { id: "%1", sidebar: false },
      { id: "%2", sidebar: true },
      { id: "%3", sidebar: false },
    ];
    expect(excludeSidebarPanes(panes).map((p) => p.id)).toEqual(["%1", "%3"]);
  });

  it("keeps every pane when none is a sidebar", () => {
    const panes = [{ sidebar: false }, { sidebar: false }];
    expect(excludeSidebarPanes(panes)).toHaveLength(2);
  });

  it("returns empty when the only pane is the sidebar", () => {
    expect(excludeSidebarPanes([{ sidebar: true }])).toEqual([]);
  });
});

describe("rollupStatus", () => {
  it("blocked wins over everything else", () => {
    expect(rollupStatus(["idle", "working", "done", "blocked", "unknown"])).toBe("blocked");
  });

  it("working wins over done, idle and unknown", () => {
    expect(rollupStatus(["idle", "done", "working", "unknown"])).toBe("working");
  });

  it("done wins over idle and unknown", () => {
    expect(rollupStatus(["idle", "unknown", "done"])).toBe("done");
  });

  it("empty array rolls up to idle", () => {
    expect(rollupStatus([])).toBe("idle");
  });

  it("all-unknown stays unknown", () => {
    expect(rollupStatus(["unknown", "unknown"])).toBe("unknown");
  });

  it("unknown only wins when nothing else is present — idle beats unknown", () => {
    expect(rollupStatus(["unknown", "idle"])).toBe("idle");
  });
});

describe("rollupWindows", () => {
  const pane = (windowIndex: number, windowName: string, windowActive = false) => ({
    windowIndex,
    windowName,
    windowActive,
  });

  it("groups each window's panes and rolls their statuses up", () => {
    const panes = [pane(0, "editor", true), pane(0, "editor", true), pane(1, "server")];
    const statuses: AgentStatus[] = ["idle", "working", "done"];
    expect(rollupWindows(panes, statuses)).toEqual([
      { index: 0, name: "editor", active: true, panes: 2, status: "working" },
      { index: 1, name: "server", active: false, panes: 1, status: "done" },
    ]);
  });

  it("returns windows in ascending index order regardless of pane order", () => {
    const panes = [pane(3, "c"), pane(1, "a"), pane(2, "b")];
    const statuses: AgentStatus[] = ["idle", "idle", "idle"];
    expect(rollupWindows(panes, statuses).map((w) => w.index)).toEqual([1, 2, 3]);
  });

  it("marks a window active when ANY of its panes reports window_active", () => {
    const panes = [pane(0, "w", false), pane(0, "w", true)];
    const statuses: AgentStatus[] = ["idle", "idle"];
    expect(rollupWindows(panes, statuses)[0]!.active).toBe(true);
  });

  it("an empty pane list yields an empty window list", () => {
    expect(rollupWindows([], [])).toEqual([]);
  });

  it("a lone blocked pane makes its window blocked", () => {
    expect(rollupWindows([pane(0, "w")], ["blocked"])).toEqual([
      { index: 0, name: "w", active: false, panes: 1, status: "blocked" },
    ]);
  });
});

describe("buildAgentEntry", () => {
  const pane = { id: "%5", windowIndex: 2, title: "Editor", cmd: "node", dir: "/w/proj" };
  const claude: AgentManifest = {
    id: "claude",
    commands: ["claude"],
    states: {},
    confidence: "tuned",
  };

  it("builds an entry for a resolved agent pane, threading kind/state/confidence/since", () => {
    expect(
      buildAgentEntry({
        sessionName: "web",
        pane,
        manifest: claude,
        state: "working",
        since: 1700000000,
      }),
    ).toEqual({
      paneId: "%5",
      windowIndex: 2,
      session: "web",
      kind: "claude",
      state: "working",
      confidence: "tuned",
      since: 1700000000,
      title: "Editor",
      command: "node",
      dir: "/w/proj",
    });
  });

  it("returns null for a pane with no resolved manifest", () => {
    expect(
      buildAgentEntry({
        sessionName: "web",
        pane,
        manifest: undefined,
        state: "unknown",
        since: null,
      }),
    ).toBeNull();
  });

  it("returns null for the `shell` catch-all — a raw shell isn't an agent", () => {
    const shell: AgentManifest = { id: "shell", commands: ["bash"], states: {} };
    expect(
      buildAgentEntry({ sessionName: "web", pane, manifest: shell, state: "idle", since: null }),
    ).toBeNull();
  });

  it("defaults confidence to `conservative` when the manifest omits it", () => {
    const bare: AgentManifest = { id: "gemini", commands: ["gemini"], states: {} };
    const entry = buildAgentEntry({
      sessionName: "web",
      pane,
      manifest: bare,
      state: "idle",
      since: null,
    });
    expect(entry?.confidence).toBe("conservative");
  });

  it("carries a null `since` for a scraped/tracked pane (no authority stamp)", () => {
    const entry = buildAgentEntry({
      sessionName: "web",
      pane,
      manifest: claude,
      state: "done",
      since: null,
    });
    expect(entry?.since).toBeNull();
  });

  it("threads display metadata additively — absent fields stay ABSENT, not undefined-valued", () => {
    const withMeta = buildAgentEntry({
      sessionName: "web",
      pane,
      manifest: claude,
      state: "working",
      since: 1700000000,
      statusText: "refactoring auth",
      displayName: "reviewer",
    })!;
    expect(withMeta.statusText).toBe("refactoring auth");
    expect(withMeta.displayName).toBe("reviewer");

    const without = buildAgentEntry({
      sessionName: "web",
      pane,
      manifest: claude,
      state: "working",
      since: null,
    })!;
    expect("statusText" in without).toBe(false);
    expect("displayName" in without).toBe(false);
  });
});

describe("agentMetadataFor (staleness gate, M25.4)", () => {
  const pane = { statusTextRaw: "refactoring auth", displayNameRaw: "reviewer" };

  it("surfaces sanitized metadata while the authority stamp is fresh", () => {
    expect(agentMetadataFor(pane, true)).toEqual({
      statusText: "refactoring auth",
      displayName: "reviewer",
    });
  });

  it("drops ALL metadata when the authority stamp is stale/absent — same rules as @agent_state", () => {
    expect(agentMetadataFor(pane, false)).toEqual({});
  });

  it("sanitizes: control chars stripped, overlong text ellipsized, empty → omitted", () => {
    const meta = agentMetadataFor(
      { statusTextRaw: "a\tb " + "x".repeat(60), displayNameRaw: "  " },
      true,
    );
    expect(meta.displayName).toBeUndefined();
    expect(meta.statusText?.length).toBe(32);
    expect(meta.statusText?.startsWith("a b x")).toBe(true);
  });
});

describe("isListableSession", () => {
  it("hides `_`-prefixed internal sessions from the switcher", () => {
    expect(isListableSession("_tmux-ide-chrome")).toBe(false);
    expect(isListableSession("_scratch")).toBe(false);
    expect(isListableSession("_")).toBe(false);
  });

  it("keeps every non-internal session", () => {
    expect(isListableSession("my-project")).toBe(true);
    expect(isListableSession("tmux-ide")).toBe(true);
  });
});
