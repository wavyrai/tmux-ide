/**
 * FlowLedger — PURE flow-control bookkeeping for one session channel (v1,
 * service-internal; the wire card extends it to per-client tickets).
 *
 * Two authorities can stop a pane's delivery:
 *
 *   - tmux itself: `%pause` (attach ran with `-f pause-after=N`). Pausing is
 *     STICKY and — measured on 3.7b — hits QUIET panes too after any client
 *     stall, so recovery must continue+reseed EVERY backpressure-paused pane,
 *     not just the noisy one.
 *   - a subscriber: an explicit offscreen-freeze (`refresh-client -A
 *     '%N:pause'`), which recovery must NOT undo — the pane stays parked
 *     until its subscriber thaws it.
 *
 * The ledger only tracks state; the session channel owns the actuators
 * (continue commands + the reseed recipe). Panes are keyed by runtime id
 * here — this type never crosses the service boundary.
 */
export class FlowLedger {
  /** Panes tmux told us it paused (`%pause`). */
  private readonly backpressured = new Set<string>();
  /** Panes WE asked tmux to pause (every subscriber frozen). */
  private readonly requested = new Set<string>();

  notePause(pane: string): void {
    this.backpressured.add(pane);
  }

  /** A continue was issued (or tmux reported `%continue`). */
  noteContinued(pane: string): void {
    this.backpressured.delete(pane);
  }

  requestPause(pane: string): void {
    this.requested.add(pane);
  }

  clearRequest(pane: string): void {
    this.requested.delete(pane);
  }

  forget(pane: string): void {
    this.backpressured.delete(pane);
    this.requested.delete(pane);
  }

  isBackpressured(pane: string): boolean {
    return this.backpressured.has(pane);
  }

  isRequested(pane: string): boolean {
    return this.requested.has(pane);
  }

  /** Every pane a sticky recovery must continue+reseed: backpressure-paused
   *  and not deliberately frozen by its subscribers. */
  stickyRecoverySet(): string[] {
    return [...this.backpressured].filter((pane) => !this.requested.has(pane));
  }

  /** Detached snapshot for telemetry/tests. */
  snapshot(): { backpressured: string[]; requested: string[] } {
    return { backpressured: [...this.backpressured], requested: [...this.requested] };
  }
}
