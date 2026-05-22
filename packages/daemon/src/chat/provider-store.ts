/**
 * Provider store — JSON-file-backed CRUD of `ProviderInstance` rows
 * persisted at `~/.tmux-ide/providers.json` (overridable via env or
 * constructor). The file is atomically rewritten on every change.
 *
 * Validation runs through `ProvidersFileZ`, so a hand-edited or
 * corrupt file is rejected loudly. Secrets live on disk in plaintext;
 * the redacted `ProviderInstanceSummary` is what crosses the wire to
 * the dashboard.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  ProviderInstanceZ,
  ProvidersFileZ,
  type ProviderInstance,
  type ProviderInstanceSummary,
  type ProvidersFile,
} from "@tmux-ide/contracts";
import {
  makeProviderRegistry,
  ProviderRegistryError,
  type ProviderRegistry,
} from "./provider-registry.ts";

/** Strip secrets so the dashboard never sees `apiKey`. */
function toSummary(instance: ProviderInstance): ProviderInstanceSummary {
  const cfg = instance.config;
  const hasApiKey =
    (cfg.kind === "anthropic" && Boolean(cfg.apiKey)) ||
    (cfg.kind === "openai" && Boolean(cfg.apiKey)) ||
    (cfg.kind === "local-lmstudio" && Boolean(cfg.apiKey));
  const summary: ProviderInstanceSummary = {
    id: instance.id,
    kind: instance.kind,
    displayName: instance.displayName,
    hasApiKey,
  };
  if ("model" in cfg && cfg.model) summary.model = cfg.model;
  if ("baseUrl" in cfg && cfg.baseUrl) summary.baseUrl = cfg.baseUrl;
  if (instance.createdAt) summary.createdAt = instance.createdAt;
  return summary;
}

export class ProviderStoreError extends Error {
  readonly code: "invalid_file" | "not_found" | "duplicate_id" | "io_error";
  constructor(message: string, code: ProviderStoreError["code"]) {
    super(message);
    this.name = "ProviderStoreError";
    this.code = code;
  }
}

export interface ProviderStore {
  list(): ProviderInstance[];
  summaries(): ProviderInstanceSummary[];
  get(id: string): ProviderInstance | null;
  add(input: Omit<ProviderInstance, "createdAt">): ProviderInstance;
  update(id: string, patch: Partial<Omit<ProviderInstance, "id">>): ProviderInstance;
  remove(id: string): boolean;
  /** Force a re-read from disk — used in tests. */
  reload(): void;
}

export interface MakeProviderStoreOptions {
  filePath?: string;
  now?: () => Date;
  randomId?: () => string;
  registry?: ProviderRegistry;
}

export function defaultProvidersFilePath(): string {
  return process.env.TMUX_IDE_PROVIDERS_FILE ?? join(homedir(), ".tmux-ide", "providers.json");
}

function readProvidersFile(filePath: string): ProvidersFile {
  if (!existsSync(filePath)) {
    return { version: 1, providers: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ProviderStoreError(
      `Cannot read providers file ${filePath}: ${(err as Error).message}`,
      "io_error",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProviderStoreError(
      `Providers file ${filePath} is not valid JSON: ${(err as Error).message}`,
      "invalid_file",
    );
  }
  const validated = ProvidersFileZ.safeParse(parsed);
  if (!validated.success) {
    throw new ProviderStoreError(
      `Providers file ${filePath} failed schema: ${validated.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
      "invalid_file",
    );
  }
  return validated.data;
}

function writeProvidersFile(filePath: string, data: ProvidersFile): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

export function makeProviderStore(opts: MakeProviderStoreOptions = {}): ProviderStore {
  const filePath = opts.filePath ?? defaultProvidersFilePath();
  const now = opts.now ?? (() => new Date());
  const randomId = opts.randomId ?? (() => randomBytes(6).toString("hex"));
  const registry = opts.registry ?? makeProviderRegistry();

  let cache = readProvidersFile(filePath);

  function commit(next: ProvidersFile): void {
    writeProvidersFile(filePath, next);
    cache = next;
  }

  return {
    list() {
      return cache.providers.map((p) => ({ ...p }));
    },
    summaries() {
      return cache.providers.map((p) => toSummary(p));
    },
    get(id) {
      const found = cache.providers.find((p) => p.id === id);
      return found ? { ...found } : null;
    },
    add(input) {
      const seed: ProviderInstance = {
        ...input,
        createdAt: (input as ProviderInstance).createdAt ?? now().toISOString(),
      };
      const validated = ProviderInstanceZ.safeParse(seed);
      if (!validated.success) {
        throw new ProviderStoreError(
          `Invalid provider instance: ${validated.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
          "invalid_file",
        );
      }
      const id = validated.data.id || randomId();
      if (cache.providers.some((p) => p.id === id)) {
        throw new ProviderStoreError(`Provider id already exists: ${id}`, "duplicate_id");
      }
      // Round-trip through the registry so the config side is also typed.
      try {
        registry.validateConfig(validated.data.config);
      } catch (err) {
        if (err instanceof ProviderRegistryError) {
          throw new ProviderStoreError(err.message, "invalid_file");
        }
        throw err;
      }
      const record: ProviderInstance = {
        ...validated.data,
        id,
        createdAt: validated.data.createdAt ?? now().toISOString(),
      };
      commit({ ...cache, providers: [...cache.providers, record] });
      return { ...record };
    },
    update(id, patch) {
      const idx = cache.providers.findIndex((p) => p.id === id);
      if (idx < 0) {
        throw new ProviderStoreError(`Provider not found: ${id}`, "not_found");
      }
      const existing = cache.providers[idx]!;
      const candidate: ProviderInstance = {
        ...existing,
        ...patch,
        id: existing.id,
      };
      const validated = ProviderInstanceZ.safeParse(candidate);
      if (!validated.success) {
        throw new ProviderStoreError(
          `Invalid provider patch: ${validated.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")}`,
          "invalid_file",
        );
      }
      try {
        registry.validateConfig(validated.data.config);
      } catch (err) {
        if (err instanceof ProviderRegistryError) {
          throw new ProviderStoreError(err.message, "invalid_file");
        }
        throw err;
      }
      const nextProviders = cache.providers.slice();
      nextProviders[idx] = validated.data;
      commit({ ...cache, providers: nextProviders });
      return { ...validated.data };
    },
    remove(id) {
      const before = cache.providers.length;
      const next = cache.providers.filter((p) => p.id !== id);
      if (next.length === before) return false;
      commit({ ...cache, providers: next });
      return true;
    },
    reload() {
      cache = readProvidersFile(filePath);
    },
  };
}
