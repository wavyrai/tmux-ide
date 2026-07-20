import { describe, expect, it } from "vitest";
import { terminalDisplayWidth } from "../panel-host.ts";
import { iconButtonText } from "../recipes.ts";
import { WORKSPACE_ICONS, workspaceIcon, workspaceIconLabel } from "./icons.ts";

describe("workspace icon grammar", () => {
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
  });

  it("centers an icon without exceeding narrow hit geometry", () => {
    for (const width of [0, 1, 2, 3, 4, 8]) {
      expect(terminalDisplayWidth(iconButtonText(workspaceIcon("maximize"), width))).toBe(width);
    }
    expect(iconButtonText(workspaceIcon("maximize"), 1)).toBe("□");
    expect(iconButtonText(workspaceIcon("maximize"), 3)).toBe(" □ ");
  });
});
