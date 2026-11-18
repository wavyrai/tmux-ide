import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, median, renderSummary, roundRatios } from "./gate.mjs";

const budgets = {
  echoFloor: 0.9,
  profiles: [{ name: "rtt150", oneWayDelayMs: 75 }],
  ratios: { burst30Last: { max: 2 }, linesLag: { max: { rtt150: 3 } }, busyEcho: { max: 1.5 } },
};
const round = (echo, last, lag, busy) => ({
  plain: { echo: { p50: echo }, burst30: { last }, lines: { lag } },
  busy: { echo: { p50: busy } },
});

test("each ratio divides by plain key echo of the same round", () => {
  assert.deepEqual(roundRatios(round(160, 320, 480, 240)), {
    echoMs: 160,
    burst30Last: 2,
    linesLag: 3,
    busyEcho: 1.5,
  });
  assert.equal(roundRatios({ plain: { echo: { p50: 0 } } }), null);
});

test("the gate takes the median across rounds, so one noisy round does not fail it", () => {
  const result = evaluate(budgets, {
    rtt150: [round(160, 300, 400, 200), round(170, 900, 400, 200), round(165, 310, 410, 210)],
  });
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(median([1, 9, 2]), 2);
});

test("a ratio over its budget fails and is named", () => {
  const result = evaluate(budgets, {
    rtt150: [round(160, 160, 160, 400), round(160, 160, 160, 400)],
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /busy neighbours \/ echo is 2\.50, over 1\.5/);
});

test("an echo faster than the link's RTT means the delay was not applied", () => {
  const result = evaluate(budgets, { rtt150: [round(20, 20, 20, 20)] });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /delay was not applied/);
});

test("a failed round or a profile without measurements fails the gate", () => {
  assert.match(
    evaluate(budgets, { rtt150: [{ error: "probe timed out" }] }).failures.join("\n"),
    /probe timed out[^]*no round produced/,
  );
  assert.equal(evaluate(budgets, {}).ok, false);
});

test("the summary lists every measure with its budget and rounds", () => {
  const text = renderSummary(evaluate(budgets, { rtt150: [round(160, 320, 480, 240)] }));
  assert.match(text, /Remote input latency passed/);
  assert.match(text, /\| rtt150 \| 30-key burst .* \| 2\.00 \| 2 \| 2\.00 \|/);
  assert.match(
    renderSummary({ ok: true, rows: [], failures: [] }, { calibrate: true }),
    /calibration, not gated/,
  );
});
