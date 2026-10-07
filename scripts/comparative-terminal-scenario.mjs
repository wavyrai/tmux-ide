// Versioned before measurement; changes require a new descriptor and qualification.
export const TYPING_SCENARIO = Object.freeze({
  version: 1,
  paneCount: 1,
  inputMode: "line",
  warmups: 2,
  samples: 100,
  inputIntervalMs: 100,
  completionDeadlineMs: 5000,
  floodIntervalMs: 100,
  floodBytes: 512,
  floodTicks: 152,
  foreground: 0xd2dce6,
  background: 0x141e28,
  sentinelForeground: 0x12abef,
  sentinelBackground: 0x345678,
  cursor: Object.freeze({ x: 2, y: 3 }),
  inputOutput:
    "Each accepted input also repaints the full literal grid;512B is per flood tick, not total output",
  clock: "controller PTY write to stock-xterm consumed coherent cells; not physical paint",
});
export function typingScenario(options) {
  if (options.scenario === undefined) return null;
  if (!["quiet-typing", "flood-typing"].includes(options.scenario))
    throw Error("Invalid typing scenario");
  if (
    !Number.isSafeInteger(options.cols) ||
    options.cols < 40 ||
    options.cols > 240 ||
    !Number.isSafeInteger(options.rows) ||
    options.rows < 10 ||
    options.rows > 100
  )
    throw Error("Typing scene requires40..240cols and10..100rows");
  if (
    options.samples !== 100 ||
    (options.inputMode ?? "line") !== "line" ||
    (options.resizeSamples ?? 0) !== 0 ||
    (options.paneCount ?? 1) !== 1
  )
    throw Error("Typing v1 requires100 samples,line input,one pane,no resize samples");
  if (options.targets.some((target) => !["tmux", "tmux-ide"].includes(target)))
    throw Error("Typing v1 supports native/current only");
  for (const target of options.targets) {
    const rect = options.contentRects?.[target];
    if (
      !rect ||
      !Number.isSafeInteger(rect.x) ||
      rect.x < 0 ||
      !Number.isSafeInteger(rect.y) ||
      rect.y < 0
    )
      throw Error(`Explicit content rectangle required for ${target}`);
  }
  return {
    ...TYPING_SCENARIO,
    kind: options.scenario,
    cols: options.cols,
    rows: options.rows,
    contentRects: structuredClone(options.contentRects),
  };
}

// Oracle deliberately constructs literal cells, independently of producer ANSI generation.
export function expectedTypingCells(cols, rows, sequence, flood) {
  if (!Number.isSafeInteger(cols) || cols < 40 || !Number.isSafeInteger(rows) || rows < 4)
    throw Error("Invalid scene geometry");
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > 102 ||
    !Number.isSafeInteger(flood) ||
    flood < 0 ||
    flood > 152
  )
    throw Error("Invalid scene identity");
  const text = [
    `CBENCH:${String(sequence).padStart(6, "0")}:${cols}x${rows}:END`,
    `CBFLOOD:${String(flood).padStart(6, "0")}:END`,
    "styled sentinel",
  ];
  return Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => ({
      text: text[y]?.[x] ?? " ",
      width: 1,
      fg: y === 2 ? 0x12abef : 0xd2dce6,
      bg: y === 2 ? 0x345678 : 0x141e28,
      bold: y === 2,
      italic: false,
      underline: false,
      inverse: false,
      dim: false,
      blink: false,
      invisible: false,
      strikethrough: false,
    })),
  );
}
export function assertTypingFrame(frame, rect, cols, rows, sequence, flood) {
  if (!frame || rect.x + cols > frame.cols || rect.y + rows > frame.rows)
    throw Error("Content rectangle outside frame");
  const expected = expectedTypingCells(cols, rows, sequence, flood);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const actual = frame.cells[rect.y + y]?.[rect.x + x],
        want = expected[y][x];
      if (!actual || Object.keys(want).some((key) => actual[key] !== want[key]))
        throw Error(`Cell mismatch ${x},${y}`);
    }
  if (
    frame.cursor.visible !== true ||
    frame.cursor.x !== rect.x + 2 ||
    frame.cursor.y !== rect.y + 3
  )
    throw Error("Cursor mismatch");
}
export function floodIdentity(frame, rect) {
  const line = frame?.cells[rect.y + 1]
    ?.slice(rect.x)
    .map((c) => c.text)
    .join("");
  const match = /^CBFLOOD:(\d{6}):END/.exec(line ?? "");
  return match ? Number(match[1]) : null;
}

// All offered tokens exist before any I/O; failed/missed/coalesced tokens remain visible.
export function typingAttempts(startMs) {
  return Array.from({ length: 102 }, (_, index) => ({
    sequence: index + 1,
    warmup: index < 2,
    offeredAtMs: startMs + index * 100,
    status: "not-sent",
  }));
}
export function observeTypingAttempt(attempts, sequence, atMs) {
  const attempt = attempts[sequence - 1];
  if (
    !attempt ||
    attempt.status !== "pending" ||
    atMs < attempt.inputAtMs ||
    atMs > attempt.inputAtMs + 5000
  )
    return false;
  Object.assign(attempt, {
    status: "passed",
    visibleAtMs: atMs,
    latencyMs: atMs - attempt.inputAtMs,
  });
  return true;
}
export function finishTypingAttempts(attempts) {
  for (const attempt of attempts)
    if (attempt.status !== "passed") {
      attempt.status = "failed";
      attempt.error ??=
        attempt.inputAtMs === undefined
          ? "not sent"
          : "no coherent output before deadline (including coalesced/missing)";
    }
  return {
    attempted: attempts.filter((a) => !a.warmup).length,
    succeeded: attempts.filter((a) => !a.warmup && a.status === "passed").length,
    failed: attempts.filter((a) => !a.warmup && a.status !== "passed").length,
  };
}
