/**
 * Input-latency perf tap for the mirror pipeline — the third scenario tap
 * alongside control-client's feed-parse tap (/tmp/zz-feed.log) and app.tsx's
 * snapshot/tick tap (/tmp/zz-perf.log).
 *
 * It measures the three hops a keystroke takes through the mirror:
 *   t0  the app forwards the key to the focused pane (send-keys)          → sent()
 *   t1  the first `%output` for that pane arrives back (the echo)         → output()
 *   t2  the next paint tick consumes the dirty flag and re-snapshots      → tick()
 *
 * The pure {@link InputTap} state machine carries the logic (one entry per
 * pane in flight, keyed by pane id); the module-level `tap*` wrappers are the
 * allocation-light io shell, strictly gated behind `TMUX_IDE_ZZ_PERF` and
 * appending `paneId echoMs paintMs` lines to /tmp/zz-input.log.
 *
 * {@link percentile}/{@link summarize} are the pure reporting helpers the
 * harness (scripts/perf-mirror.mjs) uses to turn the raw logs into p50/p95.
 */
import { appendFileSync } from "node:fs";

const INPUT_LOG = "/tmp/zz-input.log";

/** One fully-observed keystroke round-trip. */
export interface InputSample {
  paneId: string;
  /** t1 − t0: keystroke dispatch → first echo byte back from the pane. */
  echoMs: number;
  /** t2 − t0: keystroke dispatch → the paint tick that re-snapshots the echo. */
  paintMs: number;
}

/**
 * PURE — the three-hop input-latency state machine.
 *
 * At most one keystroke is tracked per pane (a later `sent` for the same pane
 * overwrites an unfinished one — the scenario types with gaps so each key
 * round-trips before the next). `tick` drains every pane that has seen its
 * echo, emitting a sample and clearing it; panes still awaiting an echo stay
 * in flight. No timers, no clock reads of its own — the caller passes `now`.
 */
export class InputTap {
  private readonly inFlight = new Map<string, { t0: number; t1: number }>();

  /** t0 — the app forwarded a key to `paneId`. */
  sent(paneId: string, now: number): void {
    if (!paneId) return;
    this.inFlight.set(paneId, { t0: now, t1: 0 });
  }

  /** t1 — first `%output` for `paneId` after a `sent` (later bytes ignored). */
  output(paneId: string, now: number): void {
    const rec = this.inFlight.get(paneId);
    if (rec && rec.t1 === 0) rec.t1 = now;
  }

  /** t2 — a paint tick; emit + clear every pane whose echo has landed. */
  tick(now: number): InputSample[] {
    if (this.inFlight.size === 0) return [];
    const out: InputSample[] = [];
    for (const [paneId, rec] of this.inFlight) {
      if (rec.t1 === 0) continue;
      out.push({ paneId, echoMs: rec.t1 - rec.t0, paintMs: now - rec.t0 });
      this.inFlight.delete(paneId);
    }
    return out;
  }

  /** In-flight pane count (test/introspection only). */
  size(): number {
    return this.inFlight.size;
  }
}

// ── io shell: one process-wide tap, gated behind the env flag ───────────────

const singleton = new InputTap();

/** t0 hook — call at the app's key-forward site. No-op unless TMUX_IDE_ZZ_PERF. */
export function tapInputSent(paneId: string): void {
  if (!process.env.TMUX_IDE_ZZ_PERF) return;
  singleton.sent(paneId, performance.now());
}

/** t1 hook — call from SessionMirror's onOutput. No-op unless TMUX_IDE_ZZ_PERF. */
export function tapInputOutput(paneId: string): void {
  if (!process.env.TMUX_IDE_ZZ_PERF) return;
  singleton.output(paneId, performance.now());
}

/** t2 hook — call from the paint tick after setPanes. Flushes to /tmp/zz-input.log. */
export function tapInputTick(): void {
  if (!process.env.TMUX_IDE_ZZ_PERF) return;
  const samples = singleton.tick(performance.now());
  for (const s of samples) {
    try {
      appendFileSync(INPUT_LOG, `${s.paneId} ${s.echoMs.toFixed(2)} ${s.paintMs.toFixed(2)}\n`);
    } catch {
      /* perf tap only */
    }
  }
}

// ── size re-pin tap (M22.8) ─────────────────────────────────────────────────
// Every canvas-area change (terminal resize, sidebar drag) funnels through the
// mirror's `resize()` — the ONE re-pin chokepoint. This tap records each re-pin
// so a live drag/resize burst can be asserted against the expected count (since
// M23.5 the renderer dims signal re-pins per actual size change — no more 200ms
// poll). Gated behind TMUX_IDE_ZZ_PERF, appending `cols rows` lines to
// /tmp/zz-repin.log.

const REPIN_LOG = "/tmp/zz-repin.log";

/** Record one re-pin (a `refresh-client -C cols x rows`). No-op unless the flag. */
export function tapRepin(cols: number, rows: number): void {
  if (!process.env.TMUX_IDE_ZZ_PERF) return;
  try {
    appendFileSync(REPIN_LOG, `${cols} ${rows}\n`);
  } catch {
    /* perf tap only */
  }
}

// ── resize tap (M23.5) ──────────────────────────────────────────────────────
// The event-driven geometry pipeline's flight recorder: one timestamped line
// per hop — %layout-change received (`notify`), geometry applied into the
// mirrors (`geometry-applied`), a canvas re-pin (`repin`), a per-pane term
// resize (`pane-resize`), and per-%output mirror dims (`output`) — so a resize
// battery can assert "geometry applied <5ms after the notify" and "no %output
// parsed into stale dims" straight from the log. Own env gate
// (TMUX_IDE_ZZ_RESIZE_TAP): the per-output line is too chatty for the general
// TMUX_IDE_ZZ_PERF sessions.

const RESIZE_LOG = "/tmp/zz-resize-tap.log";

/** Append one `<t> <event> <detail>` line. No-op unless TMUX_IDE_ZZ_RESIZE_TAP. */
export function tapResize(event: string, detail = ""): void {
  if (!process.env.TMUX_IDE_ZZ_RESIZE_TAP) return;
  try {
    appendFileSync(
      RESIZE_LOG,
      `${performance.now().toFixed(2)} ${event}${detail ? ` ${detail}` : ""}\n`,
    );
  } catch {
    /* perf tap only */
  }
}

// ── pure reporting helpers (used by scripts/perf-mirror.mjs) ────────────────

/** A percentile of an ASCENDING-sorted array, linearly interpolated. Empty → 0. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = (Math.max(0, Math.min(100, p)) / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = rank - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
}

/** Distribution summary of `values` (order-independent — sorts a copy). */
export function summarize(values: number[]): Summary {
  const n = values.length;
  if (n === 0) return { count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count: n,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0]!,
    max: sorted[n - 1]!,
    mean: sum / n,
  };
}
