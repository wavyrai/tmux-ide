import { describe, expect, it } from "vitest";
import { COHESION_FIXTURE_V1, SEMANTIC_ICON_IDS } from "@tmux-ide/contracts";
import { terminalDisplayWidth } from "../panel-host.ts";
import { iconButtonText } from "../recipes.ts";
import { WORKSPACE_ICONS, workspaceIcon, workspaceIconLabel } from "./icons.ts";

describe("workspace icon grammar", () => {
  it("implements every canonical icon and every icon referenced by the common fixture", () => {
    expect(Object.keys(WORKSPACE_ICONS)).toEqual([...SEMANTIC_ICON_IDS]);
    for (const pane of COHESION_FIXTURE_V1.panes) {
      for (const action of pane.actions) {
        expect(workspaceIcon(action.icon)).toBe(WORKSPACE_ICONS[action.icon].glyph);
        expect(workspaceIconLabel(action.icon)).toBeTruthy();
      }
    }
  });

  it("keeps every Unicode glyph and ASCII fallback to exactly one terminal cell", () => {
    for (const [id, icon] of Object.entries(WORKSPACE_ICONS)) {
      expect(terminalDisplayWidth(icon.glyph), `${id} Unicode glyph`).toBe(1);
      expect(terminalDisplayWidth(icon.fallback), `${id} ASCII fallback`).toBe(1);
    }
  });

  it("resolves semantic glyphs without losing their human label", () => {
    expect(workspaceIcon("maximize")).toBe("□");
    expect(workspaceIcon("maximize", "ascii")).toBe("Z");
    expect(workspaceIconLabel("maximize")).toBe("Maximize");
    expect(workspaceIcon("more")).toBe("⋯");
    expect(workspaceIcon("close")).toBe("×");
    expect(workspaceIcon("split-right")).toBe("│");
    expect(workspaceIcon("pop-out", "ascii")).toBe("^");
  });

  it("centers an icon without exceeding narrow hit geometry", () => {
    for (const width of [0, 1, 2, 3, 4, 8]) {
      expect(terminalDisplayWidth(iconButtonText(workspaceIcon("maximize"), width))).toBe(width);
    }
    expect(iconButtonText(workspaceIcon("maximize"), 1)).toBe("□");
    expect(iconButtonText(workspaceIcon("maximize"), 3)).toBe(" □ ");
  });
});
