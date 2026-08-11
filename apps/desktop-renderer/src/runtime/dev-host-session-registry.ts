export interface DevelopmentHostSession {
  readonly hostClientId: string;
  readonly expiresAt: number;
}

/** Bounded, process-local capabilities for individual browser documents. */
export class DevelopmentHostSessionRegistry {
  readonly #sessions = new Map<string, DevelopmentHostSession>();

  constructor(
    private readonly options: {
      readonly now: () => number;
      readonly createToken: () => string;
      readonly createHostClientId: () => string;
      readonly ttlMs: number;
      readonly limit: number;
    },
  ) {}

  mint(): { readonly token: string; readonly session: DevelopmentHostSession } {
    this.#removeExpired();
    while (this.#sessions.size >= this.options.limit) {
      this.#sessions.delete(this.#sessions.keys().next().value!);
    }
    const token = this.options.createToken();
    const session = {
      hostClientId: this.options.createHostClientId(),
      expiresAt: this.options.now() + this.options.ttlMs,
    };
    this.#sessions.set(token, session);
    return { token, session };
  }

  resolve(token: string | undefined): DevelopmentHostSession | undefined {
    if (!token) return undefined;
    const session = this.#sessions.get(token);
    if (!session || session.expiresAt <= this.options.now()) {
      this.#sessions.delete(token);
      return undefined;
    }
    return session;
  }

  #removeExpired(): void {
    const now = this.options.now();
    for (const [token, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(token);
    }
  }
}
