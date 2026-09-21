/**
 * PURE — credential redaction, byte budgets and reserved-metadata protection
 * for the shared structured logger (`log.ts`).
 *
 * Every record the daemon emits passes through `sanitizeLogPayload` before it
 * reaches the ring buffer, subscribers or the wire. The rules are deliberately
 * conservative: a value that looks like a credential is replaced, oversized
 * payloads are truncated with an explicit marker, and caller data can never
 * overwrite the identity fields (`ts`, `level`, `component`, `msg`, `pid`,
 * `instanceId`, `version`) that incident triage relies on.
 */

export const REDACTED = "[redacted]";

/** Wire keys owned by the logger; caller payloads with these keys are renamed. */
export const RESERVED_LOG_KEYS = Object.freeze([
  "ts",
  "level",
  "component",
  "msg",
  "pid",
  "instanceId",
  "version",
] as const);
const RESERVED = new Set<string>(RESERVED_LOG_KEYS);

/** Prefix applied to caller keys that collide with reserved metadata. */
export const RESERVED_COLLISION_PREFIX = "payload_";

export interface LogBudget {
  /** Serialized-bytes ceiling for one record's `data` payload. */
  readonly maxDataBytes: number;
  /** Longest string value retained inside a payload (bytes). */
  readonly maxStringBytes: number;
  /** Longest `msg` retained (bytes). */
  readonly maxMessageBytes: number;
  /** Deepest nesting retained; deeper values become a marker. */
  readonly maxDepth: number;
  /** Most array elements / object keys retained per container. */
  readonly maxContainerSize: number;
}

export const DEFAULT_LOG_BUDGET: LogBudget = Object.freeze({
  maxDataBytes: 8 * 1024,
  maxStringBytes: 2 * 1024,
  maxMessageBytes: 4 * 1024,
  maxDepth: 6,
  maxContainerSize: 64,
});

/** Total serialized bytes the in-memory ring may retain across all entries. */
export const DEFAULT_LOG_RING_BYTES = 512 * 1024;

/**
 * Keys whose values are credentials regardless of shape. Matched on the key
 * with separators removed and case folded so `auth_token`, `AuthToken`,
 * `X-API-Key` and `authorization` all hit.
 */
const SECRET_KEY =
  /(token|secret|password|passwd|authorization|cookie|apikey|credential|capability|privatekey|bearer|ticket|lease)/u;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ""));
}

const BEARER = /\bBearer\s+[^\s"',;]+/giu;
const BASIC = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gu;
const URL_QUERY_SECRET =
  /([?&](?:[A-Za-z0-9_-]*(?:token|ticket|lease|capability|password|secret|auth|key|signature)[A-Za-z0-9_-]*)=)[^&#\s"']*/giu;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@"']+)@/giu;
// Values already handled by the header/URL passes (Bearer/Basic schemes, an
// earlier redaction marker) are skipped so a second pass cannot eat the
// surrounding text.
const KEY_VALUE_SECRET =
  /\b((?:auth[-_]?token|access[-_]?token|refresh[-_]?token|authorization|capability|password|passwd|secret|token|ticket|lease|api[-_]?key)\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\[redacted\])[^\s,;"'}]+/giu;

/** Redact credential-shaped substrings inside free text (URLs, headers, k=v). */
export function redactText(text: string, secrets: ReadonlySet<string> = EMPTY): string {
  let out = text;
  for (const secret of secrets)
    if (secret && out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(BASIC, `Basic ${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_QUERY_SECRET, `$1${REDACTED}`)
    .replace(KEY_VALUE_SECRET, `$1${REDACTED}`);
}

const EMPTY: ReadonlySet<string> = new Set();

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function truncateString(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  // Trim on code points so a multi-byte character is never split.
  let kept = "";
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    kept += char;
    used += size;
  }
  return `${kept}…[truncated ${byteLength(text) - used} bytes]`;
}

function describeError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message };
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined) out.code = code;
  if (error.stack) out.stack = error.stack;
  return out;
}

interface RedactOptions {
  readonly budget: LogBudget;
  readonly secrets: ReadonlySet<string>;
}

function redactValue(
  value: unknown,
  depth: number,
  options: RedactOptions,
  seen: WeakSet<object>,
): unknown {
  const { budget, secrets } = options;
  if (value === null || value === undefined) return value;
  if (typeof value === "string")
    return truncateString(redactText(value, secrets), budget.maxStringBytes);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol" || typeof value === "function") return `[${typeof value}]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactValue(describeError(value), depth, options, seen);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value))
    return `[binary ${value.byteLength} bytes]`;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= budget.maxDepth) return "[depth exceeded]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value
        .slice(0, budget.maxContainerSize)
        .map((item) => redactValue(item, depth + 1, options, seen));
      if (value.length > budget.maxContainerSize)
        items.push(`[+${value.length - budget.maxContainerSize} items]`);
      return items;
    }
    if (value instanceof Map) return redactValue(Object.fromEntries(value), depth, options, seen);
    if (value instanceof Set) return redactValue([...value], depth, options, seen);
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, budget.maxContainerSize)) {
      const child = (value as Record<string, unknown>)[key];
      out[key] =
        isSecretKey(key) && child != null ? REDACTED : redactValue(child, depth + 1, options, seen);
    }
    if (keys.length > budget.maxContainerSize)
      out["[+keys]"] = keys.length - budget.maxContainerSize;
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Redact one arbitrary value (strings, nested objects, errors) under the default budget. */
export function redactLogValue(
  value: unknown,
  secrets: ReadonlySet<string> = EMPTY,
  budget: LogBudget = DEFAULT_LOG_BUDGET,
): unknown {
  return redactValue(value, 0, { budget, secrets }, new WeakSet());
}

export interface SanitizedLogPayload {
  /** Redacted, budgeted payload; never contains reserved keys. */
  readonly data: Record<string, unknown> | undefined;
  /** Serialized bytes of `data` (0 when absent). */
  readonly bytes: number;
  /** True when the payload had to be summarized to fit `maxDataBytes`. */
  readonly truncated: boolean;
  /** Caller keys that collided with reserved metadata and were renamed. */
  readonly renamedKeys: readonly string[];
}

/**
 * Redact, protect reserved keys and bound a caller payload. Deterministic:
 * the same input always yields the same output, so tests can assert exact
 * shapes.
 */
export function sanitizeLogPayload(
  data: Record<string, unknown> | undefined,
  options: { secrets?: ReadonlySet<string>; budget?: LogBudget } = {},
): SanitizedLogPayload {
  if (!data) return { data: undefined, bytes: 0, truncated: false, renamedKeys: [] };
  const budget = options.budget ?? DEFAULT_LOG_BUDGET;
  const secrets = options.secrets ?? EMPTY;
  const redacted = redactValue(data, 0, { budget, secrets }, new WeakSet()) as Record<
    string,
    unknown
  >;
  const renamedKeys: string[] = [];
  const protectedData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (RESERVED.has(key)) {
      renamedKeys.push(key);
      protectedData[`${RESERVED_COLLISION_PREFIX}${key}`] = value;
    } else {
      protectedData[key] = value;
    }
  }
  let serialized = safeStringify(protectedData);
  let bytes = byteLength(serialized);
  if (bytes <= budget.maxDataBytes) {
    return { data: protectedData, bytes, truncated: false, renamedKeys };
  }
  // Over budget even after per-string limits: keep the key list so the record
  // stays diagnosable, and say how much was dropped.
  const summary: Record<string, unknown> = {
    truncated: true,
    droppedBytes: bytes,
    keys: Object.keys(protectedData).slice(0, budget.maxContainerSize),
  };
  serialized = safeStringify(summary);
  bytes = byteLength(serialized);
  return { data: summary, bytes, truncated: true, renamedKeys };
}

/** Bound a log message: redact and truncate to the message budget. */
export function sanitizeLogMessage(
  message: string,
  secrets: ReadonlySet<string> = EMPTY,
  budget: LogBudget = DEFAULT_LOG_BUDGET,
): string {
  return truncateString(redactText(String(message), secrets), budget.maxMessageBytes);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}
