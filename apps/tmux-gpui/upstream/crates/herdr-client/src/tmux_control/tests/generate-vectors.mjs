// node --import tsx apps/tmux-gpui/upstream/crates/herdr-client/src/tmux_control/tests/generate-vectors.mjs
import { writeFileSync } from "node:fs";
import {
  PaneStreamClientFrameSchemaZ,
  PaneStreamServerFrameSchemaZ,
} from "../../../../../../../../packages/contracts/src/pane-stream.ts";
const generation = "12d14eac-0000-4000-8000-000000000001";
const requestId = "12d14eac-0000-4000-8000-000000000002";
const geometryId = "12d14eac-0000-4000-8000-000000000003";
const token = "12d14eac-0000-4000-8000-000000000004";
const lease = (authority, revision) => ({
  generation,
  session: "tmux-session",
  clientId: "gpui:test",
  authority,
  token,
  revision,
});
const snapshot = (revision, geometry) => ({
  generation,
  session: "tmux-session",
  revision,
  owners: { input: "gpui:test", focus: null, geometry: geometry ? "gpui:test" : null },
  nativeGeometryYieldUntilMs: 0,
  clients: [],
});
const clients = [
  { type: "presence", generation, state: "foreground" },
  { type: "authority-request", generation, requestId, authority: "input" },
  {
    type: "input",
    pane: "pane.one",
    seq: 1,
    kind: "text",
    data: "é",
    expectedLifetime: { generation, incarnation: "pane:1" },
  },
  { type: "authority-request", generation, requestId: geometryId, authority: "geometry" },
  {
    type: "viewport",
    semanticWindowId: "window.one",
    seq: 1,
    cols: 80,
    rows: 24,
    authorityLease: lease("geometry", 2),
  },
  { type: "presence", generation, state: "background" },
  { type: "authority-release", generation, requestId, authority: "input" },
  { type: "authority-release", generation, requestId: geometryId, authority: "geometry" },
].map((v) => PaneStreamClientFrameSchemaZ.parse(v));
const servers = [
  {
    type: "authority-receipt",
    requestId,
    authority: "input",
    status: "granted",
    lease: lease("input", 1),
    snapshot: snapshot(1, false),
  },
  { type: "input-ack", pane: "pane.one", seq: 1 },
  {
    type: "authority-receipt",
    requestId: geometryId,
    authority: "geometry",
    status: "granted",
    lease: lease("geometry", 2),
    snapshot: snapshot(2, true),
  },
  {
    type: "viewport-ack",
    seq: 1,
    cols: 80,
    rows: 24,
    outcome: "ok",
    authorityLease: lease("geometry", 2),
  },
].map((v) => PaneStreamServerFrameSchemaZ.parse(v));
writeFileSync(
  new URL("vectors.json", import.meta.url),
  JSON.stringify({ clients, servers }, null, 2) + "\n",
);
const intents = [
  { verb: "workspace.pane.select", semanticPaneId: "pane.one" },
  { verb: "workspace.pane.resize", semanticPaneId: "pane.one", axis: "cols", cells: 80 },
  { verb: "workspace.window.split", semanticPaneId: "pane.one", direction: "right" },
  { verb: "workspace.pane.kill", semanticPaneId: "pane.one" },
  { verb: "workspace.window.kill", target: { by: "pane", semanticPaneId: "pane.one" } },
  { verb: "workspace.session.kill" },
];
const results = [
  { semanticPaneId: "pane.one" },
  { semanticPaneId: "pane.one", axis: "cols", cells: 70 },
  { semanticPaneId: "pane.created", direction: "right", displayTitle: "New pane" },
  { windowClosed: false, remainingWindowCount: 1 },
  { remainingWindowCount: 1 },
  {},
];
writeFileSync(new URL("intent-vectors.json", import.meta.url), JSON.stringify(intents.map((intent, i) => ({
  command: PaneStreamClientFrameSchemaZ.parse({ type: "semantic-intent", operationId: requestId, intent: { ...intent, workspaceName: "workspace" } }),
  ack: PaneStreamServerFrameSchemaZ.parse({ type: "semantic-intent-ack", operationId: requestId, outcome: { status: "applied", result: { ...results[i], verb: intent.verb, operationId: requestId, daemonInstanceId: generation, workspaceName: "workspace", outcome: "applied" } } }),
})), null, 2) + "\n");
const window = { liveSessionId: "live-session." + "a".repeat(20), linkId: "window-link." + "b".repeat(32), expectedSemanticWindowId: "window.one", linkRevision: 1 };
const resource = { version: 1, window, layoutId: generation, cols: 80, rows: 24, panes: [{ semanticPaneId: "pane.one", left: 0, top: 0, width: 39, height: 24 }, { semanticPaneId: "pane.two", left: 40, top: 0, width: 40, height: 24 }], splits: [{ splitId: token, axis: "cols", boundary: 39, start: 0, length: 24 }] };
const target = { window, layoutId: generation, splitId: token, boundary: 45 };
const successor = { resource: { ...resource, layoutId: geometryId, splits: [{ ...resource.splits[0], boundary: 45 }] }, splitId: token };
const extra = [
  [{ verb: "workspace.rename", scope: "pane", semanticPaneId: "pane.one", name: "Renamed" }, { scope: "pane", name: "Renamed" }],
  [{ verb: "workspace.rename", scope: "window", target: { by: "window", semanticWindowId: "window.one" }, name: "Window" }, { scope: "window", name: "Window" }],
  [{ verb: "workspace.rename", scope: "session", name: "Session" }, { scope: "session", name: "Session" }],
  [{ verb: "workspace.pane.zoom.toggle", semanticPaneId: "pane.one", desired: "zoomed" }, { semanticPaneId: "pane.one", zoomed: true }],
  [{ verb: "workspace.pane.swap", sourceSemanticPaneId: "pane.one", targetSemanticPaneId: "pane.two" }, { sourceSemanticPaneId: "pane.one", targetSemanticPaneId: "pane.two" }],
  [{ verb: "workspace.window.split.resize", target }, { target, axis: "cols", boundary: 45, successor }],
];
writeFileSync(new URL("extra-intent-vectors.json", import.meta.url), JSON.stringify({ resource, vectors: extra.map(([intent, result]) => ({
  command: PaneStreamClientFrameSchemaZ.parse({ type: "semantic-intent", operationId: requestId, intent: { ...intent, workspaceName: "workspace" } }),
  ack: PaneStreamServerFrameSchemaZ.parse({ type: "semantic-intent-ack", operationId: requestId, outcome: { status: "applied", result: { ...result, verb: intent.verb, operationId: requestId, daemonInstanceId: generation, workspaceName: "workspace", outcome: "applied" } } }),
})) }, null, 2) + "\n");
