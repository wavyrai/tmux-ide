import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeBrowserPublication as nrSerialize } from "./browser-publication.ts";
import { createRetainedFrameCache } from "./retained-frame-cache.ts";
import { blankTerminalReplicaSnapshot } from "../../../packages/core/src/terminal-replica.ts";
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
const shape = (keys: string[]): Record<string, unknown> =>
  Object.fromEntries(
    keys.map((k, i) => [
      k,
      {
        index: i,
        nested: [null, true, false, 42, 'quote" slash\\ newline\n tab\t \u0000 é 😀 \u2028 \ud800'],
      },
    ]),
  );
const frame = structuredClone(blankTerminalReplicaSnapshot(2, 1));
Object.assign(frame.grid[0]!.cells[0]!, { grapheme: '\u0000"\\😀\ud800' });
const baseline = (
  prefix: Record<string, unknown>,
  suffix: Record<string, unknown>,
  snapshot: unknown,
) =>
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
    const p = shape(prefixKeys) as Parameters<typeof nrSerialize>[0],
      s = shape(suffixKeys) as Parameters<typeof nrSerialize>[1];
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

test("negotiated compact publication preserves metadata and leaves retained previews legacy", async () => {
  const { decodeCompactSnapshot } = await import("./compact-snapshot.ts");
  const snapshot = blankTerminalReplicaSnapshot(80, 24);
  const cache = createRetainedFrameCache();
  assert.ok(cache.remember("pane", "proof", snapshot));
  const retained = cache.preview("pane", "proof");
  const prefix = { version: 1, selectedPane: "%1", request: 4 };
  const suffix = { selectionIdentity: "identity", machines: null, snapshot, inputReady: true };
  const legacy = JSON.parse(nrSerialize(prefix, suffix, retained));
  const compact = JSON.parse(nrSerialize(prefix, suffix, retained, "rle-v1"));
  assert.equal(compact.snapshot.encoding, "rle-v1");
  assert.deepEqual({ ...compact, snapshot: decodeCompactSnapshot(compact.snapshot) }, legacy);
  assert.equal(compact.retainedPreview.snapshot.encoding, undefined);
});
