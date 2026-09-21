/** Deterministic parser regressions; never accesses a user terminal or clipboard. */
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const { Terminal } = await import(pathToFileURL(process.argv[2]).href);
const write = (term, bytes) => new Promise((resolve) => term.write(bytes, resolve));
const create = (options = {}) =>
  new Terminal({
    cols: 12,
    rows: 4,
    scrollback: 100,
    allowProposedApi: true,
    tmuxScrollOnClear: true,
    ...options,
  });
const lines = (term) =>
  Array.from({ length: term.buffer.active.length }, (_, y) =>
    term.buffer.active.getLine(y).translateToString(true),
  );
const cases = [];
async function check(name, run) {
  await run();
  cases.push(name);
}
await check("repeated clear and option off", async () => {
  for (const enabled of [true, false]) {
    const term = create({ tmuxScrollOnClear: enabled });
    try {
      await write(term, "first\x1b[2J\x1b[Hsecond\x1b[2J\x1b[H");
      assert.equal(term.buffer.active.baseY, enabled ? 2 : 0);
      if (enabled) assert.deepEqual(lines(term).slice(0, 2), ["first", "second"]);
      await write(term, "\x1b[2J");
      assert.equal(term.buffer.active.baseY, enabled ? 2 : 0);
    } finally {
      term.dispose();
    }
  }
});
await check("whole-grid clear ignores and preserves scroll margins", async () => {
  const term = create();
  try {
    await write(term, "top\x1b[3;1Hthird\x1b[2;3r\x1b[2;4H\x1b[2J");
    assert.equal(term.buffer.active.baseY, 3);
    assert.deepEqual(lines(term), ["top", "", "third", "", "", "", ""]);
    assert.equal(term.buffer.active.cursorX, 3);
    assert.equal(term.buffer.active.cursorY, 1);
    await write(term, "\x1b[1;1HA\x1b[2;1HB\x1b[3;1HC\n");
    assert.deepEqual(lines(term).slice(3), ["A", "C", "", ""]);
  } finally {
    term.dispose();
  }
});
await check("written spaces and partial erase retain used rows; full erase resets", async () => {
  const term = create();
  try {
    await write(term, "\x1b[3;1H   \x1b[2J\x1b[H");
    assert.equal(term.buffer.active.baseY, 3);
    await write(term, "\x1b[3;2HX\x1b[3;2H\x1b[K\x1b[2J\x1b[H");
    assert.equal(term.buffer.active.baseY, 6);
    await write(term, "\x1b[3;1HX\x1b[2K\x1b[2J");
    assert.equal(term.buffer.active.baseY, 6);
  } finally {
    term.dispose();
  }
});
await check("insert and delete moves retain used-row accounting even for blank cells", async () => {
  for (const control of ["\x1b[@", "\x1b[P"]) {
    const term = create();
    try {
      await write(term, "\x1b[3;2H" + control + "\x1b[2J");
      assert.equal(term.buffer.active.baseY, 3);
    } finally {
      term.dispose();
    }
  }
});
await check("styled empty rows are cleared without adding history", async () => {
  const term = create();
  try {
    await write(term, "\x1b[41m\x1b[2J\x1b[42m\x1b[2J");
    assert.equal(term.buffer.active.baseY, 0);
    for (let row = 0; row < 4; row++)
      assert.equal(term.buffer.active.getLine(row).getCell(0).getBgColor(), 2);
  } finally {
    term.dispose();
  }
});
await check(
  "alternate screen clear retains normal history and never adds alternate history",
  async () => {
    const term = create();
    try {
      await write(term, "normal\x1b[2J\x1b[H\x1b[?1049halt\x1b[2;3r\x1b[2J");
      assert.equal(term.buffer.active.type, "alternate");
      assert.equal(term.buffer.active.baseY, 0);
      assert.deepEqual(lines(term), ["", "", "", ""]);
      await write(term, "\x1b[?1049l");
      assert.equal(term.buffer.active.baseY, 1);
      assert.equal(lines(term)[0], "normal");
    } finally {
      term.dispose();
    }
  },
);
await check("history collection uses ten percent including zero limit", async () => {
  for (const limit of [0, 1, 20]) {
    const term = create({ scrollback: limit });
    try {
      for (let i = 0; i < 21; i++) await write(term, `${i}\x1b[2J\x1b[H`);
      assert.equal(term.buffer.active.baseY, limit === 20 ? 19 : limit);
      assert.equal(lines(term)[0], limit === 20 ? "2" : limit === 0 ? "" : "20");
    } finally {
      term.dispose();
    }
  }
});
await check("wide and combining text survives history transfer", async () => {
  const term = create();
  try {
    await write(term, "界e\u0301\x1b[2J");
    assert.equal(term.buffer.active.baseY, 1);
    assert.equal(lines(term)[0], "界e\u0301");
    assert.equal(term.buffer.active.getLine(0).getCell(0).getWidth(), 2);
  } finally {
    term.dispose();
  }
});
await check("empty copies do not manufacture used rows", async () => {
  for (const length of [0, 2]) {
    const term = create();
    try {
      // Exercise the native row-copy primitive used by wrapping/reflow. A
      // zero-length copy and a copy beyond source usage must remain empty.
      const rows = term._core.buffers.active.lines;
      rows.get(2).copyCellsFrom(rows.get(0), 3, 4, length, false);
      assert.equal(rows.get(2).tmuxCellUsed, 0);
      await write(term, "\x1b[2J");
      assert.equal(term.buffer.active.baseY, 0);
    } finally {
      term.dispose();
    }
  }
});
await check("ED2 preserves pending wrap without a following home command", async () => {
  const term = create();
  try {
    await write(term, "ABCDEFGHIJKL\x1b[2JZ");
    assert.equal(term.buffer.active.cursorX, 1);
    assert.equal(term.buffer.active.cursorY, 1);
    assert.equal(term.buffer.active.baseY, 1);
    assert.deepEqual(lines(term), ["ABCDEFGHIJKL", "", "Z", "", ""]);
  } finally {
    term.dispose();
  }
});
await check("native history limit is independent of captured-history capacity", async () => {
  const term = create({ scrollback: 25, tmuxHistoryLimit: 20 });
  try {
    // Populate capture backing without triggering the clear policy itself.
    await write(term, Array.from({ length: 29 }, (_, i) => String(i)).join("\r\n"));
    assert.equal(term.buffer.active.baseY, 25);
    await write(term, "\x1b[H\x1b[Jfirst\r\nsecond\x1b[2J");
    assert.equal(term.buffer.active.baseY, 23);
    assert.equal(lines(term)[0], "4");
    assert.deepEqual(lines(term).slice(21, 23), ["first", "second"]);
  } finally {
    term.dispose();
  }
  const disabled = create({ scrollback: 25, tmuxHistoryLimit: 0 });
  try {
    await write(disabled, "screen\x1b[2J");
    assert.equal(disabled.buffer.active.baseY, 0);
  } finally {
    disabled.dispose();
  }
});
console.log(JSON.stringify({ passed: cases.length, cases }));
