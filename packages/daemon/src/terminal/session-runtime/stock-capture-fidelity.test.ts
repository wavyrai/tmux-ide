import { decodeNativeGridCapture } from "../mirror/native-grid-capture.ts";
import { expect, it } from "vitest";
import { TerminalReplicaInterpreter } from "./terminal-replica-interpreter.ts";
import { StockCaptureTabUnavailableError } from "./stock-capture-fidelity.ts";
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
it("rejects lossy captured tabs before publishing a replacement and leaves live HT unchanged", async () => {
  const interpreter = make();
  try {
    await interpreter.enqueue({
      type: "reseed",
      cols: 8,
      rows: 4,
      chunks: [Buffer.from("safe")],
      cursor: { x: 4, y: 0 },
      bootstrap: "painted-capture",
    });
    const before = interpreter.currentSnapshot();
    await expect(
      interpreter.enqueue({
        type: "reseed",
        cols: 8,
        rows: 4,
        chunks: [
          Buffer.from("\x1b[1m\x1b[32m\x1b[48;5;17mA\x1b[0m\x1b[48;5;17m\t\x1b[1m\x1b[32mB"),
        ],
        cursor: { x: 8, y: 0 },
        bootstrap: "painted-capture",
      }),
    ).rejects.toBeInstanceOf(StockCaptureTabUnavailableError);
    expect(interpreter.currentSnapshot()).toEqual(before);
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
    await expect(pending).rejects.toBeInstanceOf(StockCaptureTabUnavailableError);
    expect(interpreter.currentSeed()).toBeNull();
  } finally {
    await interpreter.enqueue({ type: "close", reason: "fixture-complete" });
  }
});
