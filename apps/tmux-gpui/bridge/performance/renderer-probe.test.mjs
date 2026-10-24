import { test } from "node:test";
import assert from "node:assert/strict";
import { RendererProbe, outputMarker, ENDPOINT } from "./renderer-probe.mjs";
import { trialManifest, analyzeTrials } from "./renderer-trials.mjs";
const nonce = "a".repeat(32),
  scope = {
    pane: "pane.a",
    generation: "g",
    incarnation: "i",
    request: 1,
    cols: 110,
    rows: 32,
    viewportOffset: 0,
  };
const arm = { id: "t", nonce, kind: "input", scope, atMicros: 100, markerAbsent: true };
const paint = {
  scope,
  atMicros: 1100,
  text: outputMarker(nonce),
  row: 0,
  column: 0,
  writtenRows: [0],
};
test("only actual visible matching row completes once", () => {
  const p = new RendererProbe();
  assert(p.arm(arm));
  assert(!p.arm(arm));
  assert(!p.witness({ ...paint, writtenRows: [] }));
  assert(!p.witness({ ...paint, column: 100 }));
  assert(!p.witness({ ...paint, clipped: true }));
  assert(p.witness(paint));
  assert(!p.witness(paint));
  assert.equal(p.drain()[0].durationMicros, 1000);
  assert(!p.arm(arm));
});
test("scope replacement and timeout are failures", () => {
  const p = new RendererProbe();
  p.arm(arm);
  assert(!p.witness({ ...paint, scope: { ...scope, incarnation: "replacement" } }));
  assert.equal(p.drain()[0].reason, "scope-changed");
  const q = new RendererProbe();
  q.arm(arm);
  q.tick(5_000_101);
  assert.equal(q.drain()[0].reason, "timeout");
  assert(!q.witness(paint));
});
test("scroll waits for exact offset and row, never old viewport", () => {
  const p = new RendererProbe(),
    expectedScope = { ...scope, viewportOffset: 10 };
  assert(p.arm({ ...arm, kind: "scroll", expectedScope, row: 450 }));
  assert(!p.witness({ ...paint, text: outputMarker(nonce, 450) }));
  assert(p.witness({ ...paint, scope: expectedScope, text: outputMarker(nonce, 450) }));
});
test("requires negative control, safe clock and bounded trial lifetime", () => {
  const p = new RendererProbe();
  assert(!p.arm({ ...arm, markerAbsent: false }));
  p.arm(arm);
  assert(!p.witness({ ...paint, atMicros: 99 }));
  assert.equal(p.drain()[0].reason, "clock-invalid");
  for (let n = 1; n < 64; n++) {
    assert(p.arm({ ...arm, nonce: n.toString(16).padStart(32, "0") }));
    p.cancel("fixture-stop", 100);
  }
  assert(!p.arm({ ...arm, nonce: "b".repeat(32) }));
});
test("manifest interleaves five pairs per cohort and analysis retains failures", () => {
  const m = trialManifest({
    build: "b",
    daemon: "d",
    tmux: "t",
    route: "ssh",
    cols: 110,
    rows: 32,
  });
  assert.equal(m.trials.length, 30);
  assert.deepEqual(
    m.trials.slice(0, 4).map((t) => t.side),
    ["gui", "tui", "tui", "gui"],
  );
  const records = m.trials.map((t) => ({
    ...t,
    status: "completed",
    durationMicros: 1000,
    endpoint: ENDPOINT,
  }));
  assert(analyzeTrials(m, records).complete);
  records[0] = { ...records[0], status: "failed", reason: "timeout" };
  assert(!analyzeTrials(m, records).complete);
  assert.equal(analyzeTrials(m, records.slice(1)).cohorts[0].missing, 1);
  assert.throws(() => analyzeTrials(m, [...records, records[0]]));
});

test("analysis rejects receipts attributed to the wrong renderer", () => {
  const m = trialManifest({
    build: "b",
    daemon: "d",
    tmux: "t",
    route: "ssh",
    cols: 110,
    rows: 32,
  });
  const trial = m.trials[0];
  assert.throws(
    () =>
      analyzeTrials(m, [
        { ...trial, side: "tui", status: "completed", durationMicros: 1000, endpoint: ENDPOINT },
      ]),
    /identity mismatch/,
  );
});

test("analysis rejects incomplete or corrupted measurement plans", () => {
  const manifest = trialManifest({
    build: "b",
    daemon: "d",
    tmux: "t",
    route: "local",
    cols: 110,
    rows: 32,
  });
  const mutations = [
    (m) => {
      m.trials = [];
    },
    (m) => {
      m.trials.pop();
    },
    (m) => {
      m.trials[1] = { ...m.trials[0] };
    },
    (m) => {
      m.trials[1].nonce = m.trials[0].nonce;
    },
    (m) => {
      m.trials[0].kind = "unknown";
    },
    (m) => {
      m.trials[0].pair = 5;
    },
    (m) => {
      m.trials[0].nonce = "bad";
    },
    (m) => {
      m.endpoint = "dispatch-only";
    },
    (m) => {
      m.version = 2;
    },
    (m) => {
      delete m.identity.daemon;
    },
  ];
  for (const mutate of mutations) {
    const m = structuredClone(manifest);
    mutate(m);
    assert.throws(() => analyzeTrials(m, []), /Invalid measurement plan/);
  }
});
