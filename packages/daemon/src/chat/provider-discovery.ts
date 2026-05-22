import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { makeJsonRpcEndpoint } from "../codex/protocol.ts";
import { AGENT_METHODS, CODEX_METHODS } from "../codex/methods.ts";
import { defaultInitializeRequest } from "../codex/schema.ts";

export type DiscoverableProviderKind = "claude-code" | "codex";

/**
 * Per-model capability surface mirrored from t3's
 * `mapCodexModelCapabilities`
 * (`context/t3code/apps/server/src/provider/Layers/CodexProvider.ts:96`).
 * Today only Codex populates this — Claude Code's models have no
 * equivalent picker. Empty / undefined when the upstream `model/list`
 * response omits the data (or when we fall back to the static catalog
 * for a model with no canonical reasoning-tier surface).
 */
export interface ProviderModelCapabilities {
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsFastMode?: boolean;
}

export interface ProviderModelInfo {
  slug: string;
  name: string;
  description?: string;
  capabilities?: ProviderModelCapabilities;
}

/**
 * Slug aliases mirroring t3's `MODEL_SLUG_ALIASES_BY_PROVIDER`
 * (`context/t3code/packages/contracts/src/model.ts:155-194`). Applied
 * server-side in `thread-manager.send()` before dispatch so a stale
 * client (or a CLI default that still names a renamed model) lands on
 * the current canonical slug. Forward-compat: keep the wire shape
 * unchanged — the daemon normalises silently.
 */
export const MODEL_SLUG_ALIASES_BY_KIND: Record<
  DiscoverableProviderKind,
  Record<string, string>
> = {
  codex: {
    "gpt-5-codex": "gpt-5.4",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  "claude-code": {
    opus: "claude-opus-4-7",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
};

/** Resolve `slug` to its canonical alias for `kind`. Returns the slug
 *  unchanged when no alias applies — safe to call with any input. */
export function resolveModelSlug(kind: DiscoverableProviderKind, slug: string): string {
  return MODEL_SLUG_ALIASES_BY_KIND[kind]?.[slug] ?? slug;
}

export interface ProviderInfo {
  kind: DiscoverableProviderKind;
  name: string;
  description: string;
  available: boolean;
  binary?: string;
  version?: string;
  error?: string;
  /**
   * Real, daemon-owned model list. First entry is the recommended
   * default. Empty when the provider binary is missing — callers should
   * suppress the model picker in that case.
   *
   * Kept editorial in the daemon for now: claude-code has no
   * remote-listing endpoint, and codex's `model/list` JSON-RPC sits
   * behind app-server initialization. A future round can replace these
   * with a live probe; the wire shape is stable.
   */
  models: ProviderModelInfo[];
}

/**
 * Hand-maintained model catalog (daemon-owned, NOT the client's
 * hardcoded list — see audit §3). The order matters: index 0 is the
 * surfaced default. Bump these as providers ship new models.
 */
const CLAUDE_CODE_MODELS: ProviderModelInfo[] = [
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    description: "1M context · highest capability",
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description: "Balanced speed + quality",
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    description: "Fastest · low cost",
  },
];

// Codex-with-ChatGPT-account auth only accepts codex-suffixed models;
// the bare `gpt-5` selection returns
// `{"type":"invalid_request_error","message":"The 'gpt-5' model is not
// supported when using Codex with a ChatGPT account."}`. The static
// fallback ships the newer slugs from t3 (`model.ts:135`) so the
// offline catalog isn't artificially impoverished — when the live
// `model/list` probe fails (binary missing, auth not yet completed,
// timeout) we still surface the current generation. Capabilities are a
// best-effort copy of what newer Codex models advertise.
const CODEX_STATIC_DEFAULT_REASONING = "medium";
const CODEX_STATIC_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const CODEX_MODELS: ProviderModelInfo[] = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    description: "Current default · reasoning + fast mode",
    capabilities: {
      reasoningEfforts: CODEX_STATIC_REASONING_EFFORTS,
      defaultReasoningEffort: CODEX_STATIC_DEFAULT_REASONING,
      supportsFastMode: true,
    },
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    description: "Newer code-tuned",
    capabilities: {
      reasoningEfforts: CODEX_STATIC_REASONING_EFFORTS,
      defaultReasoningEffort: CODEX_STATIC_DEFAULT_REASONING,
      supportsFastMode: true,
    },
  },
  {
    slug: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    description: "Faster code-tuned",
    capabilities: {
      reasoningEfforts: CODEX_STATIC_REASONING_EFFORTS,
      defaultReasoningEffort: CODEX_STATIC_DEFAULT_REASONING,
      supportsFastMode: true,
    },
  },
  {
    slug: "gpt-5-codex",
    name: "GPT-5 Codex",
    description: "Code-tuned (legacy)",
  },
];

export interface ProviderDiscoveryExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ProviderDiscoveryOptions {
  pathLookup?: (binary: string) => Promise<string | null>;
  exec?: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number },
  ) => Promise<ProviderDiscoveryExecResult>;
  /**
   * Probe Codex's `model/list` JSON-RPC method via the spawned
   * `codex app-server`. Returns the parsed model list, or `null` to
   * signal "use the static fallback". Injectable for tests so the
   * unit suite never spawns a real codex binary.
   */
  probeCodexModels?: (
    binaryPath: string,
    opts: { timeoutMs?: number },
  ) => Promise<ProviderModelInfo[] | null>;
  /**
   * Optional clock for the cache TTL. Tests use a fixed clock to make
   * cache eviction deterministic.
   */
  now?: () => number;
}

const VERSION_TIMEOUT_MS = 1_500;
const CODEX_PROBE_TIMEOUT_MS = 5_000;
/**
 * Codex-model-list cache TTL. Spawning `codex app-server` for a
 * model list takes ~0.5–2s; `chat.providers.list` is a hot read so
 * caching is essential. The 60s window lets us survive a burst of
 * UI re-mounts while still picking up new models within a minute.
 */
const CODEX_MODELS_CACHE_TTL_MS = 60_000;

interface CodexModelsCacheEntry {
  binaryPath: string;
  version: string | undefined;
  expiresAt: number;
  models: ProviderModelInfo[];
}
let codexModelsCache: CodexModelsCacheEntry | null = null;

/** Test-only: clear the per-binary codex models cache. */
export function _resetCodexModelsCacheForTests(): void {
  codexModelsCache = null;
}

/**
 * Conservative ChatGPT-account compatibility filter. Codex with
 * ChatGPT-account auth rejects bare `gpt-5`:
 *   "The 'gpt-5' model is not supported when using Codex with a
 *    ChatGPT account."
 * The codex-suffixed variants (`gpt-5-codex`, `gpt-5.3-codex`, …)
 * are the accepted ones, and the codex `model/list` response does
 * NOT carry an explicit "ChatGPT auth compatible" flag. When in
 * doubt, only surface `*-codex` slugs.
 */
function isCodexCompatibleSlug(slug: string): boolean {
  return /-codex(?:-|$)/.test(slug);
}

interface V2ModelListResponseModel {
  readonly model?: unknown;
  readonly displayName?: unknown;
  readonly description?: unknown;
  readonly hidden?: unknown;
  readonly isDefault?: unknown;
  /**
   * Codex newer-gen surface:
   *   - `supportedReasoningEfforts`: either `string[]` or
   *     `Array<{reasoningEffort: string}>` depending on protocol vintage;
   *     we accept both.
   *   - `defaultReasoningEffort`: plain string.
   *   - `additionalSpeedTiers`: `["fast"]` when the model accepts the
   *     fast service tier.
   */
  readonly supportedReasoningEfforts?: unknown;
  readonly defaultReasoningEffort?: unknown;
  readonly additionalSpeedTiers?: unknown;
}

interface V2ModelListResponse {
  readonly data?: ReadonlyArray<V2ModelListResponseModel>;
  readonly nextCursor?: string | null;
}

/**
 * Pull reasoning-effort + fast-mode capabilities out of one model
 * entry. Accepts both the older string-array shape (`["low",
 * "medium"]`) and the newer object-array shape (`[{reasoningEffort:
 * "low"}, ...]`) emitted by different `codex app-server` vintages —
 * the t3 reference resolves to the same string set in both cases.
 *
 * Returns `undefined` when the entry has neither a reasoning surface
 * nor a fast-mode tier, so we don't decorate models with empty
 * capability shells.
 */
function extractCodexCapabilities(
  model: V2ModelListResponseModel,
): ProviderModelCapabilities | undefined {
  const efforts: string[] = [];
  if (Array.isArray(model.supportedReasoningEfforts)) {
    for (const entry of model.supportedReasoningEfforts) {
      if (typeof entry === "string" && entry.length > 0) {
        efforts.push(entry);
      } else if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { reasoningEffort?: unknown }).reasoningEffort === "string"
      ) {
        efforts.push((entry as { reasoningEffort: string }).reasoningEffort);
      }
    }
  }
  const defaultEffort =
    typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort.length > 0
      ? model.defaultReasoningEffort
      : undefined;
  const speedTiers = Array.isArray(model.additionalSpeedTiers)
    ? model.additionalSpeedTiers.filter((t): t is string => typeof t === "string")
    : [];
  const supportsFastMode = speedTiers.includes("fast");
  if (efforts.length === 0 && !defaultEffort && !supportsFastMode) return undefined;
  const out: ProviderModelCapabilities = {};
  if (efforts.length > 0) out.reasoningEfforts = efforts;
  if (defaultEffort) out.defaultReasoningEffort = defaultEffort;
  if (supportsFastMode) out.supportsFastMode = true;
  return out;
}

/**
 * Best-effort parse of Codex's `model/list` JSON-RPC response into
 * our `ProviderModelInfo` shape. Mirrors t3's
 * `parseCodexModelListResponse` (`Layers/CodexProvider.ts:134`)
 * without dragging in `effect-codex-app-server`. Filters out hidden
 * models and (conservatively) anything that isn't `*-codex`.
 *
 * Exported so the unit test can verify parse + filter behavior
 * without spawning a real codex binary.
 */
export function parseCodexModelListResponse(response: V2ModelListResponse): ProviderModelInfo[] {
  const data = Array.isArray(response.data) ? response.data : [];
  const out: ProviderModelInfo[] = [];
  for (const model of data) {
    const slug = typeof model.model === "string" ? model.model : null;
    if (!slug) continue;
    if (model.hidden === true) continue;
    if (!isCodexCompatibleSlug(slug)) continue;
    const displayName = typeof model.displayName === "string" ? model.displayName : slug;
    const description = typeof model.description === "string" ? model.description : undefined;
    const capabilities = extractCodexCapabilities(model);
    const entry: ProviderModelInfo = {
      slug,
      name: prettifyCodexDisplayName(displayName),
      ...(description ? { description } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
    out.push(entry);
  }
  // Move the default-flagged model (if surfaced and present in our
  // filtered set) to the front so the picker seeds it as the
  // recommended choice. Otherwise preserve codex's order.
  const defaultSlug = data.find((m) => m.isDefault === true && typeof m.model === "string")
    ?.model as string | undefined;
  if (defaultSlug) {
    const idx = out.findIndex((m) => m.slug === defaultSlug);
    if (idx > 0) {
      const [item] = out.splice(idx, 1);
      if (item) out.unshift(item);
    }
  }
  return out;
}

/**
 * Light cosmetic transform of codex's `displayName`. Mirrors t3's
 * `toDisplayName` (`Layers/CodexProvider.ts:127`) but kept tiny:
 * we don't surface capabilities here, just the label.
 */
function prettifyCodexDisplayName(name: string): string {
  return name.replace(/^gpt/i, "GPT").replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
}

/**
 * Default Codex models probe — spawns `codex app-server`, drives
 * the JSON-RPC `initialize` + `model/list` (with cursor pagination),
 * then closes the child. Returns `null` on any failure so the
 * caller falls back to the static `CODEX_MODELS` list.
 */
async function defaultProbeCodexModels(
  binaryPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ProviderModelInfo[] | null> {
  const timeoutMs = opts.timeoutMs ?? CODEX_PROBE_TIMEOUT_MS;
  let timer: NodeJS.Timeout | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  try {
    child = spawn(binaryPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const spawnedChild = child;
    if (!spawnedChild.stdin || !spawnedChild.stdout) return null;
    // Drain stderr without buffering — keeps the child from blocking
    // on a full pipe if it writes diagnostics.
    spawnedChild.stderr?.on("data", () => undefined);

    const spawnFailure = await Promise.race([
      once(spawnedChild, "spawn").then(() => null),
      once(spawnedChild, "error").then(([err]) => err as Error),
      once(spawnedChild, "exit").then(
        ([code, signal]) =>
          new Error(`codex app-server exited during spawn (code=${code}, signal=${signal})`),
      ),
    ]);
    if (spawnFailure) return null;

    const endpoint = makeJsonRpcEndpoint({
      input: spawnedChild.stdout,
      output: spawnedChild.stdin,
    });

    const work = (async (): Promise<ProviderModelInfo[]> => {
      await endpoint.request(AGENT_METHODS.initialize, defaultInitializeRequest());
      const accumulated: ProviderModelInfo[] = [];
      let cursor: string | null | undefined = undefined;
      // Pagination cap — Codex returns a handful of models today; the
      // bound is just a safety against a runaway server.
      for (let page = 0; page < 16; page += 1) {
        const params = cursor ? { cursor } : {};
        const response = (await endpoint.request(
          CODEX_METHODS.model_list,
          params,
        )) as V2ModelListResponse;
        accumulated.push(...parseCodexModelListResponse(response));
        cursor = response.nextCursor ?? null;
        if (!cursor) break;
      }
      return accumulated;
    })();

    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });

    const result = await Promise.race([work, timeout]);
    if (result === null) return null;
    return result.length > 0 ? result : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // best effort
      }
    }
  }
}

async function getCodexModelsCached(
  binaryPath: string,
  version: string | undefined,
  now: number,
  probe: NonNullable<ProviderDiscoveryOptions["probeCodexModels"]>,
): Promise<ProviderModelInfo[]> {
  if (
    codexModelsCache &&
    codexModelsCache.binaryPath === binaryPath &&
    codexModelsCache.version === version &&
    codexModelsCache.expiresAt > now
  ) {
    return codexModelsCache.models;
  }
  const probed = await probe(binaryPath, { timeoutMs: CODEX_PROBE_TIMEOUT_MS }).catch(() => null);
  const models = probed ?? CODEX_MODELS;
  codexModelsCache = {
    binaryPath,
    version,
    expiresAt: now + CODEX_MODELS_CACHE_TTL_MS,
    models,
  };
  return models;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveFromPath(binary: string): Promise<string | null> {
  if (isAbsolute(binary)) return (await isExecutable(binary)) ? binary : null;
  if (binary.includes("/")) return (await isExecutable(binary)) ? binary : null;

  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

async function defaultExec(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<ProviderDiscoveryExecResult> {
  return await new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs }, (err, stdout, stderr) => {
      const exitCode =
        err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (err as NodeJS.ErrnoException & { code: number }).code
          : err
            ? null
            : 0;
      resolve({ stdout, stderr, code: exitCode });
    });
  });
}

function firstStdoutLine(result: ProviderDiscoveryExecResult): string | undefined {
  return result.code === 0
    ? result.stdout
        .split(/\r?\n/)
        .find((line) => line.trim())
        ?.trim()
    : undefined;
}

async function bestEffortVersion(
  exec: NonNullable<ProviderDiscoveryOptions["exec"]>,
  binary: string,
): Promise<string | undefined> {
  try {
    return firstStdoutLine(await exec(binary, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}

async function discoverClaudeCode(
  pathLookup: NonNullable<ProviderDiscoveryOptions["pathLookup"]>,
  exec: NonNullable<ProviderDiscoveryOptions["exec"]>,
): Promise<ProviderInfo> {
  const direct = await pathLookup("claude-code-acp");
  if (direct) {
    const version = await bestEffortVersion(exec, direct);
    return {
      kind: "claude-code",
      name: "Claude Code",
      description: "Claude Code via claude-code-acp",
      available: true,
      binary: direct,
      ...(version ? { version } : {}),
      models: CLAUDE_CODE_MODELS,
    };
  }

  const npx = await pathLookup("npx");
  if (npx) {
    return {
      kind: "claude-code",
      name: "Claude Code",
      description: "Claude Code via npx",
      available: true,
      binary: npx,
      models: CLAUDE_CODE_MODELS,
    };
  }

  return {
    kind: "claude-code",
    name: "Claude Code",
    description: "Claude Code via claude-code-acp",
    available: false,
    error: "neither claude-code-acp nor npx on PATH",
    models: [],
  };
}

async function discoverCodex(
  pathLookup: NonNullable<ProviderDiscoveryOptions["pathLookup"]>,
  exec: NonNullable<ProviderDiscoveryOptions["exec"]>,
  probe: NonNullable<ProviderDiscoveryOptions["probeCodexModels"]>,
  now: number,
): Promise<ProviderInfo> {
  const binary = await pathLookup("codex");
  if (!binary) {
    return {
      kind: "codex",
      name: "Codex",
      description: "Codex app-server proxy",
      available: false,
      error: "codex not on PATH",
      models: [],
    };
  }

  const version = await bestEffortVersion(exec, binary);
  const models = await getCodexModelsCached(binary, version, now, probe);
  return {
    kind: "codex",
    name: "Codex",
    description: "Codex app-server proxy",
    available: true,
    binary,
    ...(version ? { version } : {}),
    models,
  };
}

export async function discoverProviders(
  opts: ProviderDiscoveryOptions = {},
): Promise<ProviderInfo[]> {
  const pathLookup = opts.pathLookup ?? resolveFromPath;
  const exec = opts.exec ?? defaultExec;
  const probe = opts.probeCodexModels ?? defaultProbeCodexModels;
  const now = opts.now?.() ?? Date.now();
  return [
    await discoverClaudeCode(pathLookup, exec),
    await discoverCodex(pathLookup, exec, probe, now),
  ];
}
