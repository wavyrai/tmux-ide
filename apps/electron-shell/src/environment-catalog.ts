import { randomUUID } from "node:crypto";
import { SavedMachineSchema } from "@tmux-ide/contracts";
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
 * (reconciled) on the first successful preflight. The catalog records local and
 * SSH routes. Recording a route grants no
 * connection authority; each route must be verified independently.
 */

/** How to reach an environment. SSH credentials remain outside the catalog. */
export type KnownEnvironmentEndpoint =
  | { readonly kind: "local-canonical" }
  | { readonly kind: "ssh"; readonly alias: string };

export interface KnownEnvironment {
  /** Host-owned route identity; never a daemon identity or connection capability. */
  readonly id: string;
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
  id: "f6400051-e34b-4662-a56d-58e45e39a6cd",
  environmentId: null,
  endpoint: { kind: "local-canonical" },
  label: "Local daemon",
  lastConnectedAt: null,
};

/** The seam the connection coordinator reports through after a verified connect. */
export interface KnownEnvironmentReconciler {
  reconcileLocalCanonical(environmentId: string): void;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

function parseEnvironment(value: unknown): KnownEnvironment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const endpoint = record.endpoint as Record<string, unknown> | undefined;
  if (!endpoint) return null;
  let parsedEndpoint: KnownEnvironmentEndpoint;
  if (endpoint.kind === "local-canonical") parsedEndpoint = { kind: "local-canonical" };
  else if (
    endpoint.kind === "ssh" &&
    SavedMachineSchema.shape.sshTarget.safeParse(endpoint.alias).success
  ) {
    parsedEndpoint = { kind: "ssh", alias: endpoint.alias as string };
  } else return null;
  if (record.id !== undefined && (typeof record.id !== "string" || !UUID_PATTERN.test(record.id)))
    return null;
  const id =
    typeof record.id === "string"
      ? record.id
      : parsedEndpoint.kind === "local-canonical"
        ? LOCAL_CANONICAL_SEED.id
        : randomUUID();
  const environmentId =
    typeof record.environmentId === "string" && UUID_PATTERN.test(record.environmentId)
      ? record.environmentId
      : null;
  const label =
    typeof record.label === "string" &&
    record.label.trim().length > 0 &&
    record.label.length <= 120 &&
    !hasControlCharacters(record.label)
      ? record.label
      : LOCAL_CANONICAL_SEED.label;
  const lastConnectedAt =
    typeof record.lastConnectedAt === "string" &&
    Number.isFinite(Date.parse(record.lastConnectedAt))
      ? record.lastConnectedAt
      : null;
  return { id, environmentId, endpoint: parsedEndpoint, label, lastConnectedAt };
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
  if (new Set(environments.map((entry) => entry.id)).size !== environments.length) return null;
  const keys = environments.map((entry) =>
    entry.endpoint.kind === "local-canonical" ? "local" : `ssh:${entry.endpoint.alias}`,
  );
  if (new Set(keys).size !== keys.length) return null;
  if (!environments.some((entry) => entry.endpoint.kind === "local-canonical"))
    environments.unshift(LOCAL_CANONICAL_SEED);
  return environments;
}

/** Resolve the preflight prober for an endpoint. The only seam that maps
 *  "how to reach" onto a concrete transport; unknown kinds fail loudly. */
export function resolvePreflightForEndpoint(endpoint: KnownEnvironmentEndpoint): DaemonPreflight {
  if (endpoint.kind === "local-canonical") return canonicalDaemonPreflight;
  throw new Error(`unsupported environment endpoint kind: ${String(endpoint.kind)}`);
}

/**
 * A preflight that resolves its target through the catalog at probe time
 * for the local supervisor. Remote routes require their own transport-owning
 * coordinator; this adapter never silently redirects local authority.
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
        const raw: unknown = JSON.parse(await readFile(this.#path, "utf8"));
        const parsed = parseCatalog(raw);
        if (parsed) {
          this.#environments = parsed;
          const stored = (raw as { environments: Array<{ id?: unknown }> }).environments;
          // Persist an actual migration, not every read. A normal reload must
          // not race a later catalog owner by rewriting an unchanged snapshot.
          if (stored.length !== parsed.length || stored.some((entry) => entry.id === undefined))
            this.#persist();
        }
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
    return this.reconcile(this.localCanonical().id, environmentId);
  }

  /** Add a route without granting connection authority or storing credentials. */
  async addSsh(alias: string, label = alias): Promise<KnownEnvironment> {
    await this.load();
    const parsed = SavedMachineSchema.shape.sshTarget.safeParse(alias);
    if (!parsed.success) throw new Error("Invalid SSH alias");
    if (!label.trim() || label.length > 120 || hasControlCharacters(label))
      throw new Error("Invalid environment label");
    const existing = this.#environments.find(
      (entry) => entry.endpoint.kind === "ssh" && entry.endpoint.alias === alias,
    );
    if (existing) return existing;
    const entry: KnownEnvironment = {
      id: randomUUID(),
      environmentId: null,
      endpoint: { kind: "ssh", alias },
      label: label.trim(),
      lastConnectedAt: null,
    };
    this.#environments = [...this.#environments, entry];
    this.#persist();
    return entry;
  }

  entry(id: string): KnownEnvironment | undefined {
    return this.#environments.find((entry) => entry.id === id);
  }

  /** Observational only: callers must verify the daemon before reconciling. */
  reconcile(id: string, environmentId: string): KnownEnvironmentReconcileOutcome {
    const current = this.entry(id);
    if (!current || !UUID_PATTERN.test(environmentId)) return "unchanged";
    const outcome: KnownEnvironmentReconcileOutcome =
      current.environmentId === environmentId
        ? "unchanged"
        : current.environmentId === null
          ? "recorded"
          : "replaced";
    const next = { ...current, environmentId, lastConnectedAt: new Date().toISOString() };
    this.#environments = this.#environments.map((entry) => (entry.id === id ? next : entry));
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
