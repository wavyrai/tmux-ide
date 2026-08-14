import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCT_CANVAS_PANELS,
  QUARANTINED_PRODUCT_SURFACES,
  isDefaultProductDockTool,
} from "./product-surface-policy.ts";

describe("M59 default product surface policy", () => {
  it("admits only Home and Terminals", () => {
    expect(DEFAULT_PRODUCT_CANVAS_PANELS).toEqual(["home", "terminals"]);
    expect(QUARANTINED_PRODUCT_SURFACES).toEqual(["files", "changes", "missions", "activity"]);
    for (const tool of QUARANTINED_PRODUCT_SURFACES) {
      expect(isDefaultProductDockTool(tool)).toBe(false);
    }
  });

  it("keeps quarantined feature modules out of the cold loader graph", () => {
    const loaders = readFileSync(
      new URL("./application-optional-features.ts", import.meta.url),
      "utf8",
    );
    expect(loaders).not.toMatch(/^\s*files:\s*\(\)\s*=>\s*import\(/mu);
    expect(loaders).not.toMatch(/^\s*changes:\s*\(\)\s*=>\s*import\(/mu);
    expect(loaders).not.toMatch(/^\s*missionsActivity:\s*\(\)\s*=>\s*import\(/mu);
  });

  it("gates navigation, resource demand, restore and keyboard activation at the product policy", () => {
    const root = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    expect(root).toContain("dockTools: semanticApplicationShell().bottomDock.tools.filter");
    expect(root).toContain("isDefaultProductDockTool(tool.id as WorkbenchDockTabId)");
    expect(root).toContain("if (!isDefaultProductDockTool(dock))");
    expect(root).toContain("if (!isDefaultProductDockTool(tabId))");
    expect(root).toContain("dockShortcut && isDefaultProductDockTool(dockShortcut)");
    expect(root).toContain('setDockMode("collapsed")');
    expect(root).toContain('setWorkbenchFocusZone("canvas")');
  });
});
