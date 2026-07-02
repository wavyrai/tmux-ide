/**
 * Unit tests for the pure widget-panel registry + its popup command builders.
 */
import { describe, expect, it } from "vitest";
import {
  PANEL_POPUPS,
  POPUP_WIDGETS,
  panelKey,
  panelPopupBindCommand,
  panelPopupCli,
  panelPopupCommand,
  panelPopupUnbindCommand,
} from "./panels.ts";
import { DEFAULT_KEYS } from "../../lib/app-config.ts";

describe("PANEL_POPUPS", () => {
  it("is the explorer/changes/config widgets that exist and stand alone", () => {
    expect(PANEL_POPUPS.map((p) => p.widget)).toEqual(["explorer", "changes", "config"]);
    // preview (companion to explorer) and setup (onboarding wizard) are excluded
    expect(POPUP_WIDGETS).not.toContain("preview");
    expect(POPUP_WIDGETS).not.toContain("setup");
  });

  it("POPUP_WIDGETS mirrors the registry (the `tmux-ide popup <widget>` set)", () => {
    expect(POPUP_WIDGETS).toEqual(PANEL_POPUPS.map((p) => p.widget));
  });

  it("gives every panel a non-empty size and label", () => {
    for (const p of PANEL_POPUPS) {
      expect(p.width).toMatch(/^\d+%$/);
      expect(p.height).toMatch(/^\d+%$/);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});

describe("panelKey", () => {
  it("resolves a panel's configured key from AppPanelKeys", () => {
    const explorer = PANEL_POPUPS.find((p) => p.widget === "explorer")!;
    expect(panelKey(explorer, DEFAULT_KEYS.panels)).toBe("M-e");
    const config = PANEL_POPUPS.find((p) => p.widget === "config")!;
    expect(panelKey(config, DEFAULT_KEYS.panels)).toBe("M-,");
  });
});

describe("panelPopupCli", () => {
  it("is the `tmux-ide popup <widget>` invocation", () => {
    expect(panelPopupCli("explorer")).toBe("tmux-ide popup explorer");
  });
});

describe("panelPopupBindCommand", () => {
  it("binds the key to a display-popup on the pane's cwd with per-widget sizing", () => {
    const explorer = PANEL_POPUPS.find((p) => p.widget === "explorer")!;
    const cmd = panelPopupBindCommand(explorer, "M-e");
    expect(cmd.slice(0, 5)).toEqual(["bind-key", "-n", "M-e", "display-popup", "-E"]);
    expect(cmd).toContain("-d");
    expect(cmd).toContain("#{pane_current_path}");
    expect(cmd).toContain(explorer.width);
    expect(cmd).toContain(explorer.height);
    expect(cmd[cmd.length - 1]).toBe("tmux-ide popup explorer");
  });

  it("passes a custom CLI command through", () => {
    const changes = PANEL_POPUPS.find((p) => p.widget === "changes")!;
    const cmd = panelPopupBindCommand(changes, "M-g", "node bin/cli.js popup changes");
    expect(cmd[cmd.length - 1]).toBe("node bin/cli.js popup changes");
  });
});

describe("panelPopupCommand", () => {
  it("is the display-popup command string shared with the actions menu", () => {
    const config = PANEL_POPUPS.find((p) => p.widget === "config")!;
    const str = panelPopupCommand(config);
    expect(str).toBe(
      `display-popup -E -d '#{pane_current_path}' -w ${config.width} -h ${config.height} "tmux-ide popup config"`,
    );
  });
});

describe("panelPopupUnbindCommand", () => {
  it("removes the key from the root table", () => {
    expect(panelPopupUnbindCommand("M-e")).toEqual(["unbind-key", "-n", "M-e"]);
  });
});
