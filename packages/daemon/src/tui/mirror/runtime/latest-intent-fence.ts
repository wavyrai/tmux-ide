/** Monotonic ownership fence for async, latest-intent-wins interactions. */
export class LatestIntentFence {
  #generation = 0;

  issue(): number {
    this.#generation += 1;
    return this.#generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }

  retire(): void {
    this.#generation += 1;
  }
}
