export interface TerminalPaneInputRouterOptions<Input> {
  readonly select: (paneId: string) => Promise<boolean>;
  readonly send: (paneId: string, input: Input) => Promise<unknown>;
  readonly onFocusedPane: (paneId: string | null) => void;
}

/**
 * Orders pane selection ahead of the first input addressed to that pane.
 * Canonical layout publications may lag the selection receipt, so an older
 * publication is retained as rollback state without stealing the optimistic
 * input target.
 */
export class TerminalPaneInputRouter<Input> {
  readonly #options: TerminalPaneInputRouterOptions<Input>;
  #canonicalPane: string | null = null;
  #focusedPane: string | null = null;
  #selectionToken = 0;
  #pending: {
    readonly token: number;
    readonly paneId: string;
    readonly settled: Promise<boolean>;
  } | null = null;

  constructor(options: TerminalPaneInputRouterOptions<Input>) {
    this.#options = options;
  }

  get focusedPane(): string | null {
    return this.#focusedPane;
  }

  adoptCanonicalPane(paneId: string | null): void {
    this.#canonicalPane = paneId;
    if (this.#pending !== null && paneId !== this.#pending.paneId) return;
    this.#setFocusedPane(paneId);
  }

  selectPane(paneId: string): void {
    const token = ++this.#selectionToken;
    this.#setFocusedPane(paneId);
    const settled = this.#options.select(paneId);
    this.#pending = { token, paneId, settled };
    void settled.then((selected) => {
      if (this.#pending?.token !== token) return;
      this.#pending = null;
      if (!selected) this.#setFocusedPane(this.#canonicalPane);
    });
  }

  async sendInput(input: Input): Promise<boolean> {
    const paneId = this.#focusedPane;
    if (paneId === null) return false;
    const pending = this.#pending?.paneId === paneId ? this.#pending : null;
    if (pending !== null) {
      const selected = await pending.settled;
      if (!selected || this.#selectionToken !== pending.token || this.#focusedPane !== paneId) {
        return false;
      }
    }
    await this.#options.send(paneId, input);
    return true;
  }

  #setFocusedPane(paneId: string | null): void {
    if (this.#focusedPane === paneId) return;
    this.#focusedPane = paneId;
    this.#options.onFocusedPane(paneId);
  }
}
