/** A one-value handoff that can never cross an authority generation. */
export class GenerationBoundSlot<Value> {
  #generation = -1;
  #value: Value | undefined;

  advance(generation: number): void {
    if (generation === this.#generation) return;
    this.#generation = generation;
    this.#value = undefined;
  }

  retain(generation: number, value: Value): void {
    if (generation !== this.#generation) return;
    this.#value = value;
  }

  take(generation: number): Value | undefined {
    if (generation !== this.#generation) return undefined;
    const value = this.#value;
    this.#value = undefined;
    return value;
  }
}
