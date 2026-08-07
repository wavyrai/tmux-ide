import { describe, expect, it } from "vitest";

import {
  APP_LAYOUT_MENU_IDS,
  APP_LAYOUT_QUALIFIER,
  canvasMenuSections,
  dockIntoStackMenuId,
  sessionRowMenuSections,
  stackIdFromDockIntoMenuId,
  SURFACE_MENU_IDS,
  verbMenuItem,
  windowCardMenuSections,
} from "./multiplexer-verb-menu.ts";
import type { ContextMenuItem, ContextMenuSection } from "../ui-system/index.ts";

const CONNECTED = {
  workspaceConnected: true,
  sessionWindowCount: 3,
  windowPaneCount: 2,
  windowZoomed: false,
  targetIsActivePane: false,
  targetIsDockedStackMember: false,
} as const;

function flat(sections: readonly ContextMenuSection[]): readonly ContextMenuItem[] {
  return sections.flatMap((section) => section.items);
}

function item(sections: readonly ContextMenuSection[], id: string): ContextMenuItem {
  const found = flat(sections).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no menu item ${id}`);
  return found;
}

function windowCard(overrides: Partial<Parameters<typeof windowCardMenuSections>[0]> = {}) {
  return windowCardMenuSections({
    facts: CONNECTED,
    placement: "floating",
    maximized: false,
    appLayoutAvailable: true,
    dockTargets: [],
    ...overrides,
  });
}

describe("verbMenuItem", () => {
  it("carries the table's label, destruction flag and availability reason", () => {
    const offered = verbMenuItem("pane.kill", CONNECTED);
    expect(offered).toMatchObject({
      id: "pane.kill",
      label: "Close pane",
      destructive: true,
      disabledReason: null,
    });

    const lastPane = verbMenuItem("pane.kill", {
      ...CONNECTED,
      windowPaneCount: 1,
      sessionWindowCount: 1,
    });
    expect(lastPane.disabledReason).toBe("this is the session's last pane");
  });

  it("teaches no key it cannot verify", () => {
    // The keybinding bridge does not exist yet, so every hint is null rather
    // than a default that a remapped prefix table would make a lie.
    expect(flat(windowCard()).every((entry) => entry.keyHint == null)).toBe(true);
  });

  it("qualifies verbs that never reach tmux", () => {
    expect(verbMenuItem("stack.activate", CONNECTED).qualifier).toBe(APP_LAYOUT_QUALIFIER);
    expect(verbMenuItem("window.kill", CONNECTED).qualifier).toBeNull();
  });
});

describe("windowCardMenuSections", () => {
  it("offers pane, window and session verbs, disabled-not-hidden", () => {
    const sections = windowCard({
      facts: { ...CONNECTED, windowPaneCount: 1, sessionWindowCount: 1, targetIsActivePane: true },
    });
    expect(sections.map((section) => section.id)).toEqual(["pane", "window", "session", "arrange"]);
    expect(item(sections, "pane.select").disabledReason).toBe("this pane is already active");
    expect(item(sections, "window.kill").disabledReason).toBe("this is the session's last window");
    expect(item(sections, "window.zoom.toggle").disabledReason).toBe(
      "this window has only one pane",
    );
    // Present regardless: the split verbs are how a GUI user reaches the layout
    // every tmux user actually works in.
    expect(item(sections, "pane.split.right").disabledReason).toBeNull();
    expect(item(sections, "pane.split.down").disabledReason).toBeNull();
  });

  it("keeps canvas arrangement in its own section, with the divergence stated", () => {
    const sections = windowCard();
    const arrange = sections.find((section) => section.id === "arrange")!;
    expect(arrange.note).toContain("tmux layout is unchanged");
    expect(arrange.items.every((entry) => entry.qualifier === APP_LAYOUT_QUALIFIER)).toBe(true);
    expect(item(sections, APP_LAYOUT_MENU_IDS.placement).label).toBe("Dock this window");
  });

  it("names the placement verb by what the click will do", () => {
    expect(item(windowCard({ placement: "docked" }), APP_LAYOUT_MENU_IDS.placement).label).toBe(
      "Float this window",
    );
  });

  it("refuses card maximize for a docked window and states why", () => {
    const sections = windowCard({ placement: "docked" });
    expect(item(sections, APP_LAYOUT_MENU_IDS.maximize).disabledReason).toBe(
      "Float this window before maximizing its card",
    );
  });

  it("disables every arrangement item when the host cannot mutate the layout", () => {
    const sections = windowCard({
      appLayoutAvailable: false,
      appLayoutUnavailableReason: "This host cannot persist layout",
      dockTargets: [{ stackId: "stack-1", label: "Editor" }],
    });
    const arrange = sections.find((section) => section.id === "arrange")!;
    for (const entry of arrange.items) {
      if (entry.id === "stack.activate") continue;
      expect(entry.disabledReason).toBe("This host cannot persist layout");
    }
  });

  it("enumerates dock destinations by their visible member", () => {
    const sections = windowCard({
      dockTargets: [
        { stackId: "stack-1", label: "Editor" },
        { stackId: "stack-2", label: "Dev server" },
      ],
    });
    expect(item(sections, dockIntoStackMenuId("stack-1")).label).toBe("Dock into Editor");
    expect(item(sections, dockIntoStackMenuId("stack-2")).label).toBe("Dock into Dev server");
    expect(stackIdFromDockIntoMenuId(dockIntoStackMenuId("stack-2"))).toBe("stack-2");
    expect(stackIdFromDockIntoMenuId("pane.kill")).toBeNull();
  });
});

describe("canvasMenuSections", () => {
  it("starts the creation loci and offers the session's own verbs", () => {
    const sections = canvasMenuSections({ facts: CONNECTED });
    expect(item(sections, "window.new").disabledReason).toBeNull();
    expect(item(sections, "session.new").disabledReason).toBeNull();
    expect(item(sections, "session.kill").destructive).toBe(true);
    expect(item(sections, "session.detach").destructive).toBe(false);
  });

  it("refuses session verbs when the workspace is not connected", () => {
    const sections = canvasMenuSections({ facts: { workspaceConnected: false } });
    expect(item(sections, "session.rename").disabledReason).toBe("the workspace is not connected");
    // Opening a project directory needs no connected workspace — it makes one.
    expect(item(sections, "session.new").disabledReason).toBeNull();
  });
});

describe("sessionRowMenuSections", () => {
  it("refuses a closed session's verbs with the one action that fixes it", () => {
    const sections = sessionRowMenuSections({
      facts: { workspaceConnected: false },
      open: false,
      label: "api",
    });
    expect(item(sections, SURFACE_MENU_IDS.openSession).disabledReason).toBeNull();
    for (const id of ["session.rename", "session.detach", "session.kill"]) {
      expect(item(sections, id).disabledReason).toBe("Open this session as a workspace first");
    }
  });

  it("enables the verbs on the open workspace's row", () => {
    const sections = sessionRowMenuSections({ facts: CONNECTED, open: true, label: "api" });
    expect(item(sections, SURFACE_MENU_IDS.openSession).disabledReason).toBe(
      "This session is already open",
    );
    expect(item(sections, "session.kill").disabledReason).toBeNull();
  });
});
