import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, createHmac } from "node:crypto";

import { theilSenSlope } from "./lib/performance-reference-report.mjs";

export const PRODUCT_RIG_STATE_VERSION = 1;
/**
 * Source provenance is evidence, not an unbounded in-memory archive. The rig
 * accepts deliberately large native/binary worktrees, but refuses a patch so
 * large that one diagnostic launch could exhaust the owner process.
 */
export const PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES = 8 * 1024 * 1024;
export const PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES = 16 * 1024 * 1024;
export const PRODUCT_RIG_SOURCE_MANIFEST_HASH_CHUNK_BYTES = 64 * 1024;
export const PRODUCT_RIG_SOURCE_INVENTORY_MAX_BYTES = 1024 * 1024;
export const PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS = 10_000;
export const PRODUCT_RIG_SOURCE_PATH_MAX_BYTES = 4_096;
export const PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS = Object.freeze({
  eventCount: 50,
  fieldCount: 2_000,
  fieldNameChars: 128,
  textChars: 4_000,
  processOutputChars: 16_384,
});

const PRODUCT_JSONL_TAIL_MAX_RECORD_BYTES = 64 * 1024;

/**
 * Owner-scoped, cumulative JSONL tail. Each source byte and record is decoded
 * once; a poll admits bounded new work while preserving the exact ordered
 * prefix expected by existing evidence qualifiers.
 */
export function createProductJsonlTailReader(
  path,
  { maxBytesPerPoll = 64 * 1024, maxRecordsPerPoll = 512, recordKind = "trace" } = {},
) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !Number.isSafeInteger(maxBytesPerPoll) ||
    maxBytesPerPoll < 1 ||
    maxBytesPerPoll > 1024 * 1024 ||
    !Number.isSafeInteger(maxRecordsPerPoll) ||
    maxRecordsPerPoll < 1 ||
    maxRecordsPerPoll > 2_048 ||
    !new Set(["trace", "lifecycle"]).has(recordKind)
  )
    throw new TypeError("invalid JSONL tail reader options");
  let descriptor = null;
  let device = null;
  let inode = null;
  let offset = 0;
  let carry = Buffer.alloc(0);
  let closed = false;
  let observedSize = 0;
  let retainedRecordBytes = 0;
  let invalidReason = null;
  const records = [];
  const recordsView = new Proxy(records, {
    set: () => fail("records-mutation"),
    deleteProperty: () => fail("records-mutation"),
    defineProperty: () => fail("records-mutation"),
  });
  const marks = new WeakSet();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const deepFreezeRecord = (value) => {
    const pending = [value];
    const seen = new WeakSet();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === null || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);
      for (const child of Object.values(current)) pending.push(child);
      Object.freeze(current);
    }
    return value;
  };
  const fail = (reason) => {
    invalidReason ??= reason;
    const error = new Error(`JSONL tail integrity failure: ${invalidReason}`);
    error.code = "PRODUCT_JSONL_TAIL_INVALID";
    error.reason = invalidReason;
    throw error;
  };
  const open = () => {
    if (descriptor !== null) return true;
    if (!existsSync(path)) return false;
    descriptor = openSync(path, "r");
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) fail("not-file");
    device = metadata.dev;
    inode = metadata.ino;
    return true;
  };
  const parseCompleteLines = (staged, recordBudget) => {
    let parsed = 0;
    while (parsed < recordBudget) {
      const newline = staged.carry.indexOf(0x0a);
      if (newline < 0) break;
      const raw = staged.carry.subarray(0, newline);
      staged.carry = staged.carry.subarray(newline + 1);
      const line = raw.length > 0 && raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      if (line.length === 0) fail("empty-line");
      if (line.length > PRODUCT_JSONL_TAIL_MAX_RECORD_BYTES) fail("record-too-large");
      if (
        records.length + staged.records.length >= 8_192 ||
        retainedRecordBytes + staged.retainedRecordBytes + line.length > 16 * 1024 * 1024
      )
        fail("history-cap");
      let value;
      try {
        value = JSON.parse(decoder.decode(line));
      } catch {
        fail("malformed-record");
      }
      const object = value !== null && typeof value === "object" && !Array.isArray(value);
      const shapeExact =
        object &&
        (recordKind === "trace"
          ? value.version === 1 &&
            typeof value.type === "string" &&
            value.type.length > 0 &&
            value.type.length <= 128
          : typeof value.phase === "string" && value.phase.length > 0 && value.phase.length <= 128);
      if (!shapeExact) fail("record-shape");
      staged.records.push(deepFreezeRecord(value));
      staged.retainedRecordBytes += line.length;
      parsed += 1;
    }
    return parsed;
  };
  return Object.freeze({
    read() {
      if (invalidReason !== null) fail(invalidReason);
      if (closed) fail("closed");
      if (!open()) return recordsView;
      let pathMetadata;
      try {
        pathMetadata = statSync(path);
      } catch {
        fail("missing");
      }
      if (!pathMetadata.isFile()) fail("not-file");
      const descriptorMetadata = fstatSync(descriptor);
      if (
        pathMetadata.dev !== device ||
        pathMetadata.ino !== inode ||
        descriptorMetadata.dev !== device ||
        descriptorMetadata.ino !== inode
      )
        fail("replaced");
      if (pathMetadata.size < offset) fail("truncated");
      const staged = {
        offset,
        carry,
        records: [],
        retainedRecordBytes: 0,
      };
      let byteBudget = maxBytesPerPoll;
      let recordBudget = maxRecordsPerPoll;
      recordBudget -= parseCompleteLines(staged, recordBudget);
      while (byteBudget > 0 && recordBudget > 0 && staged.offset < pathMetadata.size) {
        const length = Math.min(64 * 1024, byteBudget, pathMetadata.size - staged.offset);
        const chunk = Buffer.allocUnsafe(length);
        const bytesRead = readSync(descriptor, chunk, 0, length, staged.offset);
        if (bytesRead <= 0) fail("short-read");
        staged.offset += bytesRead;
        byteBudget -= bytesRead;
        staged.carry =
          staged.carry.length === 0
            ? chunk.subarray(0, bytesRead)
            : Buffer.concat([staged.carry, chunk.subarray(0, bytesRead)]);
        recordBudget -= parseCompleteLines(staged, recordBudget);
        if (staged.carry.length > PRODUCT_JSONL_TAIL_MAX_RECORD_BYTES) fail("record-too-large");
      }
      offset = staged.offset;
      carry = staged.carry;
      records.push(...staged.records);
      retainedRecordBytes += staged.retainedRecordBytes;
      observedSize = pathMetadata.size;
      return recordsView;
    },
    snapshot() {
      if (invalidReason !== null) fail(invalidReason);
      return Object.freeze({
        offset,
        recordCount: records.length,
        retainedRecordBytes,
        partialBytes: carry.length,
        caughtUp: offset === observedSize && carry.length === 0,
      });
    },
    confirmCaughtUp() {
      if (invalidReason !== null) fail(invalidReason);
      if (closed) fail("closed");
      if (!open()) fail("missing");
      let pathMetadata;
      try {
        pathMetadata = statSync(path);
      } catch {
        fail("missing");
      }
      const descriptorMetadata = fstatSync(descriptor);
      if (
        !pathMetadata.isFile() ||
        pathMetadata.dev !== device ||
        pathMetadata.ino !== inode ||
        descriptorMetadata.dev !== device ||
        descriptorMetadata.ino !== inode
      )
        fail("replaced");
      if (pathMetadata.size < offset || descriptorMetadata.size < offset) fail("truncated");
      observedSize = Math.max(pathMetadata.size, descriptorMetadata.size);
      return (
        carry.length === 0 && pathMetadata.size === offset && descriptorMetadata.size === offset
      );
    },
    mark() {
      if (invalidReason !== null) fail(invalidReason);
      if (closed) fail("closed");
      if (offset !== observedSize || carry.length !== 0) fail("mark-not-caught-up");
      const mark = Object.freeze({ recordCount: records.length });
      marks.add(mark);
      return mark;
    },
    recordsSince(mark) {
      if (invalidReason !== null) fail(invalidReason);
      if (closed) fail("closed");
      if (!marks.has(mark)) fail("foreign-mark");
      return Object.freeze(records.slice(mark.recordCount));
    },
    recordsThrough(mark) {
      if (invalidReason !== null) fail(invalidReason);
      if (closed) fail("closed");
      if (!marks.has(mark)) fail("foreign-mark");
      return Object.freeze(records.slice(0, mark.recordCount));
    },
    close() {
      if (closed) return;
      closed = true;
      if (descriptor !== null) closeSync(descriptor);
      descriptor = null;
      carry = Buffer.alloc(0);
    },
  });
}

/** Bounded, fail-closed Card5 projection of daemon pane-stream lifecycle spans. */
export async function projectProductPaneStreamLifecycle(
  path,
  evidenceKey,
  {
    maxEvents = 64,
    readerFactory = createProductJsonlTailReader,
    yieldTurn = () => new Promise((resolve) => setImmediate(resolve)),
    signal = null,
  } = {},
) {
  const unavailable = (reason) =>
    Object.freeze({
      available: false,
      reason,
      count: 0,
      overflow: 0,
      events: Object.freeze([]),
    });
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(evidenceKey ?? "") ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    maxEvents > 64 ||
    typeof readerFactory !== "function" ||
    typeof yieldTurn !== "function" ||
    (signal !== null && typeof signal?.aborted !== "boolean")
  )
    return unavailable("identity-unavailable");
  const reader = readerFactory(path, {
    maxBytesPerPoll: 64 * 1024,
    maxRecordsPerPoll: 512,
    recordKind: "trace",
  });
  let records;
  let sealedStableEof = false;
  try {
    let priorOffset = -1;
    let stableEofSamples = 0;
    let stableEofCandidate = null;
    for (let turn = 0; turn < 256; turn += 1) {
      if (signal?.aborted) return unavailable("read-aborted");
      records = reader.read();
      const snapshot = reader.snapshot();
      if (signal?.aborted) return unavailable("read-aborted");
      if (snapshot.caughtUp && reader.confirmCaughtUp()) {
        const candidate = `${snapshot.offset}:${snapshot.recordCount}:${snapshot.retainedRecordBytes}`;
        if (candidate === stableEofCandidate) stableEofSamples += 1;
        else {
          stableEofCandidate = candidate;
          stableEofSamples = 1;
        }
        if (stableEofSamples >= 2) {
          sealedStableEof = true;
          break;
        }
        await yieldTurn();
        if (signal?.aborted) return unavailable("read-aborted");
        continue;
      }
      stableEofSamples = 0;
      stableEofCandidate = null;
      if (snapshot.offset === priorOffset)
        return unavailable(snapshot.partialBytes > 0 ? "partial-record" : "reader-stalled");
      priorOffset = snapshot.offset;
    }
    if (!sealedStableEof) return unavailable("reader-budget-exhausted");
  } catch (error) {
    const reason =
      error?.code === "PRODUCT_JSONL_TAIL_INVALID" &&
      typeof error.reason === "string" &&
      /^[a-z][a-z0-9-]{0,63}$/u.test(error.reason)
        ? error.reason
        : "read-failed";
    return unavailable(reason);
  } finally {
    reader.close();
  }
  const stageByOperation = new Map([
    ["pane-stream-server-ready", "server-ready"],
    ["pane-stream-layout-staged", "layout-staged"],
    ["pane-stream-layout-validated", "layout-validated"],
    ["pane-stream-delivery-open", "delivery-open"],
    ["pane-stream-first-seed", "first-seed"],
    ["pane-stream-terminal", "terminal"],
  ]);
  const all = records.filter(
    (record) =>
      stageByOperation.has(record?.operation) &&
      typeof record?.traceId === "string" &&
      typeof record?.authority?.generation === "string",
  );
  if (all.length === 0) return unavailable("no-matching-events");
  const retained = all.slice(-maxEvents).map((record, index) => {
    const terminal = record.operation === "pane-stream-terminal";
    const closeCode = record?.terminalDelivery?.paneStreamCloseCode;
    const closeReason = record?.terminalDelivery?.paneStreamCloseReason;
    const hmac = (domain, value) =>
      createHmac("sha256", Buffer.from(evidenceKey, "hex"))
        .update(`${domain}\0${value}`)
        .digest("hex");
    return Object.freeze({
      ordinal: all.length - retainedLength(all, maxEvents) + index,
      stage: stageByOperation.get(record.operation),
      requestHmac: hmac("request", record.traceId),
      generationHmac: hmac("generation", record.authority.generation),
      closeCode:
        terminal && Number.isSafeInteger(closeCode) && closeCode >= 1000 && closeCode <= 4999
          ? closeCode
          : null,
      closeReason:
        terminal && typeof closeReason === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(closeReason)
          ? closeReason
          : terminal
            ? "unknown"
            : "none",
    });
  });
  return Object.freeze({
    available: true,
    reason: "available",
    count: Math.min(all.length, 0xffff_ffff),
    overflow: Math.max(0, all.length - retained.length),
    events: Object.freeze(retained),
  });
}

function retainedLength(records, maxEvents) {
  return Math.min(records.length, maxEvents);
}

const SECRET_KEY = /(?:authorization|bearer|capability|cookie|password|secret|token)/iu;
const SECRET_QUERY =
  /([?&](?:__tmux_ide_dev_host_session|[^=&]*(?:authorization|capability|credential|password|secret|token)[^=&]*)=)[^&#]*/giu;
const BEARER_VALUE = /\bBearer\s+[^\s,;]+/giu;

export function appendBoundedWebDiagnostic(entries, entry, { secrets = [] } = {}) {
  entries.push(sanitizeWebDiagnosticValue(entry, secrets));
  if (entries.length > PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.eventCount) entries.shift();
  return entries;
}

export function shouldCaptureWebConsoleMessage(type, message) {
  return (
    ["warning", "error"].includes(type) ||
    String(message).includes("[tmux-ide] development web host active")
  );
}

/** Remove browser authority from evidence before it is serialized. */
export function redactWebDiagnosticText(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0)
      text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(BEARER_VALUE, "Bearer [REDACTED]")
    .replace(SECRET_QUERY, "$1[REDACTED]")
    .replace(
      /((?:authorization|capability|password|secret|token)\s*[:=]\s*)[^\s,;"'}]+/giu,
      "$1[REDACTED]",
    );
}

function boundedWebDiagnosticValue(
  value,
  secrets,
  depth = 0,
  budget = { remaining: PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.fieldCount },
) {
  const { eventCount, fieldNameChars, textChars } = PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS;
  if (budget.remaining <= 0) return "[FIELD-LIMIT]";
  budget.remaining -= 1;
  if (depth > 24) return "[DEPTH-LIMIT]";
  if (typeof value === "string") return redactWebDiagnosticText(value, secrets).slice(0, textChars);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .slice(-eventCount)
      .map((entry) => boundedWebDiagnosticValue(entry, secrets, depth + 1, budget));
  }
  if (typeof value !== "object") return String(value).slice(0, textChars);
  const result = {};
  let fields = 0;
  for (const rawKey in value) {
    if (!Object.hasOwn(value, rawKey)) continue;
    if (fields >= eventCount) break;
    fields += 1;
    const key = rawKey.slice(0, fieldNameChars);
    if (SECRET_KEY.test(rawKey)) {
      result[key] = "[REDACTED]";
      continue;
    }
    try {
      result[key] = boundedWebDiagnosticValue(value[rawKey], secrets, depth + 1, budget);
    } catch (error) {
      result[key] = redactWebDiagnosticText(
        error instanceof Error ? error.message : String(error),
        secrets,
      ).slice(0, textChars);
    }
  }
  return result;
}

export function sanitizeWebDiagnosticValue(value, secrets = []) {
  return boundedWebDiagnosticValue(value, secrets);
}

export async function awaitWebDiagnosticWithDeadline(promise, { timeoutMs = 3_000, onFailure }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new TypeError("Web diagnostic deadline must be a non-negative finite number");
  const observed = Promise.resolve(promise).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  let timeout;
  const expired = new Promise((resolve) => {
    timeout = setTimeout(
      () => resolve({ error: new Error(`Web diagnostic evaluation exceeded ${timeoutMs}ms`) }),
      timeoutMs,
    );
  });
  const outcome = await Promise.race([observed, expired]);
  clearTimeout(timeout);
  return Object.hasOwn(outcome, "value") ? outcome.value : onFailure(outcome.error);
}

function sanitizedStructuredDom(node) {
  if (!node || typeof node !== "object" || node.tag === "meta") return null;
  const attributes = Object.fromEntries(
    Object.entries(node.attributes ?? {}).filter(([name]) => !SECRET_KEY.test(name)),
  );
  return {
    tag: node.tag ?? null,
    attributes,
    text: node.text ?? "",
    children: (node.children ?? []).map(sanitizedStructuredDom).filter(Boolean),
  };
}

/** Stable, bounded JSON shape for a Web startup failure artifact. */
export function buildWebStartupEvidence(input, { secrets = [] } = {}) {
  const safe = sanitizeWebDiagnosticValue(input, secrets);
  return Object.freeze({
    version: 1,
    kind: "web-startup-failure",
    capturedAt: safe.capturedAt ?? null,
    navigation: safe.navigation ?? { requestedUrl: null, url: null, status: null },
    page: safe.page ?? null,
    // The browser serializer starts at #root, and this second boundary makes
    // it impossible for a future caller to persist a capability-bearing meta.
    dom: sanitizedStructuredDom(safe.dom),
    pageErrors: safe.pageErrors ?? [],
    console: safe.console ?? [],
    requestFailures: safe.requestFailures ?? [],
    httpErrors: safe.httpErrors ?? [],
    webSockets: safe.webSockets ?? [],
    screenshotPath: safe.screenshotPath ?? null,
    screenshotError: safe.screenshotError ?? null,
    viteOutput: redactWebDiagnosticText(input.viteOutput ?? "", secrets).slice(
      -PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.processOutputChars,
    ),
    daemonOutput: redactWebDiagnosticText(input.daemonOutput ?? "", secrets).slice(
      -PRODUCT_RIG_WEB_DIAGNOSTIC_LIMITS.processOutputChars,
    ),
  });
}

export function boundedSourceTraceDiff(diff, maxBytes = PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES) {
  const bytes = Buffer.byteLength(diff);
  if (bytes > maxBytes) {
    throw new Error(`Product rig source diff is ${bytes} bytes; hard ceiling is ${maxBytes} bytes`);
  }
  return diff;
}

export function deriveProductSourceManifestReadBudget(
  selectedHeadBytes,
  deltaAllowance = PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
  absoluteMaxBytes = PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES,
) {
  if (
    !Number.isSafeInteger(selectedHeadBytes) ||
    selectedHeadBytes < 0 ||
    !Number.isSafeInteger(deltaAllowance) ||
    deltaAllowance < 0 ||
    !Number.isSafeInteger(absoluteMaxBytes) ||
    absoluteMaxBytes < 1
  )
    throw new Error("Product rig source manifest budget was invalid");
  const derived = selectedHeadBytes + deltaAllowance;
  if (!Number.isSafeInteger(derived))
    throw new Error("Product rig source manifest budget overflowed");
  return Math.min(derived, absoluteMaxBytes);
}

export function productSourceHeadBaselineBytes(objects, expectedCount) {
  if (
    !Array.isArray(objects) ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    objects.length !== expectedCount
  )
    throw new Error("Product rig source manifest HEAD inventory was incomplete");
  let bytes = 0;
  for (const object of objects) {
    if (typeof object === "string" && object.endsWith(" missing")) continue;
    const match = typeof object === "string" ? /^blob ([0-9]+)$/u.exec(object) : null;
    const size = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error("Product rig source manifest HEAD inventory was invalid");
    bytes += size;
    if (!Number.isSafeInteger(bytes))
      throw new Error("Product rig source manifest HEAD inventory overflowed");
  }
  return bytes;
}

export function buildProductSourceManifest(
  paths,
  { openFile, statFile, readChunk, closeFile },
  maxBytes,
) {
  if (
    !Array.isArray(paths) ||
    paths.length > PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > PRODUCT_RIG_SOURCE_MANIFEST_ABSOLUTE_MAX_BYTES
  )
    throw new Error("Product rig source manifest budget or inventory was invalid");
  const ordered = [...paths].sort();
  if (new Set(ordered).size !== ordered.length)
    throw new Error("Product rig source manifest inventory was malformed");
  let manifestBytes = 0;
  const manifest = ordered.map((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      /[\0\r\n]/u.test(path) ||
      Buffer.byteLength(path) > PRODUCT_RIG_SOURCE_PATH_MAX_BYTES ||
      !productRigSourceTraceIncludesPath(path)
    )
      throw new Error("Product rig source manifest path was malformed");
    const pathDigest = createHash("sha256").update(path).digest("hex");
    let descriptor;
    try {
      descriptor = openFile(path);
    } catch (error) {
      if (error?.code === "ENOENT") {
        let appeared;
        try {
          appeared = openFile(path);
        } catch (confirmationError) {
          if (confirmationError?.code === "ENOENT") {
            return Object.freeze({
              pathDigest,
              contentDigest: createHash("sha256").update("deleted").digest("hex"),
              bytes: 0,
            });
          }
          throw new Error("Product rig source changed while building its manifest", {
            cause: confirmationError,
          });
        }
        try {
          throw new Error("Product rig source changed while building its manifest", {
            cause: error,
          });
        } finally {
          closeFile(appeared);
        }
      }
      throw error;
    }
    try {
      const before = statFile(descriptor);
      if (!before?.isFile?.() || !Number.isSafeInteger(before.size) || before.size < 0)
        throw new Error("Product rig source manifest encountered a non-regular file");
      const nextBytes = manifestBytes + before.size;
      if (!Number.isSafeInteger(nextBytes) || nextBytes > maxBytes)
        throw new Error("Product rig source manifest exceeded its byte ceiling");
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(
        Math.max(1, Math.min(PRODUCT_RIG_SOURCE_MANIFEST_HASH_CHUNK_BYTES, before.size || 1)),
      );
      let offset = 0;
      while (offset < before.size) {
        const requested = Math.min(chunk.length, before.size - offset);
        const count = readChunk(descriptor, chunk, requested, offset);
        if (!Number.isSafeInteger(count) || count < 1 || count > requested)
          throw new Error("Product rig source changed while building its manifest");
        hash.update(chunk.subarray(0, count));
        offset += count;
      }
      const growthProbe = Buffer.allocUnsafe(1);
      const grew = readChunk(descriptor, growthProbe, 1, before.size) !== 0;
      const after = statFile(descriptor);
      let currentDescriptor;
      let current;
      try {
        currentDescriptor = openFile(path);
        current = statFile(currentDescriptor);
      } catch {
        throw new Error("Product rig source changed while building its manifest");
      } finally {
        if (currentDescriptor !== undefined) closeFile(currentDescriptor);
      }
      if (
        offset !== before.size ||
        grew ||
        !after?.isFile?.() ||
        after.size !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        !current?.isFile?.() ||
        current.size !== before.size ||
        current.dev !== before.dev ||
        current.ino !== before.ino
      )
        throw new Error("Product rig source changed while building its manifest");
      manifestBytes = nextBytes;
      return Object.freeze({
        pathDigest,
        contentDigest: hash.digest("hex"),
        bytes: before.size,
      });
    } finally {
      closeFile(descriptor);
    }
  });
  return Object.freeze({
    bytes: manifestBytes,
    manifest: Object.freeze(manifest),
    manifestDigest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  });
}

export function buildSourceTracePayload(
  trackedDiff,
  untrackedFiles,
  maxBytes = PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
) {
  const diffLength = Buffer.isBuffer(trackedDiff)
    ? trackedDiff.length
    : Buffer.byteLength(trackedDiff ?? "");
  const header = Buffer.from(`tmux-ide-source-v2\ntracked ${diffLength}\n`);
  let totalBytes = header.length + diffLength;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes)
    throw new Error(`Product rig source snapshot exceeded the ${maxBytes}-byte hard ceiling`);
  const diff = Buffer.isBuffer(trackedDiff) ? trackedDiff : Buffer.from(trackedDiff ?? "");
  const sourceFiles = untrackedFiles ?? [];
  if (!Array.isArray(sourceFiles) || sourceFiles.length > PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS)
    throw new Error("Product rig untracked source inventory exceeded its path-count ceiling");
  const files = [...sourceFiles]
    .map(({ path, content }) => ({ path, content }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const seen = new Set();
  const chunks = [header, diff];
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..") ||
      /[\0\r\n]/u.test(file.path) ||
      Buffer.byteLength(file.path) > PRODUCT_RIG_SOURCE_PATH_MAX_BYTES ||
      seen.has(file.path)
    )
      throw new Error("Product rig untracked source inventory is malformed");
    seen.add(file.path);
    const path = Buffer.from(file.path);
    const contentLength = Buffer.isBuffer(file.content)
      ? file.content.length
      : Buffer.byteLength(file.content ?? "");
    const fileHeader = Buffer.from(`\nfile ${path.length} ${contentLength}\n`);
    totalBytes += fileHeader.length + path.length + contentLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) {
      throw new Error(`Product rig source snapshot exceeded the ${maxBytes}-byte hard ceiling`);
    }
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content ?? "");
    chunks.push(fileHeader, path, content);
  }
  if (totalBytes > maxBytes) {
    throw new Error(`Product rig source snapshot exceeded the ${maxBytes}-byte hard ceiling`);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function productRigGitBlobObjectId(payload, maxBytes = PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || bytes.length > maxBytes)
    throw new Error("Product rig Git blob payload exceeded its bounded byte ceiling");
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
}

export function readBoundedSourceTraceFiles(
  trackedDiff,
  paths,
  { openFile, statFile, readFile, closeFile },
  maxBytes = PRODUCT_RIG_SOURCE_DIFF_MAX_BYTES,
) {
  if (!Array.isArray(paths) || paths.length > PRODUCT_RIG_SOURCE_INVENTORY_MAX_PATHS)
    throw new Error("Product rig untracked source inventory exceeded its path-count ceiling");
  const diffLength = Buffer.byteLength(trackedDiff);
  let totalBytes = Buffer.byteLength(`tmux-ide-source-v2\ntracked ${diffLength}\n`) + diffLength;
  const files = [];
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path);
    if (pathBytes === 0 || pathBytes > PRODUCT_RIG_SOURCE_PATH_MAX_BYTES)
      throw new Error("Product rig untracked source path exceeded its byte ceiling");
    const descriptor = openFile(path);
    try {
      const stat = statFile(descriptor);
      if (!stat?.isFile?.() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        throw new Error(`Product rig untracked source is not a regular file: ${path}`);
      const headerBytes = Buffer.byteLength(`\nfile ${pathBytes} ${stat.size}\n`);
      const nextTotal = totalBytes + headerBytes + pathBytes + stat.size;
      if (!Number.isSafeInteger(nextTotal) || nextTotal > maxBytes)
        throw new Error(`Product rig source snapshot exceeded the ${maxBytes}-byte hard ceiling`);
      const content = readFile(descriptor, stat.size);
      if (!Buffer.isBuffer(content) || content.length !== stat.size)
        throw new Error(`Product rig untracked source changed while hashing: ${path}`);
      const after = statFile(descriptor);
      if (
        !after?.isFile?.() ||
        after.size !== stat.size ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino
      )
        throw new Error(`Product rig untracked source changed while hashing: ${path}`);
      totalBytes = nextTotal;
      files.push({ path, content });
    } finally {
      closeFile(descriptor);
    }
  }
  return files;
}

export function productRigSourceTraceDiffArgs() {
  return ["diff", "--binary", "HEAD", "--", ".", ":(exclude)packages/daemon/native/**"];
}

export function productRigSourceTraceUntrackedArgs() {
  return [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ":(exclude)packages/daemon/native/**",
  ];
}

export function productRigSourceTraceIncludesPath(path) {
  return typeof path === "string" && !path.startsWith("packages/daemon/native/");
}

export function createProductRigAttemptTimelineClock(
  now = () => performance.timeOrigin + performance.now(),
  origin = now(),
) {
  if (!Number.isFinite(origin)) throw new Error("Product rig timeline origin is unavailable");
  let previous = 0;
  return Object.freeze({
    elapsedMs() {
      const current = now();
      if (!Number.isFinite(current) || current < origin)
        throw new Error("Product rig timeline clock regressed");
      const elapsed = Math.floor(current - origin);
      if (!Number.isSafeInteger(elapsed) || elapsed < previous)
        throw new Error("Product rig timeline elapsed time is invalid");
      previous = elapsed;
      return elapsed;
    },
  });
}

export function productRigHostHeartbeatObservation({
  previousHeartbeatWallMs,
  wallNowMs,
  expectedIntervalMs = 100,
  suspensionThresholdMs = 5_000,
}) {
  const values = [previousHeartbeatWallMs, wallNowMs, expectedIntervalMs, suspensionThresholdMs];
  if (!values.every(Number.isFinite) || !Number.isFinite(suspensionThresholdMs)) {
    return Object.freeze({ reason: "heartbeat-unavailable", suspended: false, gapMs: null });
  }
  const elapsedMs = Math.max(0, wallNowMs - previousHeartbeatWallMs);
  const gapMs = Math.max(0, elapsedMs - expectedIntervalMs);
  return Object.freeze({
    reason: gapMs >= suspensionThresholdMs ? "host-suspended" : "running",
    suspended: gapMs >= suspensionThresholdMs,
    elapsedMs: Math.round(elapsedMs),
    expectedIntervalMs: Math.round(expectedIntervalMs),
    gapMs: Math.round(gapMs),
  });
}

export function compareProductSourceProvenance(expected, actual, changedLimit = 16) {
  const expectedFiles = new Map(
    Array.isArray(expected?.manifest)
      ? expected.manifest.map((entry) => [entry.pathDigest, entry])
      : [],
  );
  const actualFiles = new Map(
    Array.isArray(actual?.manifest)
      ? actual.manifest.map((entry) => [entry.pathDigest, entry])
      : [],
  );
  const changed = [...new Set([...expectedFiles.keys(), ...actualFiles.keys()])]
    .sort()
    .filter((pathDigest) => {
      const before = expectedFiles.get(pathDigest);
      const after = actualFiles.get(pathDigest);
      return (
        !before ||
        !after ||
        before.contentDigest !== after.contentDigest ||
        before.bytes !== after.bytes
      );
    });
  const stable =
    expected?.commit === actual?.commit &&
    expected?.tree === actual?.tree &&
    expected?.manifestDigest === actual?.manifestDigest &&
    changed.length === 0;
  return Object.freeze({
    stable,
    commitExact: expected?.commit === actual?.commit,
    treeExact: expected?.tree === actual?.tree,
    manifestExact: expected?.manifestDigest === actual?.manifestDigest,
    changedCount: changed.length,
    changedPathDigests: Object.freeze(changed.slice(0, changedLimit)),
  });
}
const WARM_COHERENT_SAMPLE_COUNT = 20;
const MEMORY_BUDGET = JSON.parse(
  readFileSync(new URL("../performance/reference-budgets.json", import.meta.url), "utf8"),
).memory;
const PRODUCT_RESOURCE_LOAD_LINES = 300;
export const PRODUCT_RESOURCE_CONDITIONING_CYCLE_COUNT = 8;
export const PRODUCT_RESOURCE_MEASURED_CYCLE_COUNT = 16;
const PRODUCT_RESOURCE_PROBES = "abcdefghijklmnopqrstuvwx";

/**
 * Every conditioning and measured cycle closes a distinct
 * load→clear→settle→probe epoch. The first eight cycles condition fixed
 * allocator/xterm high-water state; only the following sixteen are retained
 * as independent memory endpoints.
 */
export function productResourceCyclePlan(...configuration) {
  if (configuration.length !== 0)
    throw new TypeError("Product resource conditioning plan is fixed and cannot be configured");
  if (MEMORY_BUDGET.minimumSamples !== PRODUCT_RESOURCE_MEASURED_CYCLE_COUNT)
    throw new Error("Product resource measured-cycle count must match the memory budget");
  const cycleCount =
    PRODUCT_RESOURCE_CONDITIONING_CYCLE_COUNT + PRODUCT_RESOURCE_MEASURED_CYCLE_COUNT;
  if (PRODUCT_RESOURCE_PROBES.length !== cycleCount)
    throw new Error("Product resource probe alphabet must match the fixed cycle count");
  return Object.freeze(
    Array.from({ length: cycleCount }, (_, cycle) => {
      const measured = cycle >= PRODUCT_RESOURCE_CONDITIONING_CYCLE_COUNT;
      return Object.freeze({
        cycle,
        phase: measured ? "measured" : "conditioning",
        measured,
        measuredIndex: measured ? cycle - PRODUCT_RESOURCE_CONDITIONING_CYCLE_COUNT : null,
        loadLines: PRODUCT_RESOURCE_LOAD_LINES,
        cycleMarker: `tmux-ide-settled-${cycle}`,
        probe: PRODUCT_RESOURCE_PROBES[cycle],
      });
    }),
  );
}

export function productResourceMeasuredEndpointTraceIds(cycleEndpoints) {
  const plan = productResourceCyclePlan();
  if (!Array.isArray(cycleEndpoints) || cycleEndpoints.length !== plan.length)
    throw new Error(`Product resource run must close exactly ${plan.length} cycle endpoints`);
  const traceIds = new Set();
  const measuredTraceIds = [];
  for (const [index, expected] of plan.entries()) {
    const endpoint = cycleEndpoints[index];
    if (
      endpoint?.cycle !== expected.cycle ||
      endpoint?.phase !== expected.phase ||
      typeof endpoint?.traceId !== "string" ||
      endpoint.traceId.length === 0
    )
      throw new Error(`Product resource endpoint identity mismatch at cycle ${expected.cycle}`);
    if (traceIds.has(endpoint.traceId))
      throw new Error(
        `Product resource endpoint trace id is duplicated at cycle ${expected.cycle}`,
      );
    traceIds.add(endpoint.traceId);
    if (expected.measured) measuredTraceIds.push(endpoint.traceId);
  }
  return Object.freeze(measuredTraceIds);
}

export function productResourceCycleCommands({ cycle, loadLines }) {
  if (
    !Number.isSafeInteger(cycle) ||
    cycle < 0 ||
    !Number.isSafeInteger(loadLines) ||
    loadLines < 1
  )
    throw new TypeError("Product resource cycle command requires bounded integer inputs");
  return Object.freeze({
    floodCommand: `i=0; while [ $i -lt ${loadLines} ]; do echo tmux-ide-load-$i; i=$((i+1)); done; printf 'tmux-ide-flood-%s\\n' '${cycle}'`,
    settleCommand: `printf '\\033[2J\\033[3J\\033[Htmux-ide-settled-%s\\n' '${cycle}'`,
  });
}

export function productInputQueueObservation(records, processId) {
  return (
    records.findLast(
      (record) =>
        ((record?.type === "performance.stage" && record.stage === "client") ||
          record?.type === "performance.input-queue-state") &&
        record.processId === processId &&
        Number.isFinite(record.inputPending) &&
        Number.isFinite(record.inputInFlight) &&
        Number.isFinite(record.inputPendingBytes),
    ) ?? null
  );
}

export function causalFixtureBaselineReadiness(observation) {
  const queueObservation = observation?.queueObservation ?? null;
  const predicates = Object.freeze({
    optionReady: observation?.fixtureOption === observation?.expectedOption,
    helperCommandReady: observation?.currentCommand === "node",
    queueObserved: queueObservation !== null,
    queueZero:
      queueObservation?.inputPending === 0 &&
      queueObservation.inputInFlight === 0 &&
      queueObservation.inputPendingBytes === 0,
    paneIdentityReady: observation?.activePaneId === observation?.fixturePaneId,
    geometryStable: observation?.geometryBefore === observation?.geometryAfter,
    nativeCellBlank: observation?.nativeCell === " ",
    tuiCellBlank: observation?.tuiCell === " ",
  });
  return Object.freeze({
    ready: Object.values(predicates).every(Boolean),
    predicates,
  });
}

export function productInputQueuesSettled(records, processId) {
  const observation = productInputQueueObservation(records, processId);
  return (
    observation?.inputPending === 0 &&
    observation.inputInFlight === 0 &&
    observation.inputPendingBytes === 0
  );
}

export function productResourceEndpointCandidates(beforeSamples, afterSamples, expected) {
  const baseline = new Set(beforeSamples.map(({ traceId }) => traceId));
  return Object.freeze(
    afterSamples.filter(
      (sample) =>
        !baseline.has(sample.traceId) &&
        sample.processId === expected.processId &&
        sample.generation === expected.generation &&
        sample.semanticPaneId === expected.semanticPaneId &&
        sample.paintStateIdentity === "latest-canonical-state-blitted" &&
        Number.isInteger(sample.revision) &&
        typeof sample.stateHash === "string",
    ),
  );
}

export function selectProductResourceEndpoint(beforeSamples, afterSamples, expected) {
  const candidates = productResourceEndpointCandidates(beforeSamples, afterSamples, expected);
  if (candidates.length === 0)
    throw new Error(`Missing paired resource endpoint for cycle ${expected.cycle}`);
  if (candidates.length !== 1)
    throw new Error(
      `Ambiguous paired resource endpoint for cycle ${expected.cycle}: ${candidates.length} candidates`,
    );
  return candidates[0];
}

export function productResourceEndpointEpochState({
  beforeSamples,
  afterSamples,
  expected,
  inputSettled,
  traceQuiet,
  probeCellCount,
  geometryStable,
}) {
  if (!geometryStable)
    throw new Error(`Resource probe geometry changed during cycle ${expected.cycle}`);
  if (probeCellCount > 1)
    throw new Error(
      `Ambiguous visible resource probe for cycle ${expected.cycle}: ${probeCellCount} cells`,
    );
  const candidates = productResourceEndpointCandidates(beforeSamples, afterSamples, expected);
  if (candidates.length > 1) selectProductResourceEndpoint(beforeSamples, afterSamples, expected);
  if (
    candidates.length !== 1 ||
    probeCellCount !== 1 ||
    inputSettled !== true ||
    traceQuiet !== true
  )
    return Object.freeze({ status: "pending", endpoint: null });
  return Object.freeze({ status: "ready", endpoint: candidates[0] });
}

function newlyVisibleProbeCells(before, after, probe) {
  const beforeLines = String(before).split("\n");
  return String(after)
    .split("\n")
    .flatMap((line, row) =>
      Array.from(line).flatMap((cell, col) =>
        cell === probe && Array.from(beforeLines[row] ?? "")[col] !== probe
          ? [`${row}:${col}`]
          : [],
      ),
    );
}

export function productResourceProbeCells({
  beforeNative,
  afterNative,
  beforeTui,
  afterTui,
  probe,
}) {
  if (typeof probe !== "string" || !/^[\x21-\x7e]$/u.test(probe))
    throw new TypeError("Product resource probe must be exactly one printable ASCII character");
  const native = new Set(newlyVisibleProbeCells(beforeNative, afterNative, probe));
  return Object.freeze(
    newlyVisibleProbeCells(beforeTui, afterTui, probe)
      .filter((coordinate) => native.has(coordinate))
      .map((coordinate) => {
        const [row, col] = coordinate.split(":").map(Number);
        return Object.freeze({ row, col });
      }),
  );
}

export function productResourceGeometryIdentity(frame, pane) {
  const rect = resolvePaneBodyRect(frame, pane);
  if (!rect.valid) return null;
  return JSON.stringify({
    pane: paneGeometryIdentity([pane]),
    body: {
      left: rect.left,
      firstBodyRow: rect.firstBodyRow,
      width: rect.width,
      bodyRows: rect.bodyRows,
      origin: rect.origin,
    },
  });
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function waitForLifecycleEntry({
  findEntry,
  subscribe,
  timeoutMs,
  timeoutMessage,
  pollIntervalMs = 25,
}) {
  const existing = findEntry();
  if (existing) return existing;

  return await new Promise((resolveWait, rejectWait) => {
    let settled = false;
    let checking = false;
    let deadline = null;
    let poller = null;
    let watcher = null;
    const finish = (error, entry = null) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (poller) clearInterval(poller);
      watcher?.close();
      if (error) rejectWait(error);
      else resolveWait(entry);
    };
    const check = () => {
      if (checking || settled) return;
      checking = true;
      try {
        const entry = findEntry();
        if (entry) finish(null, entry);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      } finally {
        checking = false;
      }
    };
    try {
      watcher = subscribe(check);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    deadline = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs);
    poller = setInterval(check, pollIntervalMs);
    // Close the subscribe/read race. The bounded poll also covers dropped or
    // inode-stale filesystem notifications without spawning another process.
    check();
  });
}

export function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function productCapturePageUrlStatus(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048)
    return Object.freeze({ exact: false, pageUrl: null, reason: "missing-or-shape" });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return Object.freeze({ exact: false, pageUrl: null, reason: "malformed" });
  }
  if (parsed.protocol !== "http:")
    return Object.freeze({ exact: false, pageUrl: null, reason: "scheme" });
  if (!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname))
    return Object.freeze({ exact: false, pageUrl: null, reason: "host" });
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    return Object.freeze({ exact: false, pageUrl: null, reason: "port" });
  if (parsed.username !== "" || parsed.password !== "")
    return Object.freeze({ exact: false, pageUrl: null, reason: "credentials" });
  return Object.freeze({ exact: true, pageUrl: value, reason: null });
}

export function publicRigStatus(state) {
  if (!state) return { status: "stopped", running: false };
  const running = state.status !== "stopped" && processAlive(state.ownerPid);
  return {
    version: state.version,
    status: running ? state.status : "stopped",
    running,
    ownerPid: state.ownerPid,
    runtimeNamespace: state.runtimeNamespace,
    session: state.session,
    daemon: state.daemon
      ? {
          pid: state.daemon.pid,
          port: state.daemon.port,
          instanceId: state.daemon.instanceId,
        }
      : null,
    web: state.web ? { pageUrl: state.web.pageUrl } : null,
    tui: state.tui ?? null,
    convergence: state.convergence
      ? {
          status: state.convergence.status,
          generation: state.convergence.generation,
          clientCount: state.convergence.clientCount,
          timings: state.convergence.timings,
        }
      : null,
    artifactDir: state.artifactDir,
    timelinePath: state.timelinePath,
    webStartupFailureArtifact: state.webStartupFailureArtifact ?? null,
    failure: state.failure ?? null,
  };
}

export function coherentReadiness({ chromeMs, terminalMs }) {
  return {
    appChromeFrameMs: Number.isFinite(chromeMs) ? Math.round(chromeMs) : null,
    coherentTerminalFrameMs: Number.isFinite(terminalMs) ? Math.round(terminalMs) : null,
    ready:
      Number.isFinite(chromeMs) &&
      Number.isFinite(terminalMs) &&
      Number(terminalMs) >= Number(chromeMs),
  };
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

/**
 * Resolve the body rectangle actually published by root-v2.
 *
 * Tmux geometry is the source of truth for pane size, but it is not a safe
 * origin for an external framebuffer capture: another attached client may
 * change tmux's reported origin between the layout publication and this
 * observation. The semantic pane chrome is rendered in the same framebuffer
 * as the body, so it is the exact origin anchor whenever it is present.
 */
export function resolvePaneBodyRect(frame, pane) {
  const lines = String(frame).split("\n");
  const fallback = Object.freeze({
    left: pane.left,
    firstBodyRow: pane.top + 3,
    width: pane.width,
    bodyRows: Math.max(0, pane.height),
    origin: "tmux-geometry",
    valid: true,
    semanticChromeMatches: 0,
  });
  if (typeof pane.semanticPaneId !== "string" || pane.semanticPaneId.length === 0) {
    return Object.freeze({
      ...fallback,
      bodyRows: 0,
      origin: "semantic-pane-identity-missing",
      valid: false,
    });
  }

  const chromeMatches = (identity) => {
    if (typeof identity !== "string" || identity.length === 0) return [];
    const matches = [];
    for (let row = 0; row < lines.length; row += 1) {
      const line = lines[row];
      let index = line.indexOf(identity);
      while (index >= 0) {
        const prefix = line.slice(Math.max(0, index - 2), index);
        const suffix = line[index + identity.length];
        if ((prefix === "● " || prefix === "○ ") && (suffix === undefined || suffix === " "))
          matches.push({ row, left: index - 2 });
        index = line.indexOf(identity, index + 1);
      }
    }
    return matches;
  };
  // Older frames exposed the durable pane id in their title. The release UI
  // now presents the daemon-authored display name instead, so carry that
  // canonical layout fact into the evidence input and use it only when the
  // legacy semantic-id anchor is absent. Duplicate visible names still fail
  // closed rather than letting evidence attach a body to the wrong pane.
  const semanticMatches = chromeMatches(pane.semanticPaneId);
  const displayIdentities = [pane.displayName, ...(pane.canonicalDisplayNames ?? [])]
    .map((identity) => identity?.trim())
    .filter((identity, index, identities) => identity && identities.indexOf(identity) === index);
  const displayMatches = [
    ...new Map(
      displayIdentities
        .flatMap(chromeMatches)
        .map((match) => [`${match.row}:${match.left}`, match]),
    ).values(),
  ];
  const matches = semanticMatches.length > 0 ? semanticMatches : displayMatches;
  if (matches.length !== 1) {
    return Object.freeze({
      ...fallback,
      bodyRows: 0,
      origin:
        matches.length === 0 ? "semantic-pane-chrome-missing" : "semantic-pane-chrome-ambiguous",
      valid: false,
      semanticChromeMatches: matches.length,
    });
  }
  const [match] = matches;
  return Object.freeze({
    left: match.left,
    firstBodyRow: match.row + 1,
    width: pane.width,
    bodyRows: Math.max(0, pane.height),
    origin: "semantic-pane-chrome",
    valid: true,
    semanticChromeMatches: 1,
  });
}

/** Exact body rectangle used by root-v2: app header + tabs + pane chrome. */
export function paneBodyRegion(frame, pane) {
  const lines = String(frame).split("\n");
  const rect = resolvePaneBodyRect(frame, pane);
  if (!rect.valid) return "";
  return lines
    .slice(rect.firstBodyRow, rect.firstBodyRow + rect.bodyRows)
    .map((line) => line.slice(rect.left, rect.left + rect.width))
    .join("\n");
}

/** Stable identity for one exact active-window geometry sample. */
export function paneGeometryIdentity(panes) {
  return JSON.stringify(
    [...panes]
      .map(({ paneId, semanticPaneId, left, top, width, height }) => ({
        paneId,
        semanticPaneId,
        left,
        top,
        width,
        height,
      }))
      .sort((left, right) => String(left.paneId).localeCompare(String(right.paneId))),
  );
}

/** Parse the one active tmux pane without confusing runtime and semantic IDs. */
export function activeTmuxPaneFromRows(rows) {
  const panes = String(rows)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [paneId, windowActive, paneActive, semanticPaneId, left, top, width, height] =
        line.split("|");
      return {
        paneId,
        windowActive: windowActive === "1",
        paneActive: paneActive === "1",
        semanticPaneId,
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
      };
    });
  const active = panes.filter((candidate) => candidate.windowActive && candidate.paneActive);
  if (active.length !== 1) return null;
  const pane = active[0];
  if (!pane?.paneId || !pane.semanticPaneId) return null;
  if (![pane.left, pane.top, pane.width, pane.height].every(Number.isFinite)) return null;
  return Object.freeze(pane);
}

export function bindPromotedInitialPane(initialPane, promotedPane) {
  if (
    !initialPane ||
    !promotedPane ||
    !/^%[0-9]+$/u.test(initialPane.paneId ?? "") ||
    promotedPane.paneId !== initialPane.paneId ||
    typeof promotedPane.semanticPaneId !== "string" ||
    promotedPane.semanticPaneId.length === 0
  )
    throw new Error("promoted active pane did not match the exact initial raw pane");
  return Object.freeze({ ...promotedPane, initialGeometry: Object.freeze({ ...initialPane }) });
}

export function coherentGenerationPaint(lifecycle) {
  const painted =
    lifecycle.findLast((entry) => entry?.phase === "host-terminal-publication") ??
    lifecycle.findLast((entry) => entry?.phase === "first-terminal-frame");
  const generation = painted?.daemonGeneration ?? painted?.generation;
  return typeof generation === "string" && Number.isFinite(painted?.elapsedMs)
    ? Object.freeze({ ...painted, daemonGeneration: generation })
    : null;
}

export function coherentGenerationDuration(lifecycle) {
  const painted = coherentGenerationPaint(lifecycle);
  if (!painted) return null;
  const connected = lifecycle.find(
    (entry) =>
      entry?.phase === "generation-connection-resolved" &&
      entry?.daemonGeneration === painted.daemonGeneration,
  );
  if (!connected || !Number.isFinite(connected.elapsedMs)) return null;
  return painted.elapsedMs - connected.elapsedMs;
}

export function inputPaintSamples(records) {
  const byTrace = new Map();
  for (const record of records) {
    if (record?.type !== "performance.stage" || typeof record.traceId !== "string") continue;
    const stages = byTrace.get(record.traceId) ?? { input: [], paint: [] };
    if (record.stage === "input" || record.stage === "paint") stages[record.stage].push(record);
    byTrace.set(record.traceId, stages);
  }
  return [...byTrace.entries()].flatMap(([traceId, stages]) => {
    // Duplicate/reordered endpoints are ambiguous and never qualify. A gate
    // must not silently take the last record and bias the distribution.
    if (stages.input.length !== 1 || stages.paint.length !== 1) return [];
    const [input] = stages.input;
    const [paint] = stages.paint;
    if (
      !input ||
      !paint ||
      input.processId !== paint.processId ||
      input.clockId !== paint.clockId ||
      !Number.isFinite(input.startedAtMicros) ||
      !Number.isFinite(paint.endedAtMicros)
    )
      return [];
    return [
      Object.freeze({
        traceId,
        durationMs: (paint.endedAtMicros - input.startedAtMicros) / 1_000,
        // Input stages record the authority tuple while changed-cell paint
        // stages carry the generation directly. Accept both shapes so the
        // report does not discard real same-process samples as unowned.
        generation: paint.authority?.generation ?? paint.generation ?? null,
        incarnation: paint.authority?.incarnation ?? paint.incarnation ?? null,
        processId: paint.processId,
        clockId: paint.clockId,
        semanticPaneId: paint.semanticPaneId ?? null,
        revision: Number.isInteger(paint.revision) ? paint.revision : null,
        stateHash: typeof paint.stateHash === "string" ? paint.stateHash : null,
        paintStateIdentity: paint.paintStateIdentity ?? null,
      }),
    ];
  });
}

export function causalInputSamples(traceRecords, daemonTraceRecords = []) {
  const inputs = inputPaintSamples(traceRecords);
  return inputs.map((sample) => {
    const input = traceRecords.find(
      (record) =>
        record?.type === "performance.stage" &&
        record.traceId === sample.traceId &&
        record.stage === "input",
    );
    const clientStages = traceRecords
      .filter(
        (record) =>
          record?.type === "performance.stage" &&
          record.traceId === sample.traceId &&
          record.stage === "client" &&
          record.processId === sample.processId &&
          record.clockId === sample.clockId &&
          Number.isFinite(record.atMicros),
      )
      .map((record) => ({
        operation: record.operation,
        atMicros: record.atMicros,
        offsetMs: Number.isFinite(input?.startedAtMicros)
          ? (record.atMicros - input.startedAtMicros) / 1_000
          : null,
        causalAttribution: record.causalAttribution === true,
        semanticPaneId: record.semanticPaneId ?? null,
        generation: record.generation ?? null,
        incarnation: record.incarnation ?? null,
        revision: Number.isInteger(record.revision) ? record.revision : null,
        stateHash: typeof record.stateHash === "string" ? record.stateHash : null,
        row: Number.isInteger(record.row) ? record.row : null,
        column: Number.isInteger(record.column) ? record.column : null,
        beforeGrapheme: record.beforeGrapheme ?? null,
        afterGrapheme: record.afterGrapheme ?? null,
        dirtyRowProved: record.dirtyRowProved === true,
        inputPending: Number.isFinite(record.inputPending) ? record.inputPending : null,
        inputInFlight: Number.isFinite(record.inputInFlight) ? record.inputInFlight : null,
        inputPendingBytes: Number.isFinite(record.inputPendingBytes)
          ? record.inputPendingBytes
          : null,
        bufferedAmount: Number.isSafeInteger(record.bufferedAmount) ? record.bufferedAmount : null,
        frameBytes: Number.isSafeInteger(record.frameBytes) ? record.frameBytes : null,
        drained: typeof record.drained === "boolean" ? record.drained : null,
        sharedMicros: Number.isSafeInteger(record.sharedMicros) ? record.sharedMicros : null,
        clockOffsetLowerMicros: Number.isSafeInteger(record.clockOffsetLowerMicros)
          ? record.clockOffsetLowerMicros
          : null,
        clockOffsetUpperMicros: Number.isSafeInteger(record.clockOffsetUpperMicros)
          ? record.clockOffsetUpperMicros
          : null,
        clockUncertaintyMicros: Number.isSafeInteger(record.clockUncertaintyMicros)
          ? record.clockUncertaintyMicros
          : null,
        clockCalibratedAtMicros: Number.isSafeInteger(record.clockCalibratedAtMicros)
          ? record.clockCalibratedAtMicros
          : null,
        clockCalibrationRequestId:
          typeof record.clockCalibrationRequestId === "string"
            ? record.clockCalibrationRequestId
            : null,
      }));
    const matchingDaemonRecords = daemonTraceRecords.filter(
      (record) =>
        record?.type === "performance.stage" &&
        record.traceId === sample.traceId &&
        Number.isFinite(record.startedAtMicros) &&
        Number.isFinite(record.endedAtMicros),
    );
    const daemonOrigin = matchingDaemonRecords.find(
      (record) => record.operation === "raw-input-command",
    );
    const daemonSpans = matchingDaemonRecords
      .filter(
        (record) =>
          !daemonOrigin ||
          (record.processId === daemonOrigin.processId && record.clockId === daemonOrigin.clockId),
      )
      .map((record) => ({
        stage: record.stage,
        operation: record.operation,
        startedAtMicros: record.startedAtMicros,
        endedAtMicros: record.endedAtMicros,
        // These offsets are daemon-local. They intentionally never subtract
        // an OpenTUI timestamp from a daemon timestamp.
        offsetMs: daemonOrigin
          ? (record.startedAtMicros - daemonOrigin.startedAtMicros) / 1_000
          : null,
        durationMs: (record.endedAtMicros - record.startedAtMicros) / 1_000,
        processId: record.processId,
        clockId: record.clockId,
        ...(Number.isSafeInteger(record.sharedStartedAtMicros)
          ? { sharedStartedAtMicros: record.sharedStartedAtMicros }
          : {}),
        ...(Number.isSafeInteger(record.sharedEndedAtMicros)
          ? { sharedEndedAtMicros: record.sharedEndedAtMicros }
          : {}),
      }));
    return Object.freeze({ ...sample, clientStages, daemonSpans });
  });
}

export function causalInputSampleHasIncarnation(sample) {
  return typeof sample?.incarnation === "string" && sample.incarnation.length > 0;
}

/** Close one diagnostic input epoch without admitting a second logical probe. */
export function causalProbeEpochState(records, baseline, processId) {
  const epoch = records.slice(baseline);
  const inputs = epoch.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "input" &&
      record.processId === processId &&
      typeof record.traceId === "string",
  );
  const traceIds = [...new Set(inputs.map(({ traceId }) => traceId))];
  if (traceIds.length > 1 || inputs.length > 1)
    return Object.freeze({ status: "ambiguous", traceId: null, reason: "multiple-inputs" });
  const traceId = traceIds[0];
  if (!traceId) return Object.freeze({ status: "pending", traceId: null, reason: null });
  const terminal = epoch.filter(
    (record) =>
      record?.type === "performance.stage" &&
      record.stage === "client" &&
      record.processId === processId &&
      record.traceId === traceId &&
      (record.operation === "causal-cell-painted" ||
        String(record.operation).startsWith("causal-cell-failed:")),
  );
  if (terminal.length > 1)
    return Object.freeze({ status: "ambiguous", traceId, reason: "multiple-terminals" });
  if (terminal.length === 0) return Object.freeze({ status: "pending", traceId, reason: null });
  const operation = terminal[0].operation;
  return Object.freeze(
    operation === "causal-cell-painted"
      ? { status: "proved", traceId, reason: null }
      : { status: "failed", traceId, reason: operation.slice("causal-cell-failed:".length) },
  );
}

export function causalFixtureShellReady(observation) {
  return (
    observation?.fixtureOption === "" &&
    typeof observation?.expectedCommand === "string" &&
    observation.expectedCommand.length > 0 &&
    observation.currentCommand === observation.expectedCommand &&
    typeof observation?.marker === "string" &&
    observation.marker.length > 0 &&
    String(observation.nativeFrame).includes(observation.marker) &&
    String(observation.tuiBody).includes(observation.marker) &&
    observation.canonicalWraparound === true &&
    observation.inputPending === 0 &&
    observation.inputInFlight === 0 &&
    observation.inputPendingBytes === 0 &&
    observation.geometryStable === true
  );
}

export function latestCausalFixtureCanonicalMode(records, baseline, expected) {
  return (
    records
      .slice(baseline)
      .findLast(
        (record) =>
          record?.type === "performance.terminal-canonical-mode" &&
          record.processId === expected.processId &&
          record.semanticPaneId === expected.semanticPaneId &&
          record.generation === expected.generation &&
          record.incarnation === expected.incarnation,
      ) ?? null
  );
}

export function latestCausalFixtureCanonicalWraparound(records, baseline, expected) {
  return latestCausalFixtureCanonicalMode(records, baseline, expected)?.wraparound === true;
}

export function causalFixtureTeardownDiagnostic(observation) {
  const queueZero =
    observation?.inputPending === 0 &&
    observation.inputInFlight === 0 &&
    observation.inputPendingBytes === 0;
  return Object.freeze({
    optionEmpty: observation?.fixtureOption === "",
    commandMatches:
      typeof observation?.expectedCommand === "string" &&
      observation.expectedCommand.length > 0 &&
      observation.currentCommand === observation.expectedCommand,
    markerNative: Number.isInteger(observation?.markerNativeIndex),
    markerNativeIndex: Number.isInteger(observation?.markerNativeIndex)
      ? observation.markerNativeIndex
      : null,
    markerTui: Number.isInteger(observation?.markerTuiIndex),
    markerTuiIndex: Number.isInteger(observation?.markerTuiIndex)
      ? observation.markerTuiIndex
      : null,
    canonicalWraparound: observation?.canonicalWraparound === true,
    canonical:
      observation?.canonical && typeof observation.canonical === "object"
        ? Object.freeze({
            revision: Number.isInteger(observation.canonical.revision)
              ? observation.canonical.revision
              : null,
            stateHash:
              typeof observation.canonical.stateHash === "string"
                ? observation.canonical.stateHash.slice(0, 128)
                : null,
            incarnation:
              typeof observation.canonical.incarnation === "string"
                ? observation.canonical.incarnation.slice(0, 128)
                : null,
            wraparound: observation.canonical.wraparound === true,
          })
        : null,
    queueZero,
    queue: Object.freeze({
      type: typeof observation?.queueType === "string" ? observation.queueType.slice(0, 64) : null,
      operation:
        typeof observation?.queueOperation === "string"
          ? observation.queueOperation.slice(0, 64)
          : null,
      traceId:
        typeof observation?.queueTraceId === "string"
          ? observation.queueTraceId.slice(0, 128)
          : null,
      atMicros: Number.isFinite(observation?.queueAtMicros) ? observation.queueAtMicros : null,
      inputPending: Number.isFinite(observation?.inputPending) ? observation.inputPending : null,
      inputInFlight: Number.isFinite(observation?.inputInFlight) ? observation.inputInFlight : null,
      inputPendingBytes: Number.isFinite(observation?.inputPendingBytes)
        ? observation.inputPendingBytes
        : null,
    }),
    geometryStable: observation?.geometryStable === true,
    geometryBefore:
      typeof observation?.geometryBefore === "string"
        ? observation.geometryBefore.slice(0, 256)
        : null,
    geometryAfter:
      typeof observation?.geometryAfter === "string"
        ? observation.geometryAfter.slice(0, 256)
        : null,
    nativeHash:
      typeof observation?.nativeHash === "string" ? observation.nativeHash.slice(0, 128) : null,
    bodyHash: typeof observation?.bodyHash === "string" ? observation.bodyHash.slice(0, 128) : null,
  });
}

/**
 * Ordered diagnostic→resource phase boundary. The release callback is the
 * only authority to dispatch resource workload and is never called on an
 * observation error or deadline. Dependencies are injected so the complete
 * ordering is deterministic under test rather than inferred from source.
 */
export async function runCausalFixtureTeardownGate(options) {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const stableMs = options.stableMs ?? 100;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new TypeError("Causal fixture teardown timeout must be positive");
  const deadline = now() + timeoutMs;
  let markerSent = false;
  let markerSentAt = null;
  let stableIdentity = null;
  let stableSince = 0;
  let firstReadyAt = null;
  let maximumStableMs = 0;
  let observationCount = 0;
  let readyObservationCount = 0;
  let identityChanges = 0;
  const identityDeltaFields = new Set();
  let previousStabilityParts = null;
  let lastDiagnostic = null;
  await options.interrupt();
  while (now() <= deadline) {
    let observation;
    try {
      observation = await options.observe();
    } catch (cause) {
      throw new Error(
        `causal-cell fixture teardown observation failed: ${JSON.stringify({ observationCount, last: lastDiagnostic })}`,
        { cause },
      );
    }
    observationCount += 1;
    lastDiagnostic = causalFixtureTeardownDiagnostic(observation);
    if (
      !markerSent &&
      observation.fixtureOption === "" &&
      observation.currentCommand === observation.expectedCommand
    ) {
      await options.sendShellMarker();
      markerSent = true;
      markerSentAt = now();
      stableIdentity = null;
      stableSince = now();
    }
    const ready = markerSent && causalFixtureShellReady(observation);
    const identity = ready ? observation.stabilityIdentity : null;
    const sampledAt = now();
    if (ready) {
      readyObservationCount += 1;
      firstReadyAt ??= sampledAt;
    }
    if (ready && typeof identity === "string" && identity === stableIdentity) {
      maximumStableMs = Math.max(maximumStableMs, sampledAt - stableSince);
      if (sampledAt - stableSince >= stableMs) {
        await options.releaseResource();
        return Object.freeze({ canDispatchResource: true });
      }
    } else {
      if (ready && stableIdentity !== null && identity !== stableIdentity) identityChanges += 1;
      if (ready && previousStabilityParts && observation.stabilityParts) {
        for (const key of new Set([
          ...Object.keys(previousStabilityParts),
          ...Object.keys(observation.stabilityParts),
        ])) {
          if (previousStabilityParts[key] !== observation.stabilityParts[key])
            identityDeltaFields.add(key);
        }
      }
      stableIdentity = identity;
      stableSince = sampledAt;
    }
    previousStabilityParts = ready ? (observation.stabilityParts ?? null) : null;
    await wait(pollMs);
  }
  const failedPredicates = lastDiagnostic
    ? [
        ["option-empty", lastDiagnostic.optionEmpty],
        ["command-matches", lastDiagnostic.commandMatches],
        ["marker-native", lastDiagnostic.markerNative],
        ["marker-tui", lastDiagnostic.markerTui],
        ["canonical-wraparound", lastDiagnostic.canonicalWraparound],
        ["queue-zero", lastDiagnostic.queueZero],
        ["geometry-stable", lastDiagnostic.geometryStable],
      ]
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
    : ["no-observation"];
  const failureKind =
    failedPredicates.length > 0
      ? "predicate-failed"
      : identityChanges > 0
        ? "stability-identity-churn"
        : "stability-window-incomplete";
  throw new Error(
    `causal-cell fixture did not restore a quiet interactive shell: ${JSON.stringify({
      failureKind,
      failedPredicates,
      observationCount,
      readyObservationCount,
      markerSentAt,
      firstReadyAt,
      maximumStableMs,
      identityChanges,
      identityDeltaFields: [...identityDeltaFields].sort().slice(0, 32),
      last: lastDiagnostic,
    })}`,
  );
}

export function summarizeProductResources(clientStages, deliveries, endpointTraceIds = null) {
  const workloadMemorySamples = clientStages.flatMap((record, ordinal) =>
    Number.isFinite(record.rssBytes) && Number.isFinite(record.heapUsedBytes)
      ? [
          {
            traceKey: record.traceId ?? `untraced:${ordinal}`,
            rssBytes: record.rssBytes,
            heapUsedBytes: record.heapUsedBytes,
          },
        ]
      : [],
  );
  // A trace emits several causal stage records with the same process-memory
  // observation. Retained growth is evaluated from the final observation of
  // each bounded post-workload probe, not from the native allocator's
  // transient first-render/flood high-water. The full workload peak remains in
  // the report so a transient regression is still visible rather than hidden.
  const byTrace = new Map();
  for (const sample of workloadMemorySamples) byTrace.set(sample.traceKey, sample);
  const endpointSet = endpointTraceIds ? new Set(endpointTraceIds) : null;
  const memorySamples = [...byTrace.values()]
    .filter((sample) => endpointSet === null || endpointSet.has(sample.traceKey))
    .slice(endpointSet === null ? -16 : 0)
    .map(({ rssBytes, heapUsedBytes }) => ({ rssBytes, heapUsedBytes }));
  const rss = memorySamples.map(({ rssBytes }) => rssBytes);
  const heap = memorySamples.map(({ heapUsedBytes }) => heapUsedBytes);
  const settledInput = clientStages.findLast(
    (record) => Number.isFinite(record.inputPending) && Number.isFinite(record.inputInFlight),
  );
  return Object.freeze({
    inputPendingPeak: Math.max(0, ...clientStages.map((record) => record.inputPending ?? 0)),
    inputPendingBytesPeak: Math.max(
      0,
      ...clientStages.map((record) => record.inputPendingBytes ?? 0),
    ),
    inputInFlightPeak: Math.max(0, ...clientStages.map((record) => record.inputInFlight ?? 0)),
    settledInputPending: settledInput?.inputPending ?? null,
    settledInputInFlight: settledInput?.inputInFlight ?? null,
    deliveryQueuePeak: Math.max(0, ...deliveries.map((record) => record.queuePeak ?? 0)),
    deliveryQueueCapacity: Math.max(0, ...deliveries.map((record) => record.queueCapacity ?? 0)),
    settledDeliveryQueueDepth: Math.max(
      0,
      ...deliveries.map((record) => record.settledQueueDepth ?? 0),
    ),
    revisionLagPeak: Math.max(0, ...deliveries.map((record) => record.revisionLagPeak ?? 0)),
    memorySampleCount: memorySamples.length,
    workloadMemorySampleCount: workloadMemorySamples.length,
    rssWorkloadPeakBytes: Math.max(0, ...workloadMemorySamples.map(({ rssBytes }) => rssBytes)),
    heapWorkloadPeakBytes: Math.max(
      0,
      ...workloadMemorySamples.map(({ heapUsedBytes }) => heapUsedBytes),
    ),
    rssPeakBytes: Math.max(0, ...rss),
    heapPeakBytes: Math.max(0, ...heap),
    // Growth is an ordered quiescent endpoint delta. max-min misclassifies a
    // normal GC cycle (large early heap, smaller later heap) as retained growth.
    // Transient high-water remains visible through the explicit peak fields.
    rssGrowthBytes: rss.length > 0 ? Math.max(0, rss.at(-1) - rss[0]) : null,
    heapGrowthBytes: heap.length > 0 ? Math.max(0, heap.at(-1) - heap[0]) : null,
    rssRobustSlopeBytesPerSample: rss.length >= 4 ? theilSenSlope(rss) : null,
    heapRobustSlopeBytesPerSample: heap.length >= 4 ? theilSenSlope(heap) : null,
    deliverySamples: deliveries.length,
    memorySamples: Object.freeze(memorySamples),
  });
}

function causalInputSummary(samples) {
  const expectedClientOperations = [
    "lane-enqueue",
    "transport-send-start",
    "transport-ack",
    "socket-frame-arrival",
    "delivery-received",
    "lane-published",
    "causal-cell-delivered",
    "causal-cell-painted",
  ];
  const finalized = samples.filter((sample) =>
    sample.clientStages.some((stage) => stage.operation === "causal-cell-painted"),
  );
  const summarizeOffsets = (side, operations) =>
    Object.freeze(
      Object.fromEntries(
        operations.map((operation) => {
          const values = samples.flatMap((sample) => {
            const record = sample[side].find((entry) => entry.operation === operation);
            return Number.isFinite(record?.offsetMs) ? [record.offsetMs] : [];
          });
          return [
            operation,
            Object.freeze({ samples: values.length, p95Ms: percentile(values, 0.95) }),
          ];
        }),
      ),
    );
  const transition = (from, to) => {
    const values = samples.flatMap((sample) => {
      const start = sample.daemonSpans.find((entry) => entry.operation === from);
      const end = sample.daemonSpans.find((entry) => entry.operation === to);
      return Number.isFinite(start?.offsetMs) && Number.isFinite(end?.offsetMs)
        ? [end.offsetMs - start.offsetMs]
        : [];
    });
    return Object.freeze({ samples: values.length, p95Ms: percentile(values, 0.95) });
  };
  return Object.freeze({
    correlation: "causal-cell-v1",
    causalAttribution: finalized.length >= 30 && finalized.length === samples.length,
    finalizedProofs: finalized.length,
    firstBrokenStage:
      samples.length < 30
        ? "input-or-paint-pair"
        : (expectedClientOperations.find((operation) =>
            samples.some(
              (sample) => !sample.clientStages.some((stage) => stage.operation === operation),
            ),
          ) ?? null),
    clientOperationOffsets: summarizeOffsets("clientStages", [
      "lane-enqueue",
      "transport-send-start",
      "transport-ack",
      "socket-frame-arrival",
      "delivery-received",
      "lane-published",
      "render-invalidated",
    ]),
    daemonOperationOffsets: summarizeOffsets("daemonSpans", [
      "raw-input-command",
      "control-write",
      "control-command-accepted",
      "daemon-event-loop-turn",
      "tmux-output-server-age",
      "control-stdout-parse",
      "control-output-to-replica",
      "first-output-observed",
      "terminal-replica-write",
      "terminal-replica-project-commit",
      "terminal-delivery-encode-enqueue",
      "pane-stream-socket-send",
    ]),
    daemonTransitions: Object.freeze({
      controlWriteToFirstOutput: transition("control-write", "first-output-observed"),
      firstOutputToSocketSend: transition("first-output-observed", "pane-stream-socket-send"),
    }),
  });
}

export function buildProductDiagnosticReport({
  state,
  truth,
  lifecycle,
  traceRecords,
  daemonTraceRecords = [],
  stderr,
  warmCoherentSamples = [],
  warmCoherentJourneys = [],
  runtimeResourceRetirements = [],
  windowSwitchSamples = [],
  resizeGuideSamples = [],
  framebufferEvidence = null,
  idleObservation = null,
  resourceObservation = null,
  qualifyingInputEvidence = [],
}) {
  const generation = state?.daemon?.instanceId ?? null;
  const connectionIndex = lifecycle.findLastIndex(
    (entry) =>
      entry?.phase === "generation-connection-resolved" && entry?.daemonGeneration === generation,
  );
  const currentLifecycle = connectionIndex >= 0 ? lifecycle.slice(connectionIndex) : [];
  const shellLive = currentLifecycle.find(
    (entry) =>
      entry?.phase === "generation-shell-lifecycle" &&
      entry?.clientPhase === "live" &&
      entry?.shellStatus === "live",
  );
  const coherent = currentLifecycle.find(
    (entry) => entry?.phase === "generation-runtime-progress" && entry?.runtimePhase === "coherent",
  );
  const generationLive = currentLifecycle.find(
    (entry) =>
      entry?.phase === "generation-status" &&
      entry?.status === "live" &&
      entry?.daemonGeneration === generation,
  );
  const painted = currentLifecycle.find(
    (entry) => entry?.phase === "first-terminal-frame" && entry?.daemonGeneration === generation,
  );
  const activeTraceProcess = traceRecords.findLast(
    (record) => record?.type === "performance.trace.header",
  )?.processId;
  const qualifyingTraceEvidence = new Map(
    qualifyingInputEvidence.map((entry) => [entry.traceId, entry]),
  );
  const qualifies = (sample) =>
    sample.generation === generation &&
    sample.processId === activeTraceProcess &&
    sample.paintStateIdentity === "latest-canonical-state-blitted" &&
    (() => {
      const evidence = qualifyingTraceEvidence.get(sample.traceId);
      return (
        evidence?.paintStateIdentity === "latest-canonical-state-blitted" &&
        evidence.causalAttribution === true &&
        Number.isInteger(evidence.row) &&
        Number.isInteger(evidence.column) &&
        typeof evidence.beforeGrapheme === "string" &&
        typeof evidence.afterGrapheme === "string" &&
        evidence.markerVisibleInNative === true &&
        evidence?.markerVisibleInPaneRect === true &&
        evidence.semanticPaneId === sample.semanticPaneId &&
        evidence.revision === sample.revision &&
        evidence.stateHash === sample.stateHash
      );
    })();
  const inputSamples = inputPaintSamples(traceRecords).filter(qualifies);
  const causalSamples = causalInputSamples(traceRecords, daemonTraceRecords).filter(qualifies);
  const inputCausalSummary = causalInputSummary(causalSamples);
  const outputTransition = inputCausalSummary.daemonTransitions.controlWriteToFirstOutput;
  const firstBrokenInputBoundary = inputCausalSummary.firstBrokenStage;
  const inputDurations = inputSamples.map(({ durationMs }) => durationMs);
  const inputP95 = percentile(inputDurations, 0.95);
  const inputP99 = percentile(inputDurations, 0.99);
  const warmCoherentP95 = percentile(warmCoherentSamples, 0.95);
  const warmLaunchSamples = warmCoherentJourneys
    .map(({ launchToHostMs }) => launchToHostMs)
    .filter(Number.isFinite);
  const warmLaunchP95 = percentile(warmLaunchSamples, 0.95);
  const windowSwitchP95 = percentile(windowSwitchSamples, 0.95);
  const resizeGuideP95 = percentile(resizeGuideSamples, 0.95);
  const traceIntegrity = traceRecords.findLast(
    (record) => record?.type === "performance.trace.summary",
  );
  const traceIntegrityPassed = traceIntegrity
    ? traceIntegrity.acceptedRecords > 0 &&
      traceIntegrity.droppedRecords === 0 &&
      traceIntegrity.oversizedRecords === 0 &&
      traceIntegrity.failed === false &&
      traceIntegrity.saturated === false &&
      traceIntegrity.pendingInputs === 0 &&
      traceIntegrity.droppedInputs === 0
    : null;
  const classify = (id, passed, detail) => ({
    id,
    status: passed === null ? "unmeasured" : passed ? "passed" : "failed",
    detail,
  });
  const boundaries = [
    classify(
      "tmux-truth",
      Boolean(truth?.session) && (truth?.panes?.length ?? 0) > 0,
      `${truth?.panes?.length ?? 0} panes / ${truth?.windows?.length ?? 0} windows`,
    ),
    classify(
      "daemon-generation",
      state?.status === "ready" && typeof generation === "string",
      generation ?? "no live daemon generation",
    ),
    classify(
      "workspace-client-commit",
      Boolean(shellLive),
      shellLive ? `${shellLive.inventoryResources ?? 0} committed resources` : "no live commit",
    ),
    classify(
      "terminal-fast-lane",
      Boolean(coherent && generationLive),
      coherent
        ? `${coherent.seededPanes ?? 0}/${coherent.panes ?? 0} pane seeds coherent`
        : "no coherent generation runtime",
    ),
    classify(
      "tui-painted-frame",
      Boolean(painted && coherent && painted.elapsedMs >= coherent.elapsedMs),
      painted
        ? `coherent ${coherent?.elapsedMs ?? "?"}ms → paint ${painted.elapsedMs}ms`
        : "no generation-fenced changed-cell paint",
    ),
    classify(
      "tui-framebuffer-content",
      framebufferEvidence ? framebufferEvidence.passed === true : null,
      framebufferEvidence?.detail ?? "no per-active-window-pane rectangle proof",
    ),
    classify(
      "web-tui-authority-restart",
      state?.convergence?.restart
        ? state.convergence.restart.webRecovered === true &&
            state.convergence.restart.tuiRecovered === true &&
            state.convergence.restart.hostedTuiInputPainted === true
        : false,
      state?.convergence?.restart
        ? `${state.convergence.restart.elapsedMs}ms full restart journey`
        : "restart journey absent",
    ),
    classify(
      "reference-trace-integrity",
      traceIntegrityPassed,
      traceIntegrity
        ? `${traceIntegrity.acceptedRecords} accepted; ${traceIntegrity.droppedRecords} dropped; ${traceIntegrity.oversizedRecords} oversized; failed ${traceIntegrity.failed}; pending inputs ${traceIntegrity.pendingInputs}; dropped inputs ${traceIntegrity.droppedInputs}`
        : "no closed reference trace summary",
    ),
    classify(
      "input-enqueue-to-correlated-changed-cell-paint",
      inputSamples.length < 30
        ? null
        : inputCausalSummary.causalAttribution && inputP95 <= 16.67 && inputP99 <= 33,
      `${inputSamples.length}/30 renderer-correlated samples; p95 ${inputP95 ?? "?"}ms; p99 ${inputP99 ?? "?"}ms; causal attribution ${inputCausalSummary.causalAttribution}${firstBrokenInputBoundary ? `; first broken ${firstBrokenInputBoundary}` : ""}${outputTransition.samples > 0 ? `; output transition p95 ${outputTransition.p95Ms}ms` : ""}`,
    ),
    classify(
      "resize-guide-preview",
      resizeGuideSamples.length < 20 ? null : resizeGuideP95 <= 16.67,
      `${resizeGuideSamples.length}/20 samples; p95 ${resizeGuideP95 ?? "?"}ms`,
    ),
    classify(
      "warm-window-switch",
      windowSwitchSamples.length < 30 ? null : windowSwitchP95 <= 150,
      `${windowSwitchSamples.length}/30 samples; p95 ${windowSwitchP95 ?? "?"}ms`,
    ),
    classify(
      "warm-coherent-terminal-frame",
      warmCoherentSamples.length < WARM_COHERENT_SAMPLE_COUNT ? null : warmCoherentP95 <= 750,
      `${warmCoherentSamples.length}/${WARM_COHERENT_SAMPLE_COUNT} connection→host-publication samples; p95 ${warmCoherentP95 ?? "?"}ms`,
    ),
    classify(
      "warm-process-launch-to-host-publication",
      warmLaunchSamples.length < WARM_COHERENT_SAMPLE_COUNT ? null : warmLaunchP95 <= 750,
      `${warmLaunchSamples.length}/${WARM_COHERENT_SAMPLE_COUNT} fresh-process launch→host-publication samples; p95 ${warmLaunchP95 ?? "?"}ms`,
    ),
    classify(
      "runtime-resource-retirement",
      runtimeResourceRetirements.length < WARM_COHERENT_SAMPLE_COUNT
        ? null
        : runtimeResourceRetirements.every(({ passed }) => passed === true),
      `${runtimeResourceRetirements.filter(({ passed }) => passed === true).length}/${WARM_COHERENT_SAMPLE_COUNT} rehosts returned sockets/listeners/supervisors/subscriptions/runtime timers to zero; in-close snapshots permit only the one instrumented enclosing shutdown deadline`,
    ),
    classify(
      "idle-frame-work",
      idleObservation
        ? idleObservation.durationMs >= 10_000 &&
            idleObservation.frameCount === 0 &&
            idleObservation.terminalPaints === 0 &&
            idleObservation.zeroDirtyPaints === 0 &&
            idleObservation.framebufferStable === true
        : null,
      idleObservation
        ? `${idleObservation.durationMs}ms idle; ${idleObservation.frameCount} renderer frames; ${idleObservation.terminalPaints} terminal paints; framebuffer stable ${idleObservation.framebufferStable}`
        : "no renderer dirty-frame/idle-window sample",
    ),
    classify(
      "bounded-queues-memory",
      resourceObservation
        ? resourceObservation.deliverySamples > 0 &&
            resourceObservation.memorySampleCount >= MEMORY_BUDGET.minimumSamples &&
            resourceObservation.rssPeakBytes > 0 &&
            resourceObservation.heapPeakBytes > 0 &&
            resourceObservation.rssRobustSlopeBytesPerSample <=
              MEMORY_BUDGET.rssRobustSlopeBytesPerSample &&
            resourceObservation.heapRobustSlopeBytesPerSample <=
              MEMORY_BUDGET.heapRobustSlopeBytesPerSample &&
            resourceObservation.rssGrowthBytes <= MEMORY_BUDGET.rssGrowthCeilingBytes &&
            resourceObservation.heapGrowthBytes <= MEMORY_BUDGET.heapGrowthCeilingBytes &&
            resourceObservation.rssPeakBytes <= MEMORY_BUDGET.rssAbsoluteCeilingBytes &&
            resourceObservation.heapPeakBytes <= MEMORY_BUDGET.heapAbsoluteCeilingBytes &&
            resourceObservation.inputPendingPeak <= 256 &&
            resourceObservation.inputPendingBytesPeak <= 256 * 1_024 &&
            resourceObservation.inputInFlightPeak <= 8 &&
            resourceObservation.deliveryQueuePeak <= resourceObservation.deliveryQueueCapacity &&
            resourceObservation.settledInputPending === MEMORY_BUDGET.settledQueueDepth &&
            resourceObservation.settledInputInFlight === MEMORY_BUDGET.settledQueueDepth &&
            resourceObservation.settledDeliveryQueueDepth === MEMORY_BUDGET.settledQueueDepth
        : null,
      resourceObservation
        ? `${resourceObservation.memorySampleCount}/${MEMORY_BUDGET.minimumSamples} memory samples; input peak ${resourceObservation.inputPendingPeak}/${resourceObservation.inputPendingBytesPeak}B settled ${resourceObservation.settledInputPending}/${resourceObservation.settledInputInFlight}; delivery peak ${resourceObservation.deliveryQueuePeak}/${resourceObservation.deliveryQueueCapacity} settled ${resourceObservation.settledDeliveryQueueDepth}; RSS growth/slope ${resourceObservation.rssGrowthBytes}/${resourceObservation.rssRobustSlopeBytesPerSample}B; heap growth/slope ${resourceObservation.heapGrowthBytes}/${resourceObservation.heapRobustSlopeBytesPerSample}B`
        : "no sustained-output queue/memory distribution",
    ),
  ];
  return Object.freeze({
    version: 1,
    status: boundaries.some(({ status }) => status === "failed")
      ? "failed"
      : boundaries.some(({ status }) => status === "unmeasured")
        ? "incomplete"
        : "passed",
    firstBrokenBoundary: boundaries.find(({ status }) => status === "failed")?.id ?? null,
    firstBrokenInputBoundary,
    firstUnmeasuredBoundary: boundaries.find(({ status }) => status === "unmeasured")?.id ?? null,
    generation,
    boundaries: Object.freeze(boundaries),
    clocks: Object.freeze([
      ...new Set(
        lifecycle.map(({ processId, clockId }) => `${processId ?? "?"}:${clockId ?? "?"}`),
      ),
    ]),
    inputSamples: Object.freeze(inputSamples),
    qualifyingInputEvidence: Object.freeze(
      qualifyingInputEvidence.map((entry) => Object.freeze({ ...entry })),
    ),
    inputCausalSamples: Object.freeze(causalSamples),
    inputCausalSummary,
    framebufferEvidence:
      framebufferEvidence === null ? null : Object.freeze({ ...framebufferEvidence }),
    warmCoherentSamples: Object.freeze([...warmCoherentSamples]),
    warmLaunchSamples: Object.freeze([...warmLaunchSamples]),
    warmCoherentJourneys: Object.freeze(
      warmCoherentJourneys.map((journey) =>
        Object.freeze({
          ...journey,
          daemonSpans: (() => {
            const matching = daemonTraceRecords.filter(
              (record) => journey.streamRequestId && record?.traceId === journey.streamRequestId,
            );
            const origin = Math.min(
              ...matching
                .map((record) => record.startedAtMicros)
                .filter((value) => Number.isFinite(value)),
            );
            return Object.freeze(
              matching.map((record) =>
                Object.freeze({
                  operation: record.operation,
                  offsetMs:
                    Number.isFinite(origin) && Number.isFinite(record.startedAtMicros)
                      ? (record.startedAtMicros - origin) / 1_000
                      : null,
                  durationMs:
                    Number.isFinite(record.startedAtMicros) && Number.isFinite(record.endedAtMicros)
                      ? (record.endedAtMicros - record.startedAtMicros) / 1_000
                      : null,
                  processId: record.processId,
                  clockId: record.clockId,
                }),
              ),
            );
          })(),
        }),
      ),
    ),
    runtimeResourceRetirements: Object.freeze(
      runtimeResourceRetirements.map((retirement) => Object.freeze({ ...retirement })),
    ),
    windowSwitchSamples: Object.freeze([...windowSwitchSamples]),
    resizeGuideSamples: Object.freeze([...resizeGuideSamples]),
    idleObservation: idleObservation ? Object.freeze({ ...idleObservation }) : null,
    resourceObservation: resourceObservation ? Object.freeze({ ...resourceObservation }) : null,
    stderr: Object.freeze({
      nonEmptyLines: String(stderr ?? "")
        .split("\n")
        .filter(Boolean).length,
      tail: String(stderr ?? "")
        .split("\n")
        .filter(Boolean)
        .slice(-20),
    }),
  });
}
