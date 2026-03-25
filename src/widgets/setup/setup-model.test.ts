import { describe, it, expect } from "bun:test";
import {
  PRESETS,
  getPreset,
  flattenConfigTree,
  updateConfigAtPath,
  addPane,
  removePane,
  validateSetupConfig,
} from "./setup-model.ts";
import type { IdeConfig } from "../../schemas/ide-config.ts";

// ---------------------------------------------------------------------------
// Layout Presets
// ---------------------------------------------------------------------------

describe("PRESETS", () => {
  it("has 4 presets", () => {
    expect(PRESETS.length).toBe(4);
  });

  it("each preset has required fields", () => {
    for (const preset of PRESETS) {
      expect(preset.id, `preset missing id`).toBeTruthy();
      expect(preset.label, `preset ${preset.id} missing label`).toBeTruthy();
      expect(preset.description, `preset ${preset.id} missing description`).toBeTruthy();
      expect(preset.diagram.length > 0, `preset ${preset.id} missing diagram`).toBeTruthy();
      expect(typeof preset.buildConfig).toBe("function");
    }
  });

  it("each preset builds a valid IdeConfig", () => {
    for (const preset of PRESETS) {
      const config = preset.buildConfig("test-project");
      const result = validateSetupConfig(config);
      expect(
        result.valid,
        `preset ${preset.id} produced invalid config: ${!result.valid ? result.errors.join(", ") : ""}`,
      ).toBeTruthy();
    }
  });

  it("dual-claude preset builds 2 claude panes + dev/shell", () => {
    const config = getPreset("dual-claude")!.buildConfig("my-app");
    expect(config.rows.length).toBe(2);
    expect(config.rows[0]!.size).toBe("70%");
    expect(config.rows[0]!.panes.length).toBe(2);
    expect(config.rows[0]!.panes[0]!.command).toBe("claude");
    expect(config.rows[0]!.panes[1]!.command).toBe("claude");
    expect(config.rows[1]!.panes.length).toBe(2);
  });

  it("triple-claude preset builds 3 claude panes + dev/shell", () => {
    const config = getPreset("triple-claude")!.buildConfig("my-app");
    expect(config.rows[0]!.panes.length).toBe(3);
    expect(config.rows[0]!.size).toBe("70%");
    for (const pane of config.rows[0]!.panes) {
      expect(pane.command).toBe("claude");
    }
  });

  it("single-claude preset builds 1 claude pane 60% + 3 bottom panes 40%", () => {
    const config = getPreset("single-claude")!.buildConfig("my-app");
    expect(config.rows[0]!.size).toBe("60%");
    expect(config.rows[0]!.panes.length).toBe(1);
    expect(config.rows[0]!.panes[0]!.command).toBe("claude");
    expect(config.rows[1]!.panes.length).toBe(3);
  });

  it("agent-team preset has team, orchestrator, and role assignments", () => {
    const config = getPreset("agent-team")!.buildConfig("my-app");
    expect(config.team, "should have team config").toBeTruthy();
    expect(config.orchestrator, "should have orchestrator config").toBeTruthy();
    expect(config.orchestrator!.enabled).toBe(true);
    expect(config.rows[0]!.panes[0]!.role).toBe("lead");
    expect(config.rows[0]!.panes[1]!.role).toBe("teammate");
    expect(config.rows[0]!.panes[2]!.role).toBe("teammate");
    expect(config.rows[1]!.panes.length).toBe(3);
  });

  it("presets use detected devCommand when provided", () => {
    const config = getPreset("dual-claude")!.buildConfig("my-app", {
      devCommand: "pnpm dev",
      packageManager: "pnpm",
    });
    expect(config.rows[1]!.panes[0]!.command).toBe("pnpm dev");
  });

  it("presets fall back to packageManager for dev command", () => {
    const config = getPreset("dual-claude")!.buildConfig("my-app", {
      devCommand: null,
      packageManager: "yarn",
    });
    expect(config.rows[1]!.panes[0]!.command).toBe("yarn dev");
  });
});

describe("getPreset", () => {
  it("returns preset by id", () => {
    expect(getPreset("dual-claude")!.id).toBe("dual-claude");
    expect(getPreset("agent-team")!.id).toBe("agent-team");
  });

  it("returns undefined for unknown id", () => {
    expect(getPreset("nonexistent")).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// flattenConfigTree
// ---------------------------------------------------------------------------

describe("flattenConfigTree", () => {
  const simple: IdeConfig = {
    name: "test",
    rows: [
      {
        size: "70%",
        panes: [{ title: "Claude 1", command: "claude" }, { title: "Shell" }],
      },
    ],
  };

  it("produces nodes for all config values", () => {
    const nodes = flattenConfigTree(simple);
    expect(nodes.length > 0).toBeTruthy();
  });

  it("includes leaf nodes with string values", () => {
    const nodes = flattenConfigTree(simple);
    const nameNode = nodes.find((n) => n.path.length === 1 && n.path[0] === "name");
    expect(nameNode).toBeTruthy();
    expect(nameNode!.value).toBe("test");
    expect(nameNode!.expandable).toBe(false);
  });

  it("includes container nodes with null value", () => {
    const nodes = flattenConfigTree(simple);
    const rowsNode = nodes.find((n) => n.path.length === 1 && n.path[0] === "rows");
    expect(rowsNode).toBeTruthy();
    expect(rowsNode!.value).toBe(null);
    expect(rowsNode!.expandable).toBe(true);
  });

  it("creates correct paths for deeply nested values", () => {
    const nodes = flattenConfigTree(simple);
    const titleNode = nodes.find(
      (n) =>
        n.path.length === 4 &&
        n.path[0] === "rows" &&
        n.path[1] === "0" &&
        n.path[2] === "panes" &&
        n.path[3] === "0",
    );
    expect(titleNode, "should have node for rows.0.panes.0").toBeTruthy();
  });

  it("sets depth correctly", () => {
    const nodes = flattenConfigTree(simple);
    const nameNode = nodes.find((n) => n.label === "name" && n.path.length === 1);
    expect(nameNode!.depth).toBe(0);

    const paneTitle = nodes.find((n) => n.label === "title" && n.value === "Claude 1");
    expect(paneTitle).toBeTruthy();
    expect(paneTitle!.depth).toBe(4); // rows.0.panes.0.title
  });

  it("skips undefined optional fields", () => {
    const config: IdeConfig = { rows: [{ panes: [{ title: "X" }] }] };
    const nodes = flattenConfigTree(config);
    const nameNode = nodes.find((n) => n.label === "name");
    expect(nameNode).toBe(undefined);
  });
});

// ---------------------------------------------------------------------------
// updateConfigAtPath
// ---------------------------------------------------------------------------

describe("updateConfigAtPath", () => {
  const base: IdeConfig = {
    name: "test",
    rows: [
      {
        size: "70%",
        panes: [{ title: "Claude", command: "claude" }],
      },
    ],
  };

  it("updates a top-level string value", () => {
    const updated = updateConfigAtPath(base, ["name"], "new-name");
    expect(updated.name).toBe("new-name");
    expect(base.name).toBe("test"); // original unchanged
  });

  it("updates a nested value", () => {
    const updated = updateConfigAtPath(base, ["rows", "0", "panes", "0", "title"], "Renamed");
    expect(updated.rows[0]!.panes[0]!.title).toBe("Renamed");
    expect(base.rows[0]!.panes[0]!.title).toBe("Claude"); // original unchanged
  });

  it("updates row size", () => {
    const updated = updateConfigAtPath(base, ["rows", "0", "size"], "50%");
    expect(updated.rows[0]!.size).toBe("50%");
  });
});

// ---------------------------------------------------------------------------
// addPane / removePane
// ---------------------------------------------------------------------------

describe("addPane", () => {
  const base: IdeConfig = {
    name: "test",
    rows: [{ panes: [{ title: "Existing" }] }],
  };

  it("adds a new pane to the specified row", () => {
    const updated = addPane(base, 0);
    expect(updated.rows[0]!.panes.length).toBe(2);
    expect(updated.rows[0]!.panes[1]!.title).toBe("New Pane");
    expect(base.rows[0]!.panes.length).toBe(1); // original unchanged
  });

  it("returns clone unchanged for invalid row index", () => {
    const updated = addPane(base, 99);
    expect(updated.rows[0]!.panes.length).toBe(1);
  });
});

describe("removePane", () => {
  const base: IdeConfig = {
    name: "test",
    rows: [{ panes: [{ title: "First" }, { title: "Second" }, { title: "Third" }] }],
  };

  it("removes the pane at the specified index", () => {
    const updated = removePane(base, 0, 1);
    expect(updated.rows[0]!.panes.length).toBe(2);
    expect(updated.rows[0]!.panes[0]!.title).toBe("First");
    expect(updated.rows[0]!.panes[1]!.title).toBe("Third");
    expect(base.rows[0]!.panes.length).toBe(3); // original unchanged
  });

  it("does not remove the last pane in a row", () => {
    const single: IdeConfig = {
      rows: [{ panes: [{ title: "Only" }] }],
    };
    const updated = removePane(single, 0, 0);
    expect(updated.rows[0]!.panes.length).toBe(1);
    expect(updated.rows[0]!.panes[0]!.title).toBe("Only");
  });

  it("returns clone unchanged for invalid row index", () => {
    const updated = removePane(base, 99, 0);
    expect(updated.rows[0]!.panes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// validateSetupConfig
// ---------------------------------------------------------------------------

describe("validateSetupConfig", () => {
  it("returns valid for a correct config", () => {
    const config: IdeConfig = {
      name: "test",
      rows: [{ panes: [{ title: "Shell" }] }],
    };
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });

  it("returns errors for missing rows", () => {
    const result = validateSetupConfig({ name: "test" });
    expect(result.valid).toBe(false);
    expect(result.errors.length > 0).toBeTruthy();
  });

  it("returns errors for empty rows array", () => {
    const result = validateSetupConfig({ name: "test", rows: [] });
    expect(result.valid).toBe(false);
  });

  it("returns errors for empty panes array in a row", () => {
    const result = validateSetupConfig({
      name: "test",
      rows: [{ panes: [] }],
    });
    expect(result.valid).toBe(false);
  });

  it("returns valid for config with optional fields", () => {
    const config = {
      name: "test",
      rows: [{ size: "70%", panes: [{ title: "X", command: "claude", focus: true }] }],
      theme: { accent: "colour75" },
    };
    const result = validateSetupConfig(config);
    expect(result.valid).toBe(true);
  });
});
