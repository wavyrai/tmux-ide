// Pure fixture-only bookkeeping. No timers, I/O, transport, or production opt-in.
export const ENDPOINT = "input-admission-to-renderer-work-complete";
const noncePattern = /^[a-f0-9]{32}$/;
export function outputMarker(nonce, row = null) {
  if (
    !noncePattern.test(nonce) ||
    (row !== null && (!Number.isInteger(row) || row < 0 || row > 9999))
  )
    throw new Error("Invalid marker");
  return row === null
    ? `PROBE-OUTPUT:${nonce}`
    : `PROBE-ROW:${nonce}:${String(row).padStart(4, "0")}`;
}
function scopeKey(scope) {
  const keys = ["pane", "generation", "incarnation", "request", "cols", "rows", "viewportOffset"];
  if (!scope || keys.some((k) => scope[k] === undefined)) throw new Error("Incomplete scope");
  for (const k of ["pane", "generation", "incarnation"])
    if (typeof scope[k] !== "string" || !scope[k] || scope[k].length > 512)
      throw new Error("Invalid scope identity");
  for (const k of ["request", "cols", "rows", "viewportOffset"])
    if (!Number.isSafeInteger(scope[k]) || scope[k] < 0) throw new Error("Invalid scope geometry");
  if (!scope.cols || !scope.rows || scope.cols > 1000 || scope.rows > 1000)
    throw new Error("Invalid geometry");
  return JSON.stringify(keys.map((k) => scope[k]));
}
export class RendererProbe {
  #pending = null;
  #seen = new Set();
  #records = [];
  // Caller must explicitly construct only for a prepared fixture; at most64 trials.
  arm({ id, nonce, kind, scope, expectedScope = scope, row = null, atMicros, markerAbsent }) {
    if (this.#pending || this.#seen.size >= 64 || this.#seen.has(nonce)) return false;
    if (
      !noncePattern.test(nonce) ||
      !["input", "scroll", "output"].includes(kind) ||
      typeof id !== "string" ||
      id.length > 128 ||
      !id ||
      !Number.isSafeInteger(atMicros) ||
      atMicros < 0 ||
      markerAbsent !== true
    )
      return false;
    const source = scopeKey(scope),
      expected = scopeKey(expectedScope);
    if (kind !== "scroll" && source !== expected) return false;
    // Scroll may change only offset; source lifetime, selection, and geometry stay exact.
    if (scopeKey({ ...expectedScope, viewportOffset: scope.viewportOffset }) !== source)
      return false;
    this.#seen.add(nonce);
    this.#pending = {
      id,
      nonce,
      kind,
      source,
      expected,
      marker: outputMarker(nonce, row),
      atMicros,
    };
    return true;
  }
  cancel(reason, atMicros) {
    if (!this.#pending) return;
    const p = this.#pending;
    this.#pending = null;
    this.#records.push({
      id: p.id,
      nonce: p.nonce,
      kind: p.kind,
      status: "failed",
      reason,
      atMicros,
      endpoint: ENDPOINT,
    });
  }
  witness({ scope, atMicros, text, row, column, writtenRows, clipped = false }) {
    const p = this.#pending;
    if (!p) return false;
    if (!Number.isSafeInteger(atMicros) || atMicros < p.atMicros) {
      this.cancel("clock-invalid", atMicros);
      return false;
    }
    if (atMicros - p.atMicros > 5_000_000) {
      this.cancel("timeout", atMicros);
      return false;
    }
    const actual = scopeKey(scope);
    if (actual !== p.expected) {
      if (p.kind === "scroll" && actual === p.source) return false;
      this.cancel("scope-changed", atMicros);
      return false;
    }
    if (
      clipped ||
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      column < 0 ||
      row >= scope.rows ||
      column + p.marker.length > scope.cols ||
      !writtenRows.includes(row) ||
      text !== p.marker
    )
      return false;
    this.#pending = null;
    this.#records.push({
      id: p.id,
      nonce: p.nonce,
      kind: p.kind,
      status: "completed",
      durationMicros: atMicros - p.atMicros,
      endpoint: ENDPOINT,
    });
    return true;
  }
  tick(atMicros) {
    if (this.#pending && atMicros - this.#pending.atMicros > 5_000_000)
      this.cancel("timeout", atMicros);
  }
  drain() {
    const result = this.#records;
    this.#records = [];
    return result;
  }
}
