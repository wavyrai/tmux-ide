/** Receiver observations are delivery-boundary states, never physical frames. */
export class TerminalScrollObservations {
  constructor({ scrollRect, readRowIndex, staticCells = [], serializeCell = JSON.stringify }) {
    const { x, y, width, height } = scrollRect;
    if (
      ![x, y, width, height].every(Number.isSafeInteger) ||
      x < 0 ||
      y < 0 ||
      width < 1 ||
      height < 1
    )
      throw new TypeError("Invalid scrolling rectangle");
    if (typeof readRowIndex !== "function" || typeof serializeCell !== "function")
      throw new TypeError("Row reader and cell serializer must be functions");
    this.rect = { x, y, width, height };
    this.readRowIndex = readRowIndex;
    this.serializeCell = serializeCell;
    // Omit excluded cells from this list; capture values now so later mutation cannot hide damage.
    this.staticCells = staticCells.map(({ x, y, cell }) => {
      if (![x, y].every(Number.isSafeInteger) || x < 0 || y < 0)
        throw new TypeError("Invalid static cell coordinate");
      return { x, y, expected: serializeCell(cell) };
    });
    this.observations = [];
    this.closed = false;
  }

  assertTimestamp(at) {
    if (!Number.isFinite(at) || at < 0 || at < (this.observations.at(-1)?.at ?? 0))
      throw new RangeError("Observation timestamps must be finite, nonnegative and monotonic");
    if (this.closed) throw new Error("Observation interval already closed");
  }

  observe(at, snapshot) {
    this.assertTimestamp(at);
    const { x, y, width, height } = this.rect;
    const indices = [];
    for (let row = y; row < y + height; row++) {
      const cells = snapshot.grid[row]?.cells;
      const index =
        cells && cells.length >= x + width ? this.readRowIndex(cells.slice(x, x + width)) : null;
      indices.push(Number.isSafeInteger(index) ? index : null);
    }
    const classification = indices.some((index) => index === null)
      ? "missing"
      : indices.every((index, row) => row === 0 || index === indices[row - 1] + 1)
        ? "coherent"
        : "mixed";
    const staticViolations = this.staticCells
      .filter(({ x, y, expected }) => this.serializeCell(snapshot.grid[y]?.cells[x]) !== expected)
      .map(({ x, y }) => Object.freeze({ x, y }));
    const observation = Object.freeze({
      at,
      classification,
      rowIndices: Object.freeze(indices),
      staticViolations: Object.freeze(staticViolations),
    });
    this.observations.push(observation);
    return observation;
  }

  /** The final observation remains in effect until endAt; no invented terminal flush boundary. */
  close(endAt) {
    this.assertTimestamp(endAt);
    this.closed = true;
    let mixedDurationMs = 0;
    let missingDurationMs = 0;
    let staticViolationDurationMs = 0;
    let openInterval = null;
    const incoherentIntervals = [];
    for (let i = 0; i < this.observations.length; i++) {
      const observation = this.observations[i];
      const until = this.observations[i + 1]?.at ?? endAt;
      const duration = until - observation.at;
      if (observation.classification === "mixed") mixedDurationMs += duration;
      if (observation.classification === "missing") missingDurationMs += duration;
      if (observation.staticViolations.length) staticViolationDurationMs += duration;
      if (observation.classification !== "coherent") openInterval ??= observation.at;
      else if (openInterval !== null) {
        incoherentIntervals.push({
          startAt: openInterval,
          endAt: observation.at,
          durationMs: observation.at - openInterval,
        });
        openInterval = null;
      }
    }
    if (openInterval !== null)
      incoherentIntervals.push({ startAt: openInterval, endAt, durationMs: endAt - openInterval });
    return {
      measurement: "receiver-state-observations",
      observationCount: this.observations.length,
      observedDurationMs: this.observations.length ? endAt - this.observations[0].at : 0,
      mixedDurationMs,
      missingDurationMs,
      incoherentDurationMs: mixedDurationMs + missingDurationMs,
      longestIncoherentIntervalMs: incoherentIntervals.reduce(
        (longest, interval) => Math.max(longest, interval.durationMs),
        0,
      ),
      staticViolationDurationMs,
      staticViolationObservationCount: this.observations.filter(
        (observation) => observation.staticViolations.length > 0,
      ).length,
      incoherentIntervals,
      observations: [...this.observations],
      final: this.observations.at(-1) ?? null,
    };
  }
}
