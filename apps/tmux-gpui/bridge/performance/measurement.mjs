import assert from "node:assert/strict";
export const pairs = () =>
  Array.from({ length: 5 }, (_, n) => (n % 2 ? ["tui", "gui"] : ["gui", "tui"])).flat();
export function marker(index) {
  assert.ok(Number.isInteger(index) && index >= 0 && index < 10);
  return {
    text: `P${String(index).padStart(3, "0")}`,
    rgb: ((55 + index * 7) << 16) | ((160 - index * 3) << 8) | (96 + index * 5),
  };
}
export function observation(input, negative, positive) {
  assert.ok(
    positive.matchingPixels >= 200 && positive.markerVisible === true,
    "marker pixels must actually be observed",
  );
  assert.ok(
    negative.matchingPixels < 200 || negative.markerVisible !== true,
    "negative capture must not show the complete marker",
  );
  const start = BigInt(input.triggerStartNs),
    end = BigInt(input.triggerEndNs);
  const upper = BigInt(positive.captureEndNs),
    lower = BigInt(negative.captureStartNs);
  assert.ok(end >= start && upper >= end && upper >= lower);
  return {
    lowerMs: Number(lower > end ? lower - end : 0n) / 1e6,
    upperMs: Number(upper - start) / 1e6,
    captureIntervalMs:
      Number(BigInt(positive.captureEndNs) - BigInt(positive.captureStartNs)) / 1e6,
  };
}
export function summarize(samples) {
  assert.equal(samples.length, 10);
  return Object.fromEntries(
    ["gui", "tui"].map((side) => {
      const rows = samples.filter((row) => row.side === side);
      assert.equal(rows.length, 5);
      assert.ok(rows.every((row) => row.correct && row.upperMs >= row.lowerMs));
      const upper = rows.map((row) => row.upperMs).sort((a, b) => a - b);
      return [
        side,
        {
          samples: 5,
          medianUpperMs: upper[2],
          minUpperMs: upper[0],
          maxUpperMs: upper[4],
          observationUncertaintyMs: Math.max(...rows.map((row) => row.upperMs - row.lowerMs)),
        },
      ];
    }),
  );
}
export function cleanEnvironment(source) {
  const allowed = /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TERM|COLORTERM|TMPDIR|SHELL)$/;
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && allowed.test(key)),
  );
}
