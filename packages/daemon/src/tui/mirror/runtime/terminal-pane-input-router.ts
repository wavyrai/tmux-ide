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
    readonly presentOptimistically: boolean;
    readonly settled: Promise<boolean>;
    selected: boolean | null;
  } | null = null;

  constructor(options: TerminalPaneInputRouterOptions<Input>) {
    this.#options = options;
  }

  get focusedPane(): string | null {
    return this.#focusedPane;
  }

  invalidateSelection(): void {
    this.#selectionToken += 1;
    this.#pending = null;
    this.#setFocusedPane(this.#canonicalPane);
  }

  adoptCanonicalPane(paneId: string | null): void {
    this.#canonicalPane = paneId;
    if (this.#pending !== null && paneId !== this.#pending.paneId) return;
    this.#setFocusedPane(paneId);
    if (this.#pending?.selected === true) this.#pending = null;
  }

  selectPane(paneId: string, options: { readonly presentOptimistically?: boolean } = {}): void {
    const token = ++this.#selectionToken;
    const presentOptimistically = options.presentOptimistically !== false;
    if (presentOptimistically) this.#setFocusedPane(paneId);
    const settled = this.#options.select(paneId);
    this.#pending = { token, paneId, presentOptimistically, settled, selected: null };
    void settled.then((selected) => {
      if (this.#pending?.token !== token) return;
      this.#pending.selected = selected;
      if (selected && this.#canonicalPane !== paneId) return;
      this.#pending = null;
      if (!selected) this.#setFocusedPane(this.#canonicalPane);
    });
  }

  async sendInput(input: Input): Promise<boolean> {
    const paneId = this.#pending?.paneId ?? this.#focusedPane;
    if (paneId === null) return false;
    const pending = this.#pending?.paneId === paneId ? this.#pending : null;
    if (pending !== null) {
      const selected = await pending.settled;
      if (
        !selected ||
        this.#selectionToken !== pending.token ||
        (pending.presentOptimistically && this.#focusedPane !== paneId)
      ) {
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
