import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadGhosttyVtProof, REQUIRED_NAPI_VERSION } from "../load.mjs";
import { XTERM_FIXTURES } from "./xterm-fixtures.mjs";

const addonPath = resolve(
  process.argv[2] ?? new URL("../build/ghostty_vt_proof.node", import.meta.url).pathname,
);
let unsupportedLoadCalled = false;
assert.deepEqual(
  loadGhosttyVtProof(addonPath, {
    runtimeNapi: REQUIRED_NAPI_VERSION - 1,
    load() {
      unsupportedLoadCalled = true;
      throw new Error("unsupported runtime must not attempt native loading");
    },
  }),
  { status: "unsupported", requiredNapi: 9, runtimeNapi: 8 },
);
assert.equal(unsupportedLoadCalled, false);

const loaded = loadGhosttyVtProof(addonPath);
assert.equal(loaded.status, "loaded", loaded.error);
const { GhosttyVtProofTerminal, liveHandles, abiIdentity, setTestFailure } = loaded.binding;
const bytes = (value) => new TextEncoder().encode(value);
const rowText = (row) => row.cells.map((cell) => cell.grapheme).join("");

assert.match(abiIdentity, /cursor-history-dirty\.v3\+napi9$/);
assert.equal(liveHandles(), 0);
const terminal = new GhosttyVtProofTerminal(8, 3, 32);
assert.equal(liveHandles(), 1);

terminal.write(
  bytes(
    "\x1b]8;;https://example.test\x1b\\A\x1b]8;;\x1b\\" +
      "\x1b[1;2;3;4;5;7;8;9;38;5;196;48;2;1;2;3mB\x1b[0m界xy" +
      "\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[4h\x1b[?6h\x1b[?1000h",
  ),
);

let snapshot = terminal.project();
assert.equal(snapshot.kind, "seed");
assert.equal(snapshot.cols, 8);
assert.equal(snapshot.rows, 3);
assert.equal(snapshot.activeScreen, "primary");
assert.deepEqual(snapshot.cursor, { x: 0, y: 0, hidden: false, style: "block", blink: false });
assert.deepEqual(snapshot.modes, {
  alternateScreen: false,
  applicationCursor: true,
  applicationKeypad: true,
  bracketedPaste: true,
  insert: true,
  origin: true,
  wraparound: true,
  mouseTracking: true,
  synchronizedOutput: false,
});
assert.equal(snapshot.viewportRows.length, 3);
assert.equal(snapshot.viewportRows[0].cells.length, 8);
assert.equal(snapshot.viewportRows[0].cells[0].grapheme, "A");
assert.equal(snapshot.viewportRows[0].cells[0].hyperlink, "https://example.test");
assert.equal(snapshot.viewportRows[0].cells[1].attributes, 0xff);
assert.deepEqual(snapshot.viewportRows[0].cells[1].foreground, { kind: "indexed", index: 196 });
assert.deepEqual(snapshot.viewportRows[0].cells[1].background, { kind: "rgb", value: 0x010203 });
assert.equal(snapshot.viewportRows[0].cells[2].grapheme, "界");
assert.equal(snapshot.viewportRows[0].cells[2].width, 2);
assert.equal(snapshot.viewportRows[0].cells[3].width, 0);
assert.equal(snapshot.viewportRows[2].cells[7].grapheme, " ");
assert.equal(snapshot.viewportRows[2].cells[7].width, 1);

snapshot = terminal.project();
assert.equal(snapshot.kind, "delta");
assert.deepEqual(snapshot.viewportRows, []);
assert.deepEqual(snapshot.historyAppend, []);
assert.equal(snapshot.historyTrim, 0);

for (const fixture of XTERM_FIXTURES) {
  const fixtureTerminal = new GhosttyVtProofTerminal(fixture.cols, fixture.rows, 0);
  for (const write of fixture.writes) fixtureTerminal.write(bytes(write));
  const fixtureSeed = fixtureTerminal.project();
  assert.deepEqual(
    fixtureSeed.viewportRows.flatMap((row) => (row.wrapped ? [row.index] : [])),
    fixture.wrappedRows,
    `${fixture.id} wrapped rows`,
  );
  for (const expected of fixture.cells) {
    assert.deepEqual(
      {
        grapheme: fixtureSeed.viewportRows[expected.row].cells[expected.column].grapheme,
        width: fixtureSeed.viewportRows[expected.row].cells[expected.column].width,
      },
      { grapheme: expected.grapheme, width: expected.width },
      `${fixture.id} ${expected.row}:${expected.column}`,
    );
  }
  fixtureTerminal.dispose();
}

const authoritative = new GhosttyVtProofTerminal(3, 3, 0);
authoritative.write(bytes("ABC"));
authoritative.setAuthoritativeCursor(0, 1);
authoritative.write(bytes("X"));
snapshot = authoritative.project();
assert.equal(rowText(snapshot.viewportRows[0]), "ABC");
assert.equal(snapshot.viewportRows[1].cells[0].grapheme, "X");
assert.deepEqual(snapshot.cursor, { x: 1, y: 1, hidden: false, style: "block", blink: false });
authoritative.dispose();

const stateSafety = new GhosttyVtProofTerminal(5, 4, 0);
stateSafety.write(bytes("\x1b[2;3r\x1b[?6h\x1b[1;2H\x1b7"));
const savedCursor = stateSafety.project().cursor;
stateSafety.setAuthoritativeCursor(0, 1);
stateSafety.write(bytes("X\x1b8"));
snapshot = stateSafety.project();
assert.equal(snapshot.viewportRows.find((row) => row.index === 1).cells[0].grapheme, "X");
assert.deepEqual(snapshot.cursor, savedCursor);
assert.equal(snapshot.modes.origin, true);
stateSafety.write(bytes("\x1b[999B"));
snapshot = stateSafety.project();
assert.equal(snapshot.cursor.y, 2);
assert.equal(snapshot.modes.origin, true);
stateSafety.dispose();

terminal.write(bytes("\x1b[r\x1b[?6l\x1b[Hz\n1\n2\n3\n4\n5\n"));
assert.throws(() => terminal.project(true), /injected projection failure/);
snapshot = terminal.project();
assert.equal(snapshot.kind, "delta");
assert.ok(snapshot.viewportRows.length > 0, "dirty rows survive failed projection");
assert.ok(snapshot.historyAppend.length > 0);

terminal.write(bytes("\x1b[?1049h\x1b[?25l\x1b[3 qALT"));
snapshot = terminal.project();
assert.equal(snapshot.kind, "seed");
assert.equal(snapshot.activeScreen, "alternate");
assert.equal(snapshot.modes.alternateScreen, true);
assert.equal(snapshot.cursor.hidden, true);
assert.equal(snapshot.cursor.style, "underline");
assert.equal(snapshot.cursor.blink, true);

terminal.resize(12, 4);
snapshot = terminal.project();
assert.equal(snapshot.kind, "seed");
assert.equal(snapshot.cols, 12);
assert.equal(snapshot.rows, 4);
assert.equal(snapshot.viewportRows.length, 4);
assert.equal(snapshot.viewportRows[0].cells.length, 12);

for (const invalid of [NaN, Infinity, -1, 1.5, "2", 513]) {
  assert.throws(() => new GhosttyVtProofTerminal(invalid, 2, 0));
}
assert.throws(() => new GhosttyVtProofTerminal(2, 257, 0));
assert.throws(() => new GhosttyVtProofTerminal(2, 2, 5001));
assert.throws(() => terminal.resize(NaN, 2));
assert.throws(() => terminal.setAuthoritativeCursor(1.5, 0));
assert.throws(() => terminal.write(new Uint8Array(16 * 1024 * 1024 + 1)), /16 MiB/);

setTestFailure("allocation");
assert.throws(() => new GhosttyVtProofTerminal(2, 2, 0), /allocation failure/);
assert.equal(liveHandles(), 1);
setTestFailure("wrap");
assert.throws(() => new GhosttyVtProofTerminal(2, 2, 0), /wrap failure/);
assert.equal(liveHandles(), 1);

terminal.write(bytes("dirty-before-atomic-failure"));
setTestFailure("dirtyAck");
assert.throws(() => terminal.project(), /dirty acknowledgement failure/);
snapshot = terminal.project();
assert.ok(
  snapshot.viewportRows.length > 0,
  "atomic dirty failure cannot partially acknowledge rows",
);

terminal.project();
setTestFailure("write");
assert.throws(() => terminal.write(bytes("\r\nfailed-scroll")), /write failure/);
snapshot = terminal.project();
assert.equal(snapshot.historyAppend.length, 0);
assert.equal(snapshot.historyTrim, 0);

terminal.dispose();
terminal.dispose();
assert.equal(liveHandles(), 0);
assert.throws(() => terminal.project(), /disposed/);

for (let cycle = 0; cycle < 30; cycle += 1) {
  const candidate = new GhosttyVtProofTerminal(80, 24, 100);
  candidate.write(bytes(`cycle-${cycle}\r\n`));
  assert.equal(candidate.project().viewportRows[0].cells[0].grapheme, "c");
  candidate.dispose();
  assert.equal(liveHandles(), 0);
}

console.log(
  JSON.stringify({
    ok: true,
    node: process.versions.node,
    napi: process.versions.napi,
    requiredNapi: REQUIRED_NAPI_VERSION,
    lifecycleCycles: 30,
    liveHandles: liveHandles(),
  }),
);
