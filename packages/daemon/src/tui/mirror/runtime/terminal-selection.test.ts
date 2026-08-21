import { describe, expect, it } from "vitest";
import type { TerminalReplicaCell, TerminalReplicaSnapshot } from "@tmux-ide/contracts";

import {
  extractTerminalSelection,
  terminalMouseActionSupported,
  terminalGestureLeaseMatches,
  terminalSelectionCell,
  terminalSgrMouse,
  type TerminalGestureLease,
} from "./terminal-selection.ts";

const color = { kind: "default" as const };
const cell = (grapheme: string, width: 0 | 1 | 2 = 1): TerminalReplicaCell => ({
  grapheme,
  width,
  foreground: color,
  background: color,
  attributes: 0,
});
const row = (cells: TerminalReplicaCell[]) => ({ cells, wrapped: false });
const snapshot = (): TerminalReplicaSnapshot => ({
  cols: 6,
  rows: 2,
  history: [row([cell("h"), cell("i"), cell(" "), cell(" "), cell(" "), cell(" ")])],
  grid: [
    row([cell("A"), cell("界", 2), cell("", 0), cell("e\u0301"), cell(" "), cell(" ")]),
    row([cell("z"), cell("e"), cell("r"), cell("o"), cell(" "), cell(" ")]),
  ],
  cursor: { x: 0, y: 0, hidden: false, style: "block", blink: false },
  modes: {
    alternateScreen: false,
    applicationCursor: false,
    applicationKeypad: false,
    bracketedPaste: false,
    insert: false,
    origin: false,
    wraparound: true,
    mouseTracking: false,
    synchronizedOutput: false,
  },
  placements: [],
  bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
});

describe("terminal selection", () => {
  it("maps visible cells into absolute history space and extracts terminal cells", () => {
    const state = snapshot();
    expect(terminalSelectionCell(state, 1, 0)).toEqual({ row: 1, col: 1 });
    expect(extractTerminalSelection(state, { row: 0, col: 0 }, { row: 2, col: 3 })).toEqual({
      text: "hi\nA界é\nzero",
      bytes: Buffer.byteLength("hi\nA界é\nzero", "utf8"),
    });
  });

  it("maps a wide continuation to its semantic owner and never drops the glyph", () => {
    const state = snapshot();
    expect(terminalSelectionCell(state, 2, 0)).toEqual({ row: 1, col: 1 });
    expect(extractTerminalSelection(state, { row: 1, col: 2 }, { row: 1, col: 2 })).toEqual({
      text: "界",
      bytes: Buffer.byteLength("界"),
    });
    expect(extractTerminalSelection(state, { row: 1, col: 2 }, { row: 1, col: 3 })).toEqual({
      text: "界é",
      bytes: Buffer.byteLength("界é"),
    });
  });

  it("joins wrapped history and viewport rows without inventing a newline", () => {
    const state = snapshot();
    state.grid[0]!.wrapped = true;
    expect(extractTerminalSelection(state, { row: 0, col: 0 }, { row: 1, col: 3 })).toEqual({
      text: "hiA界é",
      bytes: Buffer.byteLength("hiA界é"),
    });
  });

  it("rejects orphan continuation cells at the row boundary", () => {
    const state = snapshot();
    state.grid[0]!.cells[0] = cell("", 0);
    expect(terminalSelectionCell(state, 0, 0)).toBeNull();
    expect(extractTerminalSelection(state, { row: 1, col: 0 }, { row: 1, col: 0 })).toBeNull();
  });

  it("fences a gesture across runtime, canonical mode, history and layout replacement", () => {
    const state = snapshot();
    state.modes.mouseProtocol = "drag";
    state.modes.mouseEncoding = "sgr";
    const connection = {};
    const client = {};
    const adapter = {};
    const runtime = {
      daemonGeneration: "11111111-1111-4111-8111-111111111111",
      clientGeneration: 2,
      connection,
      client,
      adapter,
      rendererEpoch: 3,
    };
    const identity = {
      generation: "22222222-2222-4222-8222-222222222222",
      incarnation: "22222222-2222-4222-8222-222222222222:0",
      revision: 4,
      stateHash: "hash",
      cols: state.cols,
      rows: state.rows,
      sourceEpoch: 5,
      historyTrim: 0,
    };
    const frame = { left: 0, top: 0, width: 6, height: 2, contentHeight: 2 };
    const lease: TerminalGestureLease = {
      paneId: "pane.a",
      runtime,
      sourceEpoch: identity.sourceEpoch,
      canonicalIdentity: identity,
      snapshot: state,
      historyLength: state.history.length,
      historyTrim: 0,
      mouseProtocol: state.modes.mouseProtocol,
      mouseEncoding: state.modes.mouseEncoding,
      frame,
    };
    const current = { runtime, identity, snapshot: state, frame };
    expect(terminalGestureLeaseMatches(lease, current)).toBe(true);
    expect(
      terminalGestureLeaseMatches(lease, {
        ...current,
        runtime: { ...runtime, connection: {} },
      }),
    ).toBe(false);
    expect(
      terminalGestureLeaseMatches(lease, {
        ...current,
        identity: { ...identity, revision: 5 },
      }),
    ).toBe(false);
    expect(
      terminalGestureLeaseMatches(lease, {
        ...current,
        snapshot: { ...state, history: [...state.history, state.grid[0]!] },
      }),
    ).toBe(false);
    expect(
      terminalGestureLeaseMatches(lease, {
        ...current,
        snapshot: {
          ...state,
          modes: { ...state.modes, mouseProtocol: "any" },
        },
      }),
    ).toBe(false);
    expect(
      terminalGestureLeaseMatches(lease, {
        ...current,
        identity: { ...identity, historyTrim: 1 },
      }),
    ).toBe(false);
    expect(terminalGestureLeaseMatches(lease, { ...current, frame: { ...frame, left: 1 } })).toBe(
      false,
    );
  });

  it("fails closed on geometry, bounds, and byte overflow", () => {
    const state = snapshot();
    expect(terminalSelectionCell(state, 6, 0)).toBeNull();
    expect(extractTerminalSelection(state, { row: -1, col: 0 }, { row: 0, col: 0 })).toBeNull();
    expect(extractTerminalSelection(state, { row: 0, col: 0 }, { row: 2, col: 3 }, 3)).toBeNull();
  });

  it("encodes exact SGR press, drag, release and modifiers", () => {
    expect(terminalSgrMouse({ action: "down", column: 2, row: 3 })).toBe("\u001b[<0;3;4M");
    expect(terminalSgrMouse({ action: "drag", column: 2, row: 3, shift: true, ctrl: true })).toBe(
      "\u001b[<52;3;4M",
    );
    expect(terminalSgrMouse({ action: "up", column: 2, row: 3 })).toBe("\u001b[<0;3;4m");
    expect(terminalSgrMouse({ action: "wheel-up", column: 2, row: 3 })).toBe("\u001b[<64;3;4M");
    expect(terminalSgrMouse({ action: "down", column: -1, row: 0 })).toBeNull();
  });

  it("fails closed unless the exact parser protocol and SGR cell encoding support the action", () => {
    const state = snapshot();
    state.modes.mouseTracking = true;
    expect(terminalMouseActionSupported(state, "down")).toBe(false);
    state.modes.mouseEncoding = "sgr";
    state.modes.mouseProtocol = "x10";
    expect(terminalMouseActionSupported(state, "down")).toBe(true);
    expect(terminalMouseActionSupported(state, "up")).toBe(false);
    state.modes.mouseProtocol = "drag";
    expect(terminalMouseActionSupported(state, "drag")).toBe(true);
    expect(terminalMouseActionSupported(state, "move")).toBe(false);
    state.modes.mouseProtocol = "any";
    expect(terminalMouseActionSupported(state, "move")).toBe(true);
  });
});
