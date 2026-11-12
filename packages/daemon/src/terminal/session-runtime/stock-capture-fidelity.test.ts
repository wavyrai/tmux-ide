import { decodeNativeGridCapture } from "../mirror/native-grid-capture.ts";
import { expect, it } from "vitest";
import { getLogBuffer } from "../../lib/log.ts";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
const make = () =>
  new TerminalReplicaInterpreter({
    generation: "00000000-0000-4000-8000-000000000001",
    workspaceName: "tabs",
    semanticPaneId: "pane.tabs",
    incarnation: "tabs:0",
    cols: 8,
    rows: 4,
    onUpdate: () => {},
  });
it("paints a captured tab to the next tab stop with its background, and leaves live HT as motion", async () => {
  const interpreter = make();
  try {
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 4,
      chunks: [Buffer.from("\x1b[1m\x1b[32m\x1b[48;5;17mA\x1b[0m\x1b[48;5;17m\t\x1b[1m\x1b[32mB")],
      cursor: { x: 8, y: 0 },
      bootstrap: "painted-capture",
    });
    const painted = interpreter.currentSnapshot().grid[0]!.cells;
    expect(painted[0]!.grapheme).toBe("A");
    // tmux never tabs into the last column: the tab cell ends at column 6.
    expect(painted[7]!.grapheme).toBe("B");
    expect(painted[0]!.background).not.toEqual({ kind: "default" });
    // Like tmux's own tab cell: blank cells in the cell's background, not typed spaces.
    for (let x = 1; x < 7; x++) {
      expect(painted[x]!.background).toEqual(painted[0]!.background);
      expect(painted[x]!.grapheme).toBe("");
    }
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 4,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    await interpreter.enqueue({ type: "write", data: Buffer.from("\x1b[48;5;17mA\tB") });
    const cells = interpreter.currentSnapshot().grid[0]!.cells;
    expect(cells[0]!.grapheme).toBe("A");
    expect(cells[7]!.grapheme).toBe("B");
    for (let x = 1; x < 7; x++) expect(cells[x]!.background).toEqual({ kind: "default" });
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});
it("paints captured tabs at the default stops across rows and chunk boundaries", async () => {
  const interpreter = new TerminalReplicaInterpreter({
    generation: "00000000-0000-4000-8000-000000000001",
    workspaceName: "tabs",
    semanticPaneId: "pane.tabs",
    incarnation: "tabs:0",
    cols: 24,
    rows: 4,
    onUpdate: () => {},
  });
  const column = (row: number, grapheme: string) =>
    interpreter.currentSnapshot().grid[row]!.cells.findIndex((cell) => cell.grapheme === grapheme);
  try {
    await interpreter.enqueue({
      type: "reseed",
      cols: 24,
      rows: 4,
      // Row 0: "ab<tab>c<tab>d". Row 1 starts with a tab. Row 2's tab opens the next chunk.
      chunks: [Buffer.from("ab\tc\td\r\n\te\r\nfghijklmn"), Buffer.from("\to")],
      cursor: { x: 17, y: 2 },
      bootstrap: "painted-capture",
    });
    expect([column(0, "c"), column(0, "d"), column(1, "e"), column(2, "o")]).toEqual([
      8, 16, 8, 16,
    ]);
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});
it("does not classify explicitly identified live tail as painted capture", async () => {
  const interpreter = make();
  try {
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 4,
      chunks: [Buffer.from("A"), Buffer.from("\tB")],
      captureChunks: [Buffer.from("A")],
      cursor: { x: 8, y: 0 },
      bootstrap: "painted-capture",
    });
    expect(interpreter.currentSnapshot().grid[0]!.cells[7]!.grapheme).toBe("B");
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});

it("imports native painted backing and permits its live HT tail", async () => {
  const interpreter = make();
  const native = decodeNativeGridCapture(
    JSON.stringify({
      version: 2,
      cols: 8,
      rows: 4,
      history: 0,
      hscrolled: 0,
      limit: 100,
      cursor: [0, 0],
      currentAttributes: [0, 8, 8, 8],
    }) +
      "\n" +
      Array.from({ length: 4 }, (_, row) =>
        JSON.stringify({ row, flags: 0, used: 0, cells: [] }),
      ).join("\n"),
  )!;
  try {
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 4,
      native,
      chunks: [Buffer.from("A\tB")],
      captureChunks: [],
      cursor: { x: 8, y: 0 },
      bootstrap: "painted-capture",
    });
    expect(interpreter.currentSnapshot().grid[0]!.cells[7]!.grapheme).toBe("B");
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});

it("owns captured provenance bytes before asynchronous application", async () => {
  const interpreter = make();
  const capture = Buffer.from("A\tB");
  const captures = [capture];
  try {
    const pending = interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 4,
      chunks: [capture],
      captureChunks: captures,
      cursor: { x: 8, y: 0 },
      bootstrap: "painted-capture",
    });
    capture.fill(32);
    captures.length = 0;
    await pending;
    // The bytes admitted were "A<tab>B", not the caller's later overwrite.
    const cells = interpreter.currentSnapshot().grid[0]!.cells;
    expect([cells[0]!.grapheme, cells[7]!.grapheme]).toEqual(["A", "B"]);
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});
it("logs once per pane that tab positions were reconstructed", async () => {
  const noted = () =>
    getLogBuffer().filter((entry) => entry.msg === "stock capture: tab positions reconstructed");
  const before = noted().length;
  const interpreter = make();
  try {
    for (const text of ["A\tB", "C\tD", "plain"])
      await interpreter.enqueue({
        type: "reseed",
        cols: 8,
        rows: 4,
        chunks: [Buffer.from(text)],
        cursor: { x: 0, y: 0 },
        bootstrap: "painted-capture",
      });
    expect(noted().slice(before)).toMatchObject([
      {
        level: "info",
        component: "terminal-replica",
        data: { pane: "pane.tabs", workspace: "tabs" },
      },
    ]);
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});
