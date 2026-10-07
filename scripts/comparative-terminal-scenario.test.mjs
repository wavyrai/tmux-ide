import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  typingScenario,
  typingGeometryReady,
  assertTypingFrame,
  typingAttempts,
  observeTypingAttempt,
  finishTypingAttempts,
} from "./comparative-terminal-scenario.mjs";
import { typingPaint, floodPaint } from "./comparative-terminal-producer.mjs";
import { createScreen } from "./comparative-terminal-support.mjs";

test("version2 descriptor rejects unqualified workloads and requires fixed crop", () => {
  const options = {
    scenario: "quiet-typing",
    samples: 100,
    cols: 80,
    rows: 30,
    outerGeometries: { tmux: { cols: 80, rows: 31 } },
    targets: ["tmux"],
    contentRects: { tmux: { x: 0, y: 0 } },
  };
  assert.equal(typingScenario(options).inputIntervalMs, 100);
  for (const change of [
    { samples: 99 },
    { cols: 40 },
    { outerGeometries: {} },
    { outerGeometries: { tmux: { cols: 80, rows: 30 } } },
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

test("retained native EL redraw preserves blank background while default foreground is equivalent", async () => {
  const retained = JSON.parse(
    readFileSync(
      new URL("./fixtures/comparative-native-blank-redraw.json", import.meta.url),
      "utf8",
    ),
  );
  let frame;
  const screen = createScreen(
    80,
    30,
    () => {},
    (_m, _t, f) => (frame = f),
    true,
  );
  try {
    await screen.write(typingPaint(80, 30, 0, 0));
    assert.equal(frame.cells[0][23].fg, 0xd2dce6);
    // Replay original row0 bytes exactly; v2 sentinel remains the separately painted row2.
    await screen.write(retained.ansi + "\x1b[4;3H\x1b[?25h");
    assert.equal(frame.cells[0][23].fg, null);
    assert.equal(frame.cells[0][23].bg, 0x141e28);
    assertTypingFrame(frame, { x: 0, y: 0 }, 80, 30, 0, 0);
    for (const corrupt of [
      (f) => {
        f.cells[0][23].fg = 0xff00ff;
      },
      (f) => {
        f.cells[0][0].fg = null;
      },
      (f) => {
        f.cells[0][23].bg = 0;
      },
      (f) => {
        f.cells[0][23].text = "X";
      },
      (f) => {
        f.cells[0][23].underline = true;
      },
      (f) => {
        f.cells[0][23].inverse = true;
      },
      (f) => {
        f.cells[0][23].strikethrough = true;
      },
      (f) => {
        f.cells[2][20].fg = null;
      },
    ]) {
      const bad = structuredClone(frame);
      corrupt(bad);
      assert.throws(() => assertTypingFrame(bad, { x: 0, y: 0 }, 80, 30, 0, 0));
    }
    const marker = { cols: 80, rows: 30, sequence: 0 };
    assert.equal(typingGeometryReady("80|30", marker, frame, { x: 0, y: 0 }), true);
    for (const native of ["80|31", "80|29", "108|34"])
      assert.equal(typingGeometryReady(native, marker, frame, { x: 0, y: 0 }), false);
    for (const rows of [29, 31, 33])
      assert.equal(typingGeometryReady("80|30", { ...marker, rows }, frame, { x: 0, y: 0 }), false);
    const bad = structuredClone(frame);
    bad.cells[0][0].text = "Z";
    assert.equal(typingGeometryReady("80|30", marker, bad, { x: 0, y: 0 }), false);
  } finally {
    screen.dispose();
  }
});

test("v2 sentinel independently exceeds default automatic contrast threshold without disabling it", () => {
  function luminance(rgb) {
    const channels = [16, 8, 0]
      .map((shift) => ((rgb >> shift) & 255) / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return channels.reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
  }
  const ratio = (fg, bg) => {
    const [a, b] = [luminance(fg), luminance(bg)].sort((a, b) => a - b);
    return (b + 0.05) / (a + 0.05);
  };
  assert.ok(ratio(0x12abef, 0x345678) < 4.5);
  assert.ok(ratio(0xe6f5ff, 0x345678) > 6.8);
  assert.ok(ratio(0xd2dce6, 0x141e28) > 12);
  assert.ok(typingPaint(80, 30, 0, 0).includes("38;2;230;245;255"));
});
