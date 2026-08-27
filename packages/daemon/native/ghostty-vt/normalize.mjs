function canonicalCell(cell) {
  return {
    grapheme: cell.grapheme,
    width: cell.width,
    foreground: cell.foreground,
    background: cell.background,
    attributes: cell.attributes,
  };
}

function canonicalRow(row) {
  return { cells: row.cells.map(canonicalCell), wrapped: row.wrapped };
}

/** Convert the private native transaction into the strict shared snapshot shape. */
export function applyNativeProjection(previous, transaction) {
  const dimensionsChanged =
    previous === null || previous.cols !== transaction.cols || previous.rows !== transaction.rows;
  if (transaction.kind === "delta" && dimensionsChanged)
    throw new Error("native delta cannot change terminal dimensions");
  if (transaction.kind === "seed" && transaction.viewportRows.length !== transaction.rows)
    throw new Error("native seed must contain every viewport row");

  const grid =
    transaction.kind === "seed"
      ? Array.from({ length: transaction.rows })
      : previous.grid.map((row) => row);
  for (const nativeRow of transaction.viewportRows) {
    if (
      !Number.isSafeInteger(nativeRow.index) ||
      nativeRow.index < 0 ||
      nativeRow.index >= transaction.rows
    )
      throw new Error("native viewport row index is outside the grid");
    grid[nativeRow.index] = canonicalRow(nativeRow);
  }
  if (grid.some((row) => row === undefined)) throw new Error("native projection left a grid hole");

  const priorHistory = transaction.kind === "seed" ? [] : previous.history;
  if (transaction.historyTrim > priorHistory.length)
    throw new Error("native history trim exceeds the prior history");
  const history = priorHistory
    .slice(transaction.historyTrim)
    .concat(transaction.historyAppend.map(canonicalRow));

  return {
    cols: transaction.cols,
    rows: transaction.rows,
    grid,
    history,
    cursor: transaction.cursor,
    modes: transaction.modes,
    placements: [],
    bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
  };
}
