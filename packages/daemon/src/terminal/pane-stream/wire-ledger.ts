/**
 * PaneStreamWireLedger — PURE backpressure bookkeeping for the pane-stream
 * wire (m43 card 2). This is the wire-side extension of the service-internal
 * {@link ../mirror/flow-ledger.ts FlowLedger}: tickets are accounted per
 * (client x pane x owner), where the owners are the two queues a delivery can
 * be stuck in:
 *
 *   - `ws-send-buffer`  — bytes accepted by the socket but not yet drained to
 *     the kernel (unit: bytes);
 *   - `renderer-backlog` — pane frames delivered but not yet applied by an
 *     acking renderer (unit: frames).
 *
 * The ledger only answers "is this client's view of this pane stalled?"; the
 * connection owns the actuators (MirrorService freeze/thaw for exactly that
 * subscriber — a stalled client pauses ONLY its own delivery; the control-mode
 * pause engages upstream only when EVERY subscriber of a pane is parked, which
 * the session channel already models).
 *
 * Tickets are never silently cancelled: departure force-returns every ticket
 * of the client and reports what was returned (the L4 canvas-reference law).
 * Stall/resume carries hysteresis so a queue hovering at its budget does not
 * flap freeze/thaw (each thaw costs a reseed).
 */
export type PaneStreamFlowOwner = "renderer-backlog" | "ws-send-buffer";

export const PANE_STREAM_FLOW_OWNERS: readonly PaneStreamFlowOwner[] = [
  "renderer-backlog",
  "ws-send-buffer",
];

export interface PaneStreamFlowBudget {
  /** Outstanding tickets above this stall the (client x pane). */
  readonly maxOutstanding: number;
  /** Resume only once outstanding is back at or below this (hysteresis). */
  readonly resumeAt: number;
}

export type PaneStreamFlowBudgets = Readonly<Record<PaneStreamFlowOwner, PaneStreamFlowBudget>>;

export const DEFAULT_PANE_STREAM_FLOW_BUDGETS: PaneStreamFlowBudgets = Object.freeze({
  "ws-send-buffer": Object.freeze({ maxOutstanding: 1 << 20, resumeAt: 256 << 10 }),
  "renderer-backlog": Object.freeze({ maxOutstanding: 512, resumeAt: 128 }),
});

export interface PaneStreamReturnedTickets {
  readonly pane: string;
  readonly owner: PaneStreamFlowOwner;
  readonly returned: number;
}

function validBudget(budget: PaneStreamFlowBudget, owner: string): void {
  if (
    !Number.isSafeInteger(budget.maxOutstanding) ||
    budget.maxOutstanding <= 0 ||
    !Number.isSafeInteger(budget.resumeAt) ||
    budget.resumeAt < 0 ||
    budget.resumeAt > budget.maxOutstanding
  ) {
    throw new TypeError(`pane-stream flow budget for ${owner} is invalid`);
  }
}

export class PaneStreamWireLedger {
  private readonly budgets: PaneStreamFlowBudgets;
  /** client → pane → owner → outstanding tickets. */
  private readonly clients = new Map<string, Map<string, Map<PaneStreamFlowOwner, number>>>();

  constructor(budgets: PaneStreamFlowBudgets = DEFAULT_PANE_STREAM_FLOW_BUDGETS) {
    validBudget(budgets["ws-send-buffer"], "ws-send-buffer");
    validBudget(budgets["renderer-backlog"], "renderer-backlog");
    this.budgets = budgets;
  }

  take(client: string, pane: string, owner: PaneStreamFlowOwner, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    const panes = this.clients.get(client) ?? new Map<string, Map<PaneStreamFlowOwner, number>>();
    this.clients.set(client, panes);
    const owners = panes.get(pane) ?? new Map<PaneStreamFlowOwner, number>();
    panes.set(pane, owners);
    owners.set(owner, (owners.get(owner) ?? 0) + amount);
  }

  /** Return tickets. Over-returns clamp at zero — a return can never mint. */
  give(client: string, pane: string, owner: PaneStreamFlowOwner, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) return;
    const owners = this.clients.get(client)?.get(pane);
    if (!owners) return;
    const next = Math.max(0, (owners.get(owner) ?? 0) - amount);
    if (next === 0) owners.delete(owner);
    else owners.set(owner, next);
    this.prune(client, pane);
  }

  outstanding(client: string, pane: string, owner: PaneStreamFlowOwner): number {
    return this.clients.get(client)?.get(pane)?.get(owner) ?? 0;
  }

  /** Any owner over budget stalls this client's view of this pane — and only
   *  this client's. */
  isStalled(client: string, pane: string): boolean {
    return PANE_STREAM_FLOW_OWNERS.some(
      (owner) => this.outstanding(client, pane, owner) > this.budgets[owner].maxOutstanding,
    );
  }

  /** Every owner back under its resume threshold (hysteresis satisfied). */
  shouldResume(client: string, pane: string): boolean {
    return PANE_STREAM_FLOW_OWNERS.every(
      (owner) => this.outstanding(client, pane, owner) <= this.budgets[owner].resumeAt,
    );
  }

  /** Departure: force-return every ticket the client holds, reporting them. */
  forceReturnClient(client: string): readonly PaneStreamReturnedTickets[] {
    const panes = this.clients.get(client);
    if (!panes) return [];
    const returned: PaneStreamReturnedTickets[] = [];
    for (const [pane, owners] of panes) {
      for (const [owner, amount] of owners) {
        if (amount > 0) returned.push({ pane, owner, returned: amount });
      }
    }
    this.clients.delete(client);
    return returned;
  }

  /** A pane closed for one client: its tickets return with it. */
  forgetPane(client: string, pane: string): void {
    const panes = this.clients.get(client);
    if (!panes) return;
    panes.delete(pane);
    if (panes.size === 0) this.clients.delete(client);
  }

  snapshot(): Record<string, Record<string, Partial<Record<PaneStreamFlowOwner, number>>>> {
    const out: Record<string, Record<string, Partial<Record<PaneStreamFlowOwner, number>>>> = {};
    for (const [client, panes] of this.clients) {
      const paneOut: Record<string, Partial<Record<PaneStreamFlowOwner, number>>> = {};
      for (const [pane, owners] of panes) {
        if (owners.size === 0) continue;
        paneOut[pane] = Object.fromEntries(owners) as Partial<
          Record<PaneStreamFlowOwner, number>
        >;
      }
      if (Object.keys(paneOut).length > 0) out[client] = paneOut;
    }
    return out;
  }

  private prune(client: string, pane: string): void {
    const panes = this.clients.get(client);
    if (!panes) return;
    const owners = panes.get(pane);
    if (owners && owners.size === 0) panes.delete(pane);
    if (panes.size === 0) this.clients.delete(client);
  }
}
