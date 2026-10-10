import { test } from "node:test";
import assert from "node:assert/strict";
import { paneChoices, type Layout } from "./topology.ts";
const layout = (id: string | null, name: string, pane: string, title: string): Layout => ({
  type: "layout",
  semanticWindowId: id,
  windowName: name,
  currentWindow: true,
  cols: 80,
  rows: 24,
  zoomed: false,
  paneBorderStatus: "off",
  panes: [{ pane, displayName: title, left: 0, top: 0, width: 80, height: 24, active: true }],
});
test("labels and duplicate window names never replace pane/window identities", () => {
  assert.deepEqual(
    paneChoices(
      ["pane-a", "pane-b", "pane-c"],
      [
        layout("window-1", "Shell", "pane-b", "Editor"),
        layout("window-2", "Shell", "pane-a", "Tests\nready"),
        layout("window-3", "Unknown", "injected", "Not in inventory"),
      ],
    ),
    [
      { id: "pane-b", label: "Editor", windowId: "window-1", windowLabel: "Shell" },
      { id: "pane-a", label: "Tests ready", windowId: "window-2", windowLabel: "Shell" },
      { id: "pane-c", label: "pane-c" },
    ],
  );
});
test("unverified joins and duplicate layouts cannot invent or duplicate choices", () => {
  assert.deepEqual(paneChoices(["pane-a"], [layout(null, "x", "pane-a", "wrong")]), [
    { id: "pane-a", label: "pane-a" },
  ]);
  const choices = paneChoices(
    ["pane-a"],
    [layout("window-a", "x", "pane-a", "first"), layout("window-b", "y", "pane-a", "second")],
  );
  assert.equal(choices.length, 1);
  assert.equal(choices[0].label, "first");
});

test("native label byte limits preserve complete Unicode scalars", () => {
  const [choice] = paneChoices(
    ["pane-a"],
    [layout("window-a", "🌍".repeat(256), "pane-a", "界".repeat(256))],
  );
  assert.equal(Buffer.byteLength(choice.label), 510);
  assert.equal(Buffer.byteLength(choice.windowLabel!), 512);
  assert.equal(choice.windowLabel, "🌍".repeat(128));
});
