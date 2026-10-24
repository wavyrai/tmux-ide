import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { paneChoices } from "./topology.ts";
import {
  acceptNativeCatalog,
  acceptsNativeReady,
  acceptsNativeInterrupted,
} from "./direct-terminal-ready.ts";
const config = {
  baseUrl: "http://127.0.0.1:41234/",
  ownerToken: "private",
  scope: { serverId: `tmux-server.${"a".repeat(32)}`, generation: randomUUID() },
  workspaceName: "workspace",
  liveSessionId: `live-session.${"b".repeat(20)}`,
  semanticPaneId: "left",
  visiblePaneIds: ["left", "right"],
};
const binding = {
  id: randomUUID(),
  request: 7,
  config,
  origin: "tmux-ide://app",
  hostClientId: `gpui:${randomUUID()}`,
};
const common = {
  version: 1,
  id: binding.id,
  request: 7,
  pane: "left",
  liveSessionId: config.liveSessionId,
  generation: config.scope.generation,
  presenceRevision: 3,
};
const layout = {
  type: "layout",
  semanticWindowId: "window",
  windowName: "Window",
  currentWindow: true,
  cols: 5,
  rows: 2,
  zoomed: false,
  paneBorderStatus: "off",
  modeKeys: "vi",
  panes: [
    { pane: "left", left: 0, top: 0, width: 2, height: 2, active: true },
    { pane: "right", left: 3, top: 0, width: 2, height: 2, active: false },
  ],
};
test("native readiness requires exact current scope and presence, with no row payload", () => {
  const value = { ...common, type: "native-terminal-ready", inputReady: true, coherent: true };
  assert.ok(acceptsNativeReady(binding, value, 3));
  for (const patch of [
    { id: randomUUID() },
    { request: 8 },
    { pane: "right" },
    { generation: randomUUID() },
    { presenceRevision: 4 },
    { inputReady: false },
    { coherent: false },
    { grid: [] },
  ])
    assert.equal(acceptsNativeReady(binding, { ...value, ...patch }, 3), false);
});
test("catalog retains authoritative window metadata and requires exact issued pane membership", () => {
  const value = { ...common, type: "native-terminal-catalog", layouts: [layout] };
  assert.deepEqual(acceptNativeCatalog({ ...binding, catalogOnly: true }, value, 3), [layout]);
  for (const panes of [
    layout.panes.slice(0, 1),
    [...layout.panes, layout.panes[0]],
    [{ ...layout.panes[0], pane: "outside" }, layout.panes[1]],
  ])
    assert.equal(
      acceptNativeCatalog(
        { ...binding, catalogOnly: true },
        { ...value, layouts: [{ ...layout, panes }] },
        3,
      ),
      null,
    );
  assert.equal(
    acceptNativeCatalog({ ...binding, catalogOnly: true }, { ...value, rows: [] }, 3),
    null,
  );
});

test("native interruption cannot recover a retired or different attachment", () => {
  const value = { ...common, type: "native-terminal-interrupted" };
  assert.ok(acceptsNativeInterrupted(binding, value, 3));
  for (const patch of [
    { id: randomUUID() },
    { request: 8 },
    { pane: "right" },
    { generation: randomUUID() },
    { liveSessionId: "different" },
    { presenceRevision: 4 },
    { rows: [] },
    { inputReady: true },
  ])
    assert.equal(acceptsNativeInterrupted(binding, { ...value, ...patch }, 3), false);
  assert.equal(acceptsNativeInterrupted(null, value, 3), false);
  assert.equal(acceptsNativeInterrupted({ ...binding, catalogOnly: true }, value, 3), false);
});

test("active native topology refreshes new-window labels without terminal rows", () => {
  const nextBinding = {
    ...binding,
    request: 8,
    config: { ...config, semanticPaneId: "new", visiblePaneIds: ["left", "right", "new"] },
  };
  const nextWindow = {
    ...layout,
    semanticWindowId: "new-window",
    windowName: "lucky-puffin",
    panes: [{ ...layout.panes[0], pane: "new", displayName: "Shell" }],
  };
  const value = {
    ...common,
    request: 8,
    pane: "new",
    type: "native-terminal-catalog",
    layouts: [{ ...layout, currentWindow: false }, nextWindow],
  };
  const accepted = acceptNativeCatalog(nextBinding, value, 3);
  assert.deepEqual(accepted, value.layouts);
  assert.deepEqual(paneChoices(nextBinding.config.visiblePaneIds, accepted!), [
    { id: "left", label: "left", windowId: "window", windowLabel: "Window" },
    { id: "right", label: "right", windowId: "window", windowLabel: "Window" },
    { id: "new", label: "Shell", windowId: "new-window", windowLabel: "lucky-puffin" },
  ]);
  for (const patch of [
    { request: 7 },
    { presenceRevision: 2 },
    { id: randomUUID() },
    { pane: "left" },
    { generation: randomUUID() },
    { rows: [] },
    { layouts: [nextWindow] },
  ])
    assert.equal(acceptNativeCatalog(nextBinding, { ...value, ...patch }, 3), null);
});
