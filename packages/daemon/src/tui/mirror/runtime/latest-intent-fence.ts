export interface LatestIntentToken<Scope> {
  readonly generation: number;
  readonly scope: Scope;
}

/** Monotonic ownership fence for async, latest-intent-wins interactions. */
export class LatestIntentFence<Scope = undefined> {
  #generation = 0;

  issue(scope: Scope): LatestIntentToken<Scope> {
    this.#generation += 1;
    return { generation: this.#generation, scope };
  }

  isCurrent(intent: LatestIntentToken<Scope>, scope: Scope): boolean {
    return intent.generation === this.#generation && Object.is(intent.scope, scope);
  }

  retire(): void {
    this.#generation += 1;
  }
}
