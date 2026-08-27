// Native-consumable subset of @tmux-ide/core TERMINAL_CONFORMANCE_FIXTURES.
// These expected values are produced by the pinned xterm oracle and retain the
// same fixture IDs so drift is reviewable across the native/TS boundary.
export const XTERM_FIXTURES = Object.freeze([
  {
    id: "soft-wrap-row",
    cols: 4,
    rows: 2,
    writes: ["ABCDE"],
    wrappedRows: [1],
    cells: [
      { row: 0, column: 0, grapheme: "A", width: 1 },
      { row: 1, column: 0, grapheme: "E", width: 1 },
      { row: 1, column: 3, grapheme: " ", width: 1 },
    ],
  },
  {
    id: "wide-and-combined-graphemes",
    cols: 12,
    rows: 2,
    writes: ["A界e\u0301🙂"],
    wrappedRows: [],
    cells: [
      { row: 0, column: 0, grapheme: "A", width: 1 },
      { row: 0, column: 1, grapheme: "界", width: 2 },
      { row: 0, column: 2, grapheme: "", width: 0 },
      { row: 0, column: 3, grapheme: "é", width: 1 },
      { row: 0, column: 4, grapheme: "🙂", width: 2 },
      { row: 0, column: 5, grapheme: "", width: 0 },
    ],
  },
]);
