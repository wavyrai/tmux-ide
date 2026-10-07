import test from "node:test";
import assert from "node:assert/strict";
import {
  typingScenario,
  assertTypingFrame,
  typingAttempts,
  observeTypingAttempt,
  finishTypingAttempts,
} from "./comparative-terminal-scenario.mjs";
import { typingPaint, floodPaint } from "./comparative-terminal-producer.mjs";
import { createScreen } from "./comparative-terminal-support.mjs";

test("version1 descriptor rejects unqualified workloads and requires fixed crop", () => {
  const options = {
    scenario: "quiet-typing",
    samples: 100,
    cols: 40,
    rows: 10,
    targets: ["tmux"],
    contentRects: { tmux: { x: 0, y: 0 } },
  };
  assert.equal(typingScenario(options).inputIntervalMs, 100);
  for (const change of [
    { samples: 99 },
    { paneCount: 15 },
    { inputMode: "key" },
    { resizeSamples: 1 },
    { contentRects: {} },
    { targets: ["herdr"] },
  ])
    assert.throws(() => typingScenario({ ...options, ...change }));
  assert.equal(typingScenario({}), null);
});

test("real parser output matches independent fullscene oracle for paint and fixed512byte flood", async () => {
  let frame;
  const screen = createScreen(
    40,
    10,
    () => {},
    (_marker, _time, current) => {
      frame = current;
    },
    true,
  );
  try {
    await screen.write(typingPaint(40, 10, 7, 0));
    assertTypingFrame(frame, { x: 0, y: 0 }, 40, 10, 7, 0);
    for (const tick of [1, 9, 152]) {
      assert.equal(Buffer.byteLength(floodPaint(tick)), 512);
      await screen.write(floodPaint(tick));
      assertTypingFrame(frame, { x: 0, y: 0 }, 40, 10, 7, tick);
    }
    for (const corrupt of [
      (f) => {
        f.cells[9][39].text = "X";
      },
      (f) => {
        f.cells[2][30].bg = 0;
      },
      (f) => {
        f.cells[2][0].bold = false;
      },
      (f) => {
        f.cells[1][0].width = 2;
      },
      (f) => {
        f.cursor.x++;
      },
      (f) => {
        f.cursor.visible = false;
      },
    ]) {
      const bad = structuredClone(frame);
      corrupt(bad);
      assert.throws(() => assertTypingFrame(bad, { x: 0, y: 0 }, 40, 10, 7, 152));
    }
    await screen.write("\x1b[?25l");
    assert.throws(() => assertTypingFrame(frame, { x: 0, y: 0 }, 40, 10, 7, 152), /Cursor/);
    await screen.write("\x1b[?25h");
    assert.throws(() => assertTypingFrame(frame, { x: 1, y: 0 }, 40, 10, 7, 152));
    assert.throws(() => assertTypingFrame(frame, { x: 0, y: 0 }, 40, 10, 8, 152));
  } finally {
    screen.dispose();
  }
});

test("fixed attempts preserve missing, coalesced, timeout and unsent denominator", () => {
  const attempts = typingAttempts(1000);
  assert.equal(attempts.at(-1).offeredAtMs, 11100);
  for (const a of attempts.slice(0, 5))
    Object.assign(a, { inputAtMs: a.offeredAtMs, status: "pending" });
  assert.equal(observeTypingAttempt(attempts, 3, 1250), true);
  assert.equal(observeTypingAttempt(attempts, 3, 1300), false);
  assert.equal(observeTypingAttempt(attempts, 4, 9000), false);
  assert.deepEqual(finishTypingAttempts(attempts), { attempted: 100, succeeded: 1, failed: 99 });
  assert.equal(attempts.length, 102);
});

import { summarizeComparativeTerminalReport } from "./lib/comparative-terminal-report.mjs";
test("failed run and unsent attempts remain in report denominators", () => {
  const result = summarizeComparativeTerminalReport({
    options: { targets: ["tmux"] },
    runs: [
      {
        target: "tmux",
        status: "failed",
        inputDenominator: { attempted: 100, succeeded: 2, failed: 98 },
        samples: [],
      },
      {
        target: "tmux",
        status: "passed",
        inputDenominator: { attempted: 100, succeeded: 100, failed: 0 },
        samples: [],
      },
    ],
  })[0];
  assert.deepEqual(result.inputDenominator, { attempted: 200, succeeded: 102, failed: 98 });
  assert.equal(result.failed, 1);
});
