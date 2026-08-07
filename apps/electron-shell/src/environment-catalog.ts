import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalDaemonPreflight, type DaemonPreflight } from "./daemon-preflight.ts";

/**
 * The client-side catalog of known environments.
 *
 * A daemon mints one stable environmentId per state home; this catalog is the
 * app's own record of the environments it can reach and how to reach them.
 * The two are deliberately decoupled: an endpoint can be recorded before the
 * environment behind it is ever contacted, and the environmentId is learned
 * (reconciled) on the first successful preflight. Today the catalog holds
 * exactly one entry — the local canonical daemon — so behavior is identical
 * to the previous hardcoded wiring; remote endpoint kinds slot in as new
 * members of the endpoint union without touching connection authority.
 */

/** How to reach an environment. Local-canonical means daemon.json discovery. */
export interface KnownEnvironmentEndpoint {
  readonly kind: "local-canonical";
}

export interface KnownEnvironment {
  /** Stable daemon-minted identity; null until the first successful connect. */
  readonly environmentId: string | null;
  readonly endpoint: KnownEnvironmentEndpoint;
  readonly label: string;
  readonly lastConnectedAt: string | null;
}

export type KnownEnvironmentReconcileOutcome = "recorded" | "unchanged" | "replaced";

const CATALOG_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const LOCAL_CANONICAL_SEED: KnownEnvironment = {
  environmentId: null,
  endpoint: { kind: "local-canonical" },
  label: "Local daemon",
  lastConnectedAt: null,
};

/** The seam the connection coordinator reports through after a verified connect. */
export interface KnownEnvironmentReconciler {
  reconcileLocalCanonical(environmentId: string): void;
}

function parseEnvironment(value: unknown): KnownEnvironment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const endpoint = record.endpoint as Record<string, unknown> | undefined;
  if (!endpoint || endpoint.kind !== "local-canonical") return null;
  const environmentId =
    typeof record.environmentId === "string" && UUID_PATTERN.test(record.environmentId)
      ? record.environmentId
      : null;
  const label =
    typeof record.label === "string" && record.label.length > 0
      ? record.label
      : LOCAL_CANONICAL_SEED.label;
  const lastConnectedAt =
    typeof record.lastConnectedAt === "string" &&
    Number.isFinite(Date.parse(record.lastConnectedAt))
      ? record.lastConnectedAt
      : null;
  return { environmentId, endpoint: { kind: "local-canonical" }, label, lastConnectedAt };
}

function parseCatalog(value: unknown): KnownEnvironment[] | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { version?: unknown; environments?: unknown };
  if (record.version !== CATALOG_VERSION || !Array.isArray(record.environments)) return null;
  const environments: KnownEnvironment[] = [];
  for (const entry of record.environments) {
    const parsed = parseEnvironment(entry);
    if (!parsed) return null;
    environments.push(parsed);
  }
  return environments.length > 0 ? environments : null;
}

/** Resolve the preflight prober for an endpoint. The only seam that maps
 *  "how to reach" onto a concrete transport; unknown kinds fail loudly. */
export function resolvePreflightForEndpoint(endpoint: KnownEnvironmentEndpoint): DaemonPreflight {
  if (endpoint.kind === "local-canonical") return canonicalDaemonPreflight;
  throw new Error(`unsupported environment endpoint kind: ${String(endpoint.kind)}`);
}

/**
 * A preflight that resolves its target through the catalog at probe time
 * instead of hardcoding the one local daemon. With today's single
 * local-canonical entry this delegates to the existing secure preflight
 * unchanged; a future remote entry only changes what the catalog answers.
 */
export function createCatalogBackedPreflight(catalog: KnownEnvironmentCatalog): DaemonPreflight {
  return {
    probe: async (signal) => {
      await catalog.load();
      return resolvePreflightForEndpoint(catalog.localCanonical().endpoint).probe(signal);
    },
  };
}

/**
 * File-backed catalog in the desktop app's state directory. Reads degrade to
 * the local-canonical seed; writes are atomic and best-effort — a persistence
 * failure never disturbs connection authority.
 */
export class KnownEnvironmentCatalog implements KnownEnvironmentReconciler {
  readonly #path: string;
  #environments: KnownEnvironment[] = [LOCAL_CANONICAL_SEED];
  #loaded: Promise<void> | null = null;
  #lastWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  /** Idempotent; missing or malformed state reseeds the local entry. */
  load(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        const parsed = parseCatalog(JSON.parse(await readFile(this.#path, "utf8")));
        if (parsed) this.#environments = parsed;
      } catch {
        // Absent or unreadable state keeps the seed; the next successful
        // reconcile persists a fresh catalog.
      }
    })();
    return this.#loaded;
  }

  entries(): readonly KnownEnvironment[] {
    return this.#environments;
  }

  localCanonical(): KnownEnvironment {
    const entry = this.#environments.find((candidate) => {
      return candidate.endpoint.kind === "local-canonical";
    });
    return entry ?? LOCAL_CANONICAL_SEED;
  }

  /**
   * Record the daemon-minted identity behind the local-canonical endpoint.
   * The endpoint is the durable key for the local entry: a different id means
   * the daemon home was reset (its identity file re-minted), so the recorded
   * id is replaced rather than treated as a second environment.
   */
  reconcileLocalCanonical(environmentId: string): KnownEnvironmentReconcileOutcome {
    if (!UUID_PATTERN.test(environmentId)) return "unchanged";
    const current = this.localCanonical();
    const outcome: KnownEnvironmentReconcileOutcome =
      current.environmentId === environmentId
        ? "unchanged"
        : current.environmentId === null
          ? "recorded"
          : "replaced";
    const next: KnownEnvironment = {
      ...current,
      environmentId,
      lastConnectedAt: new Date().toISOString(),
    };
    this.#environments = [
      next,
      ...this.#environments.filter((candidate) => candidate.endpoint.kind !== "local-canonical"),
    ];
    this.#persist();
    return outcome;
  }

  /** Serialized, atomic, best-effort persistence of the current catalog. */
  #persist(): void {
    const snapshot = { version: CATALOG_VERSION, environments: this.#environments };
    this.#lastWrite = this.#lastWrite
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
        try {
          await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
          await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
          await rename(temporary, this.#path);
        } catch {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      });
  }

  /** Awaitable persistence barrier for shutdown and tests. */
  flush(): Promise<void> {
    return this.#lastWrite;
  }
}
