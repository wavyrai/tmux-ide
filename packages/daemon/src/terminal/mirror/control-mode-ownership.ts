/**
 * Process-local invariant for the daemon generation: one control-mode owner
 * per tmux server/session. Cross-process exclusion remains the canonical
 * daemon lock's responsibility.
 */
export class ControlModeOwnershipRegistry {
  readonly #owners = new Map<string, symbol>();

  claim(authorityKey: string, owner: symbol): () => void {
    const existing = this.#owners.get(authorityKey);
    if (existing) {
      throw new Error(`control-mode authority already exists for ${authorityKey}`);
    }
    this.#owners.set(authorityKey, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#owners.get(authorityKey) === owner) this.#owners.delete(authorityKey);
    };
  }
}

export const processControlModeOwnershipRegistry = new ControlModeOwnershipRegistry();

export function controlModeAuthorityKey(
  session: string,
  selector: { readonly socketName?: string; readonly socketPath?: string },
): string {
  const server = selector.socketPath
    ? `path:${selector.socketPath}`
    : `name:${selector.socketName ?? "default"}`;
  return `${server}/session:${session}`;
}
