export type RuntimeResourceKind =
  | "pane-stream-socket"
  | "socket-listener"
  | "runtime-supervisor"
  | "runtime-subscription"
  | "runtime-timer"
  | "host-shutdown-timer";

export interface RuntimeResourceCount {
  readonly created: number;
  readonly disposed: number;
  readonly active: number;
}

export type RuntimeResourceSnapshot = Readonly<Record<RuntimeResourceKind, RuntimeResourceCount>>;

interface MutableRuntimeResourceCount {
  created: number;
  disposed: number;
  active: number;
}

const RESOURCE_KINDS: readonly RuntimeResourceKind[] = [
  "pane-stream-socket",
  "socket-listener",
  "runtime-supervisor",
  "runtime-subscription",
  "runtime-timer",
  "host-shutdown-timer",
];
const LEDGER_SLOT = Symbol.for("tmux-ide.runtime-resource-ledger");
const ledgerGlobal = globalThis as typeof globalThis & {
  [LEDGER_SLOT]?: Map<RuntimeResourceKind, MutableRuntimeResourceCount>;
};

function ledger(): Map<RuntimeResourceKind, MutableRuntimeResourceCount> {
  if (!ledgerGlobal[LEDGER_SLOT]) {
    ledgerGlobal[LEDGER_SLOT] = new Map(
      RESOURCE_KINDS.map((kind) => [kind, { created: 0, disposed: 0, active: 0 }]),
    );
  }
  return ledgerGlobal[LEDGER_SLOT];
}

/** Lifecycle-only accounting; never called from terminal delivery or paint hot paths. */
export function acquireRuntimeResource(kind: RuntimeResourceKind, count = 1): () => void {
  const value = ledger().get(kind)!;
  value.created += count;
  value.active += count;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    value.disposed += count;
    value.active -= count;
    if (value.active < 0) throw new Error(`Runtime resource ${kind} was released below zero`);
  };
}

export function runtimeResourceSnapshot(): RuntimeResourceSnapshot {
  return Object.freeze(
    Object.fromEntries(
      RESOURCE_KINDS.map((kind) => {
        const value = ledger().get(kind)!;
        return [kind, Object.freeze({ ...value })];
      }),
    ) as Record<RuntimeResourceKind, RuntimeResourceCount>,
  );
}
