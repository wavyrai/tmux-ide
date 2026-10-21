import test from "node:test";
import assert from "node:assert/strict";
import { pairs, marker, observation, summarize, cleanEnvironment } from "./measurement.mjs";
test("five interleaved pairs retain both orders and unique physical markers", () => {
  assert.deepEqual(pairs(), ["gui", "tui", "tui", "gui", "gui", "tui", "tui", "gui", "gui", "tui"]);
  assert.equal(new Set(pairs().map((_, n) => marker(n).rgb)).size, 10);
  assert.throws(() => marker(10));
  assert.throws(() => marker(-1));
});
test("visible timing uses observation bounds and rejects incomplete or already-visible witnesses", () => {
  const input = { triggerStartNs: "10000000", triggerEndNs: "12000000" };
  const absent = { captureStartNs: "15000000", matchingPixels: 0, markerVisible: false };
  const seen = {
    captureStartNs: "20000000",
    captureEndNs: "30000000",
    matchingPixels: 250,
    markerVisible: true,
  };
  assert.deepEqual(observation(input, absent, seen), {
    lowerMs: 3,
    upperMs: 20,
    captureIntervalMs: 10,
  });
  assert.throws(() => observation(input, absent, { ...seen, markerVisible: false }));
  assert.throws(() => observation(input, seen, seen));
  assert.throws(() => observation(input, absent, { ...seen, captureEndNs: "11000000" }));
});
test("comparisons require all ten correct samples; missing work cannot look fast", () => {
  const rows = pairs().map((side, n) => ({ side, correct: true, lowerMs: n, upperMs: n + 10 }));
  assert.equal(summarize(rows).gui.samples, 5);
  assert.throws(() => summarize(rows.slice(1)));
  assert.throws(() => summarize(rows.map((r, n) => (n === 0 ? { ...r, correct: false } : r))));
});
test("ambient daemon, tmux, XDG, preload and credential settings cannot escape fixture isolation", () => {
  assert.deepEqual(
    cleanEnvironment({
      PATH: "/bin",
      HOME: "/personal",
      TMUX_IDE_HOME: "bad",
      TMUX: "bad",
      XDG_DATA_HOME: "bad",
      NODE_OPTIONS: "bad",
      OPENAI_API_KEY: "bad",
      CODEX_HOME: "bad",
    }),
    { PATH: "/bin", HOME: "/personal" },
  );
});
