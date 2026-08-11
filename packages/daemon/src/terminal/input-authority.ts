import { z } from "zod";

const RuntimeWindowIdSchemaZ = z
  .string()
  .max(32)
  .regex(/^@(?:0|[1-9][0-9]*)$/u);
const OwnerIdSchemaZ = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"));
const InputTransportSchemaZ = z.enum(["terminal-attachment", "pane-stream"]);

export type TerminalInputTransport = z.infer<typeof InputTransportSchemaZ>;

export interface TerminalInputOwner {
  readonly transport: TerminalInputTransport;
  readonly leaseId: string;
}

export interface TerminalInputAuthoritySnapshot {
  readonly owners: readonly {
    readonly transport: TerminalInputTransport;
    readonly leaseId: string;
    readonly runtimeWindowIds: readonly string[];
  }[];
}

export class TerminalInputAuthorityConflictError extends Error {
  constructor() {
    super("The resolved runtime window already has an interactive input owner.");
    this.name = "TerminalInputAuthorityConflictError";
  }
}

function validatedOwner(owner: TerminalInputOwner): TerminalInputOwner {
  return {
    transport: InputTransportSchemaZ.parse(owner.transport),
    leaseId: OwnerIdSchemaZ.parse(owner.leaseId),
  };
}

function ownerKey(owner: TerminalInputOwner): string {
  const parsed = validatedOwner(owner);
  return `${parsed.transport}\0${parsed.leaseId}`;
}

function validatedWindows(runtimeWindowIds: readonly string[]): readonly string[] {
  const windows = [...new Set(runtimeWindowIds.map((id) => RuntimeWindowIdSchemaZ.parse(id)))];
  if (windows.length === 0) throw new TypeError("At least one runtime window is required.");
  return windows;
}

/**
 * Transport-level safety guard for terminal input. Both the grouped PTY
 * attachment and pane-stream transports claim through this one object, so two
 * semantic panes in the same live tmux window can never acquire independent
 * interactive grants. Passive/read-only viewers never enter this authority.
 *
 * SessionRuntime is the product-level controller authority. This window guard
 * is subordinate to it: it protects the existing attachment protocols while
 * those protocols still lack a stable authenticated client identity, and must
 * never authorize a semantic/geometry mutation on its own. The m56.1d identity
 * cutover deletes this parallel owner map once both transports bind their
 * connection to a SessionRuntime controller lease.
 *
 * The object is intentionally in-memory. Constructing the next daemon
 * generation creates a fresh authority, invalidating every prior grant along
 * with the transport leases that owned it.
 */
export class TerminalInputAuthority {
  readonly #windowOwners = new Map<string, string>();
  readonly #ownerWindows = new Map<string, Set<string>>();
  readonly #owners = new Map<string, TerminalInputOwner>();

  /**
   * Adds the requested windows to an owner's reservation atomically. Existing
   * reservations remain held, which lets a rebinding lease reserve its new
   * window before it releases/cleans up the old view.
   */
  claim(owner: TerminalInputOwner, runtimeWindowIds: readonly string[]): void {
    const parsedOwner = validatedOwner(owner);
    const key = ownerKey(parsedOwner);
    const windows = validatedWindows(runtimeWindowIds);
    for (const windowId of windows) {
      const current = this.#windowOwners.get(windowId);
      if (current !== undefined && current !== key) {
        throw new TerminalInputAuthorityConflictError();
      }
    }
    const owned = this.#ownerWindows.get(key) ?? new Set<string>();
    for (const windowId of windows) {
      this.#windowOwners.set(windowId, key);
      owned.add(windowId);
    }
    this.#ownerWindows.set(key, owned);
    this.#owners.set(key, parsedOwner);
  }

  /** Replaces an owner's complete reservation atomically. */
  replace(owner: TerminalInputOwner, runtimeWindowIds: readonly string[]): void {
    const parsedOwner = validatedOwner(owner);
    const key = ownerKey(parsedOwner);
    const windows = validatedWindows(runtimeWindowIds);
    for (const windowId of windows) {
      const current = this.#windowOwners.get(windowId);
      if (current !== undefined && current !== key) {
        throw new TerminalInputAuthorityConflictError();
      }
    }
    const next = new Set(windows);
    for (const windowId of this.#ownerWindows.get(key) ?? []) {
      if (!next.has(windowId) && this.#windowOwners.get(windowId) === key) {
        this.#windowOwners.delete(windowId);
      }
    }
    for (const windowId of next) this.#windowOwners.set(windowId, key);
    this.#ownerWindows.set(key, next);
    this.#owners.set(key, parsedOwner);
  }

  release(owner: TerminalInputOwner): void {
    const key = ownerKey(owner);
    for (const windowId of this.#ownerWindows.get(key) ?? []) {
      if (this.#windowOwners.get(windowId) === key) this.#windowOwners.delete(windowId);
    }
    this.#ownerWindows.delete(key);
    this.#owners.delete(key);
  }

  snapshot(): TerminalInputAuthoritySnapshot {
    return {
      owners: [...this.#ownerWindows.entries()].map(([key, windows]) => {
        const owner = this.#owners.get(key)!;
        return {
          ...owner,
          runtimeWindowIds: [...windows].sort(),
        };
      }),
    };
  }
}
