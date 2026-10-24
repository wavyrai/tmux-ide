/** Opt-in controlled nonce workload; renderer-buffer completion, never visible pixels. */
import type { TerminalReplicaState } from "@tmux-ide/core";
import { visibleTerminalRowAt } from "../semantic-pane-render-source.ts";
import type { TerminalReplicaRow, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type { SessionRuntimeTerminalInput } from "@tmux-ide/contracts";
import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
export interface ProbeTrial {
  id: string;
  nonce: string;
  kind?: "input" | "scroll" | "output";
}
export interface ProbeRecord extends ProbeTrial {
  side: "tui";
  kind: "input" | "scroll" | "output";
  sourceScope: Scope;
  expectedOffset: number;
  sourceOffset: number;
  expectedScope: Scope;
  admittedAtMicros: number;
  completedAtMicros: number;
  witness?: { row: number; column: number; marker: string; revision: number; stateHash: string };
  endpoint: "input-admission-to-renderer-work-complete";
  status: "completed" | "failed";
  durationMicros?: number;
  reason?: string;
}
interface Scope {
  pane: string;
  generation: string;
  incarnation: string;
  cols: number;
  rows: number;
}
function scope(state: TerminalReplicaState): Scope | null {
  return state.snapshot
    ? {
        pane: state.semanticPaneId,
        generation: state.generation,
        incarnation: state.incarnation,
        cols: state.snapshot.cols,
        rows: state.snapshot.rows,
      }
    : null;
}
const key = (s: Scope) => JSON.stringify([s.pane, s.generation, s.incarnation, s.cols, s.rows]);
export class RendererProbe {
  #next = 0;
  #pending: {
    trial: ProbeTrial;
    scope: Scope;
    at: number;
    marker: string;
    offset: number;
    sourceOffset: number;
  } | null = null;
  constructor(
    private readonly trials: readonly ProbeTrial[],
    private readonly emit: (r: ProbeRecord) => void,
  ) {
    if (
      trials.length > 64 ||
      new Set(trials.map((t) => t.nonce)).size !== trials.length ||
      trials.some(
        (t) =>
          !t.id ||
          t.id.length > 128 ||
          !/^[a-f0-9]{32}$/.test(t.nonce) ||
          (t.kind !== undefined && !["input", "scroll", "output"].includes(t.kind)),
      )
    )
      throw new Error("Invalid renderer probe trials");
  }
  get pending(): boolean {
    return this.#pending !== null;
  }
  admit(
    input: SessionRuntimeTerminalInput,
    state: TerminalReplicaState | null,
    at: number,
  ): SessionRuntimeTerminalInput | null {
    if (
      input.kind !== "text" ||
      input.data !== "!" ||
      !state?.snapshot ||
      this.#pending ||
      !this.trials[this.#next]
    )
      return null;
    if (this.trials[this.#next]?.kind === "scroll")
      return { kind: "text", data: `PROBE-PREPARE-SCROLL:${this.trials[this.#next]!.nonce}\n` };
    const trial = this.trials[this.#next++]!,
      marker = `PROBE-OUTPUT:${trial.nonce}`,
      identity = scope(state)!;
    this.#pending = { trial, scope: identity, at, marker, offset: 0, sourceOffset: 0 };
    if (
      state.snapshot.cols < marker.length ||
      state.snapshot.grid.some((r) =>
        r.cells
          .map((c) => c.grapheme)
          .join("")
          .includes(marker),
      )
    ) {
      this.cancel("negative-control", at);
      return null;
    }
    return {
      kind: "text",
      data: `${trial.kind === "output" ? "PROBE-BURST" : "PROBE-IN"}:${trial.nonce}\n`,
    };
  }
  scroll(
    identity: Scope,
    snapshot: TerminalReplicaSnapshot,
    before: number,
    after: number,
    at: number,
  ): void {
    const trial = this.trials[this.#next];
    if (this.#pending || trial?.kind !== "scroll" || before === after) return;
    const row = visibleTerminalRowAt(snapshot, after, 0);
    const text =
      row?.cells
        .map((c) => c.grapheme)
        .join("")
        .trimEnd() ?? "";
    if (!new RegExp(`^PROBE-ROW:${trial.nonce}:[0-9]{4}$`).test(text)) return;
    for (let y = 0; y < snapshot.rows; y++)
      if (
        visibleTerminalRowAt(snapshot, before, y)
          ?.cells.map((c) => c.grapheme)
          .join("")
          .trimEnd() === text
      )
        return;
    this.#next++;
    this.#pending = {
      trial,
      scope: identity,
      at,
      marker: text,
      offset: after,
      sourceOffset: before,
    };
  }
  tick(at: number): void {
    if (this.#pending && at - this.#pending.at > 5_000_000) this.cancel("timeout", at);
  }
  cancel(reason: string, at: number): void {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    this.emit({
      ...p.trial,
      side: "tui",
      kind: p.trial.kind ?? "input",
      sourceScope: p.scope,
      expectedScope: p.scope,
      sourceOffset: p.sourceOffset,
      expectedOffset: p.offset,
      admittedAtMicros: p.at,
      completedAtMicros: at,
      endpoint: "input-admission-to-renderer-work-complete",
      status: "failed",
      reason,
    });
  }
  observe(state: TerminalReplicaState | null, at: number): void {
    if (!this.#pending) return;
    if (state && state.semanticPaneId !== this.#pending.scope.pane) return;
    if (!state || !scope(state) || key(scope(state)!) !== key(this.#pending.scope))
      this.cancel("scope-changed", at);
    else if (at - this.#pending.at > 5_000_000) this.cancel("timeout", at);
  }
  row(
    state: TerminalReplicaState,
    row: TerminalReplicaRow | undefined,
    viewportRow: number,
    width: number,
    height: number,
    left: number,
    scrollOffset: number,
    at: number,
  ): void {
    this.observe(state, at);
    const p = this.#pending;
    if (!p || state.semanticPaneId !== p.scope.pane) return;
    if (
      scrollOffset !== p.offset ||
      left !== 0 ||
      viewportRow !== 0 ||
      height < 1 ||
      width < p.marker.length ||
      !row
    )
      return;
    const cells = row.cells.slice(0, p.marker.length);
    if (cells.some((c) => c.width !== 1) || cells.map((c) => c.grapheme).join("") !== p.marker)
      return;
    if (!Number.isSafeInteger(at) || at < p.at) {
      this.cancel("clock-invalid", at);
      return;
    }
    this.#pending = null;
    this.emit({
      ...p.trial,
      side: "tui",
      kind: p.trial.kind ?? "input",
      sourceScope: p.scope,
      expectedScope: p.scope,
      sourceOffset: p.sourceOffset,
      expectedOffset: p.offset,
      admittedAtMicros: p.at,
      completedAtMicros: at,
      endpoint: "input-admission-to-renderer-work-complete",
      status: "completed",
      durationMicros: at - p.at,
      witness: {
        row: viewportRow,
        column: 0,
        marker: p.marker,
        revision: state.revision,
        stateHash: state.hash,
      },
    });
  }
}
let singleton: RendererProbe | null | undefined;
/** All filesystem work is asynchronous and deferred; at most64 short receipts. */
export function rendererProbe(): RendererProbe | null {
  if (singleton !== undefined) return singleton;
  singleton = null;
  if (process.env.TMUX_IDE_RENDERER_FIXTURE !== "1") return null;
  const raw = process.env.TMUX_IDE_RENDERER_PROBE_TRIALS,
    path = process.env.TMUX_IDE_RENDERER_PROBE_LOG;
  if (!raw || raw.length > 16384 || !path || !isAbsolute(path)) return null;
  try {
    const trials: unknown = JSON.parse(raw);
    if (!Array.isArray(trials)) return null;
    let writes = Promise.resolve(),
      failed = false;
    singleton = new RendererProbe(trials, (record) => {
      if (failed) return;
      writes = writes
        .then(() => appendFile(path, JSON.stringify(record) + "\n", { mode: 0o600 }))
        .catch(() => {
          failed = true;
        });
    });
    const timer = setInterval(() => singleton?.tick(Math.floor(performance.now() * 1000)), 250);
    timer.unref();
  } catch {
    singleton = null;
  }
  return singleton;
}
