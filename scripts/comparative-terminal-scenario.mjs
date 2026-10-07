// Versioned before measurement; changes require a new descriptor and qualification.
export const TYPING_SCENARIO = Object.freeze({
  version: 2,
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
  sentinelForeground: 0xe6f5ff,
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
    throw Error("Typing v2 requires100 samples,line input,one pane,no resize samples");
  if (options.cols !== 80 || options.rows !== 30) throw Error("Typing v2 freezes80x30 content");
  if (options.targets.some((target) => !["tmux", "tmux-ide"].includes(target)))
    throw Error("Typing v2 supports native/current only");
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
  const outerGeometries = { tmux: { cols: 80, rows: 31 }, "tmux-ide": { cols: 108, rows: 34 } };
  for (const target of options.targets) {
    const actual = options.outerGeometries?.[target],
      want = outerGeometries[target];
    const rect = options.contentRects[target],
      expectedRect = target === "tmux" ? { x: 0, y: 0 } : { x: 28, y: 3 };
    if (
      !actual ||
      actual.cols !== want.cols ||
      actual.rows !== want.rows ||
      rect.x !== expectedRect.x ||
      rect.y !== expectedRect.y
    )
      throw Error("Typing v2 requires frozen source-derived outer geometry and crop");
  }
  return {
    outerGeometries,
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
      fg: y === 2 ? 0xe6f5ff : 0xd2dce6,
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
      // Native EL/BCE redraw may replace an undecorated space's invisible RGB foreground
      // with default. Admit only this observed representation; background/styles stay exact.
      const plainBlank =
        want.text === " " &&
        want.width === 1 &&
        [
          "bold",
          "italic",
          "underline",
          "inverse",
          "dim",
          "blink",
          "invisible",
          "strikethrough",
        ].every((key) => want[key] === false);
      if (
        !actual ||
        Object.keys(want).some(
          (key) => actual[key] !== want[key] && !(key === "fg" && plainBlank && actual.fg === null),
        )
      )
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

export function typingGeometryReady(nativeGeometry, marker, frame, rect) {
  if (
    nativeGeometry !== "80|30" ||
    marker?.cols !== 80 ||
    marker?.rows !== 30 ||
    marker?.sequence !== 0
  )
    return false;
  try {
    assertTypingFrame(frame, rect, 80, 30, 0, 0);
    return true;
  } catch {
    return false;
  }
}
