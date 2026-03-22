import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  getPreset,
  flattenConfigTree,
  updateConfigAtPath,
  addPane,
  removePane,
  validateSetupConfig,
  type TreeNode,
} from "./setup-model.ts";
import type { IdeConfig } from "../../schemas/ide-config.ts";

// ---------------------------------------------------------------------------
// Layout Presets
// ---------------------------------------------------------------------------

describe("PRESETS", () => {
  it("has 4 presets", () => {
    assert.strictEqual(PRESETS.length, 4);
  });

  it("each preset has required fields", () => {
    for (const preset of PRESETS) {
      assert.ok(preset.id, `preset missing id`);
      assert.ok(preset.label, `preset ${preset.id} missing label`);
      assert.ok(preset.description, `preset ${preset.id} missing description`);
      assert.ok(preset.diagram.length > 0, `preset ${preset.id} missing diagram`);
      assert.strictEqual(typeof preset.buildConfig, "function");
    }
  });

  it("each preset builds a valid IdeConfig", () => {
    for (const preset of PRESETS) {
      const config = preset.buildConfig("test-project");
      const result = validateSetupConfig(config);
      assert.ok(result.valid, `preset ${preset.id} produced invalid config: ${!result.valid ? result.errors.join(", ") : ""}`);
    }
  });

  it("dual-claude preset builds 2 claude panes + dev/shell", () => {
    const config = getPreset("dual-claude")!.buildConfig("my-app");
    assert.strictEqual(config.rows.length, 2);
    assert.strictEqual(config.rows[0]!.size, "70%");
    assert.strictEqual(config.rows[0]!.panes.length, 2);
    assert.strictEqual(config.rows[0]!.panes[0]!.command, "claude");
    assert.strictEqual(config.rows[0]!.panes[1]!.command, "claude");
    assert.strictEqual(config.rows[1]!.panes.length, 2);
  });

  it("triple-claude preset builds 3 claude panes + dev/shell", () => {
    const config = getPreset("triple-claude")!.buildConfig("my-app");
    assert.strictEqual(config.rows[0]!.panes.length, 3);
    assert.strictEqual(config.rows[0]!.size, "70%");
    for (const pane of config.rows[0]!.panes) {
      assert.strictEqual(pane.command, "claude");
    }
  });

  it("single-claude preset builds 1 claude pane 60% + 3 bottom panes 40%", () => {
    const config = getPreset("single-claude")!.buildConfig("my-app");
    assert.strictEqual(config.rows[0]!.size, "60%");
    assert.strictEqual(config.rows[0]!.panes.length, 1);
    assert.strictEqual(config.rows[0]!.panes[0]!.command, "claude");
    assert.strictEqual(config.rows[1]!.panes.length, 3);
  });

  it("agent-team preset has team, orchestrator, and role assignments", () => {
    const config = getPreset("agent-team")!.buildConfig("my-app");
    assert.ok(config.team, "should have team config");
    assert.ok(config.orchestrator, "should have orchestrator config");
    assert.strictEqual(config.orchestrator!.enabled, true);
    assert.strictEqual(config.rows[0]!.panes[0]!.role, "lead");
    assert.strictEqual(config.rows[0]!.panes[1]!.role, "teammate");
    assert.strictEqual(config.rows[0]!.panes[2]!.role, "teammate");
    assert.strictEqual(config.rows[1]!.panes.length, 4);
  });

  it("presets use detected devCommand when provided", () => {
    const config = getPreset("dual-claude")!.buildConfig("my-app", {
      devCommand: "pnpm dev",
      packageManager: "pnpm",
    });
    assert.strictEqual(config.rows[1]!.panes[0]!.command, "pnpm dev");
  });

  it("presets fall back to packageManager for dev command", () => {
    const config = getPreset("dual-claude")!.buildConfig("my-app", {
      devCommand: null,
      packageManager: "yarn",
    });
    assert.strictEqual(config.rows[1]!.panes[0]!.command, "yarn dev");
  });
});

describe("getPreset", () => {
  it("returns preset by id", () => {
    assert.strictEqual(getPreset("dual-claude")!.id, "dual-claude");
    assert.strictEqual(getPreset("agent-team")!.id, "agent-team");
  });

  it("returns undefined for unknown id", () => {
    assert.strictEqual(getPreset("nonexistent"), undefined);
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
        panes: [
          { title: "Claude 1", command: "claude" },
          { title: "Shell" },
        ],
      },
    ],
  };

  it("produces nodes for all config values", () => {
    const nodes = flattenConfigTree(simple);
    assert.ok(nodes.length > 0);
  });

  it("includes leaf nodes with string values", () => {
    const nodes = flattenConfigTree(simple);
    const nameNode = nodes.find(
      (n) => n.path.length === 1 && n.path[0] === "name",
    );
    assert.ok(nameNode);
    assert.strictEqual(nameNode!.value, "test");
    assert.strictEqual(nameNode!.expandable, false);
  });

  it("includes container nodes with null value", () => {
    const nodes = flattenConfigTree(simple);
    const rowsNode = nodes.find(
      (n) => n.path.length === 1 && n.path[0] === "rows",
    );
    assert.ok(rowsNode);
    assert.strictEqual(rowsNode!.value, null);
    assert.strictEqual(rowsNode!.expandable, true);
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
    assert.ok(titleNode, "should have node for rows.0.panes.0");
  });

  it("sets depth correctly", () => {
    const nodes = flattenConfigTree(simple);
    const nameNode = nodes.find((n) => n.label === "name" && n.path.length === 1);
    assert.strictEqual(nameNode!.depth, 0);

    const paneTitle = nodes.find(
      (n) => n.label === "title" && n.value === "Claude 1",
    );
    assert.ok(paneTitle);
    assert.strictEqual(paneTitle!.depth, 4); // rows.0.panes.0.title
  });

  it("skips undefined optional fields", () => {
    const config: IdeConfig = { rows: [{ panes: [{ title: "X" }] }] };
    const nodes = flattenConfigTree(config);
    const nameNode = nodes.find((n) => n.label === "name");
    assert.strictEqual(nameNode, undefined);
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
    assert.strictEqual(updated.name, "new-name");
    assert.strictEqual(base.name, "test"); // original unchanged
  });

  it("updates a nested value", () => {
    const updated = updateConfigAtPath(
      base,
      ["rows", "0", "panes", "0", "title"],
      "Renamed",
    );
    assert.strictEqual(updated.rows[0]!.panes[0]!.title, "Renamed");
    assert.strictEqual(base.rows[0]!.panes[0]!.title, "Claude"); // original unchanged
  });

  it("updates row size", () => {
    const updated = updateConfigAtPath(base, ["rows", "0", "size"], "50%");
    assert.strictEqual(updated.rows[0]!.size, "50%");
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
    assert.strictEqual(updated.rows[0]!.panes.length, 2);
    assert.strictEqual(updated.rows[0]!.panes[1]!.title, "New Pane");
    assert.strictEqual(base.rows[0]!.panes.length, 1); // original unchanged
  });

  it("returns clone unchanged for invalid row index", () => {
    const updated = addPane(base, 99);
    assert.strictEqual(updated.rows[0]!.panes.length, 1);
  });
});

describe("removePane", () => {
  const base: IdeConfig = {
    name: "test",
    rows: [{ panes: [{ title: "First" }, { title: "Second" }, { title: "Third" }] }],
  };

  it("removes the pane at the specified index", () => {
    const updated = removePane(base, 0, 1);
    assert.strictEqual(updated.rows[0]!.panes.length, 2);
    assert.strictEqual(updated.rows[0]!.panes[0]!.title, "First");
    assert.strictEqual(updated.rows[0]!.panes[1]!.title, "Third");
    assert.strictEqual(base.rows[0]!.panes.length, 3); // original unchanged
  });

  it("does not remove the last pane in a row", () => {
    const single: IdeConfig = {
      rows: [{ panes: [{ title: "Only" }] }],
    };
    const updated = removePane(single, 0, 0);
    assert.strictEqual(updated.rows[0]!.panes.length, 1);
    assert.strictEqual(updated.rows[0]!.panes[0]!.title, "Only");
  });

  it("returns clone unchanged for invalid row index", () => {
    const updated = removePane(base, 99, 0);
    assert.strictEqual(updated.rows[0]!.panes.length, 3);
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
    assert.strictEqual(result.valid, true);
  });

  it("returns errors for missing rows", () => {
    const result = validateSetupConfig({ name: "test" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("returns errors for empty rows array", () => {
    const result = validateSetupConfig({ name: "test", rows: [] });
    assert.strictEqual(result.valid, false);
  });

  it("returns errors for empty panes array in a row", () => {
    const result = validateSetupConfig({
      name: "test",
      rows: [{ panes: [] }],
    });
    assert.strictEqual(result.valid, false);
  });

  it("returns valid for config with optional fields", () => {
    const config = {
      name: "test",
      rows: [{ size: "70%", panes: [{ title: "X", command: "claude", focus: true }] }],
      theme: { accent: "colour75" },
    };
    const result = validateSetupConfig(config);
    assert.strictEqual(result.valid, true);
  });
});
