import assert from "node:assert/strict";
import { test } from "node:test";
import { nrSerialize } from "./serializer.mjs";
import { createRetainedFrameCache } from "./cache.mjs";
const prefixKeys = [
  "version",
  "connection",
  "sequence",
  "request",
  "sessions",
  "surface",
  "home",
  "diagnostics",
  "localSetup",
  "localSessionCreate",
  "createSession",
  "selectedServer",
  "homeAgents",
  "homeAgentRecovery",
  "homeAgentFilter",
  "sessionHistory",
  "sessionHistoryRejected",
  "paletteSupported",
  "paletteAgents",
  "paletteSelectionRejected",
  "attentionSupported",
  "attentionAgents",
  "attentionSelectionRejected",
  "sessionTabs",
  "sessionTabResult",
  "workspaceFleetAgents",
  "workspaceFleetAgentRejected",
  "workspaceAgents",
  "panes",
  "sessionCatalogComplete",
  "preferredPane",
  "selectedSession",
  "selectedPane",
];
const suffixKeys = [
  "selectionIdentity",
  "status",
  "snapshot",
  "historyOffset",
  "copyRegion",
  "regions",
  "inputReady",
  "resizeToken",
  "splitLayout",
  "splitGesture",
  "resizeGestureSupported",
  "resizeGesture",
  "paneActions",
  "presenceRevision",
  "appearance",
  "fleet",
  "machines",
];
const shape = (keys) =>
  Object.fromEntries(
    keys.map((k, i) => [
      k,
      {
        index: i,
        nested: [null, true, false, 42, 'quote" slash\\ newline\n tab\t \u0000 é 😀 \u2028 \ud800'],
      },
    ]),
  );
const frame = {
  columns: 2,
  rows: 1,
  grid: [
    {
      cells: [{ grapheme: '\u0000"\\😀\ud800', fg: null, bg: 3 }, { grapheme: "é\n" }],
      wrapped: true,
    },
  ],
  history: [],
};
const baseline = (prefix, suffix, snapshot) =>
  JSON.stringify({
    ...prefix,
    retainedPreview: snapshot === null ? null : { snapshot },
    ...suffix,
  }) + "\n";
test("full fixed envelope bytes match through escaping, omitted fields and metadata/authority changes", () => {
  const c = createRetainedFrameCache();
  assert.ok(c.remember("a", "proof", frame));
  const json = c.preview("a", "proof");
  for (let variant = 0; variant < 6; variant++) {
    const p = shape(prefixKeys),
      s = shape(suffixKeys);
    p.sequence = variant + 1;
    p.request = variant;
    s.presenceRevision = variant;
    for (const [i, key] of prefixKeys.entries()) if (i % 6 === variant) p[key] = undefined;
    for (const [i, key] of suffixKeys.entries()) if (i % 6 === variant) s[key] = null;
    s.inputReady = false;
    s.paneActions = null;
    s.copyRegion = null;
    s.regions = [];
    s.resizeToken = null;
    s.snapshot = null;
    p.selectedPane = null;
    assert.equal(nrSerialize(p, s, json), baseline(p, s, frame));
    assert.deepEqual(JSON.parse(nrSerialize(p, s, json)), JSON.parse(baseline(p, s, frame)));
    assert.equal(nrSerialize(p, s, null), baseline(p, s, null));
  }
});
test("serialized cache remains immutable, proof invalidation and LRU/retain/clear stay intact", () => {
  const c = createRetainedFrameCache();
  const value = structuredClone(frame);
  c.remember("a", "proof", value);
  const json = c.preview("a", "proof");
  value.grid[0].cells[0].grapheme = "changed";
  assert.equal(c.preview("a", "proof"), json);
  assert.equal(c.preview("a", "other"), null);
  assert.equal(c.preview("a", "proof"), null);
  for (let i = 0; i < 8; i++) c.remember(String(i), "proof", frame);
  c.preview("0", "proof");
  c.remember("8", "proof", frame);
  assert.equal(c.preview("1", "proof"), null);
  assert.ok(c.preview("0", "proof"));
  c.retain(["0"]);
  assert.equal(c.preview("8", "proof"), null);
  c.clear();
  assert.equal(c.preview("0", "proof"), null);
});
test("entry and total bytes remain bounded and complete wire bytes include cached payload", () => {
  const c = createRetainedFrameCache();
  for (let i = 0; i < 6; i++)
    assert.ok(c.remember(String(i), "proof", { text: "x".repeat(3 * 1024 * 1024) }));
  assert.equal(c.preview("0", "proof"), null);
  assert.equal(c.remember("1", "proof", { text: "x".repeat(4 * 1024 * 1024) }), false);
  assert.equal(c.preview("1", "proof"), null);
  const json = c.preview("5", "proof");
  const p = { version: 1 },
    s = { inputReady: false };
  const result = nrSerialize(p, s, json);
  assert.equal(result, baseline(p, s, JSON.parse(json)));
  assert.ok(Buffer.byteLength(result) > 3 * 1024 * 1024);
});
