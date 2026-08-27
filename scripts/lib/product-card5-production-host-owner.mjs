import { isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

import { card5ProductionHostTopology } from "./product-card5-host-topology.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const DAEMON_INSTANCE_ID_PATTERN =
  "(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)";
const DAEMON_INSTANCE_ID = new RegExp(`^${DAEMON_INSTANCE_ID_PATTERN}$`, "iu");
const TERMINAL_ATTACHMENT_PANE_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const TERMINAL_ATTACHMENT_PANE_ID_RESERVED = Object.freeze([
  "__proto__",
  "prototype",
  "constructor",
]);
const TERMINAL_ATTACHMENT_PANE_ID_DISCOVERED_PREFIX = "terminal.discovered.";
const exactDaemonInstanceId = (value) =>
  typeof value === "string" && value.length === 36 && DAEMON_INSTANCE_ID.test(value);
const CARD5_PROBE_QUERY = "tmuxIdeCard5Evidence";
const CARD5_ACTIVE_TERMINAL_PANEL = "#workspace-panel-terminals:not([hidden])";
const CARD5_MAX_READINESS_CANDIDATES = 64;
const CARD5_MAX_PAGE_EVENTS = 16;
const CARD5_READINESS_OBSERVATION_TIMEOUT_MS = 1_000;
const CARD5_INPUT_PRODUCT_PATH_RESERVE_MS = 4_000;
const CARD5_INPUT_PREFLIGHT_MARGIN_MS = 250;
const CLOSE_GRACE_MS = 2_000;
const CLOSE_TERM_MS = 500;
const qualifiedTerminalIdentities = new WeakMap();

const boundedInputGuardCount = (value, cap) =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : null;

export function boundedCard5InputGuardAxes(
  outcome,
  { deadlineValid = false, settled = false } = {},
) {
  const beforeInputCount = boundedInputGuardCount(outcome?.beforeInputCount, 8);
  const inputCount = boundedInputGuardCount(outcome?.inputCount, 8);
  const eventCount = boundedInputGuardCount(outcome?.eventCount, 16);
  const mutationCount = boundedInputGuardCount(outcome?.mutationCount, 64);
  const exactBoolean = (value) => (typeof value === "boolean" ? value : null);
  return Object.freeze({
    beforeInputCount,
    beforeInputCountOverflow:
      Number.isSafeInteger(outcome?.beforeInputCount) && outcome.beforeInputCount > 8,
    inputCount,
    inputCountOverflow: Number.isSafeInteger(outcome?.inputCount) && outcome.inputCount > 8,
    eventCount,
    eventCountOverflow: Number.isSafeInteger(outcome?.eventCount) && outcome.eventCount > 16,
    eventOverflow: exactBoolean(outcome?.eventOverflow),
    mutationCount,
    mutationCountOverflow:
      Number.isSafeInteger(outcome?.mutationCount) && outcome.mutationCount > 64,
    mutationOverflow: exactBoolean(outcome?.mutationOverflow),
    trusted: exactBoolean(outcome?.trusted),
    exactTarget: exactBoolean(outcome?.exactTarget),
    exactData: exactBoolean(outcome?.exactData),
    exactInputType: exactBoolean(outcome?.exactInputType),
    cancelableBeforeInput: exactBoolean(outcome?.cancelableBeforeInput),
    restorationExact: exactBoolean(outcome?.restorationExact),
    rejected: exactBoolean(outcome?.rejected),
    currentExact: exactBoolean(outcome?.exact),
    deadlineValid: deadlineValid === true,
    settled: settled === true,
  });
}

export function card5InputGuardFailureReason(axes) {
  if (axes?.inputCount !== 1) return "input-count-invalid";
  if (axes.beforeInputCount !== 1) return "beforeinput-count-invalid";
  if (axes.eventCount !== axes.inputCount + axes.beforeInputCount) return "event-count-invalid";
  if (axes.eventOverflow !== false) return "event-overflow";
  if (axes.mutationCount !== 0) return "mutation-count-invalid";
  if (axes.mutationOverflow !== false) return "mutation-overflow";
  if (axes.trusted !== true) return "event-untrusted";
  if (axes.exactTarget !== true) return "event-target-invalid";
  if (axes.exactData !== true) return "event-data-invalid";
  if (axes.exactInputType !== true) return "event-input-type-invalid";
  if (axes.cancelableBeforeInput !== true) return "beforeinput-not-cancelable";
  if (axes.restorationExact !== true) return "restoration-invalid";
  if (axes.rejected !== false) return "guard-rejected";
  if (axes.currentExact !== true) return "guard-current-invalid";
  return null;
}

export function boundedCard5PointerDispatchAxes(outcome) {
  const count = (value, cap) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : null;
  const bool = (value) => (typeof value === "boolean" ? value : null);
  const mutationCategories = outcome?.mutationCategories ?? {};
  return Object.freeze({
    dispatched: bool(outcome?.dispatched),
    trusted: bool(outcome?.trusted),
    buttonExact: bool(outcome?.buttonExact),
    pathExact: bool(outcome?.pathExact),
    allowed: bool(outcome?.allowed),
    rejected: bool(outcome?.rejected),
    eventCount: count(outcome?.eventCount, 8),
    eventOverflow: bool(outcome?.eventOverflow),
    mutationCount: count(outcome?.mutationCount, 64),
    mutationOverflow: bool(outcome?.mutationOverflow),
    mutationCategories: Object.freeze({
      identityNode: count(mutationCategories.identityNode, 64),
      areaDescendant: count(mutationCategories.areaDescendant, 64),
      terminalAttribute: count(mutationCategories.terminalAttribute, 64),
      paneAttribute: count(mutationCategories.paneAttribute, 64),
      childList: count(mutationCategories.childList, 64),
      inspectionOverflow: count(mutationCategories.inspectionOverflow, 64),
    }),
    mutationTail: Object.freeze(
      Array.isArray(outcome?.mutationTail)
        ? outcome.mutationTail.slice(-2).map((entry) =>
            Object.freeze({
              type: ["attributes", "childList"].includes(entry?.type) ? entry.type : "invalid",
              attribute:
                typeof entry?.attribute === "string" && entry.attribute.length <= 32
                  ? entry.attribute
                  : null,
              relevanceHmac: HASH.test(entry?.relevanceHmac ?? "") ? entry.relevanceHmac : null,
            }),
          )
        : [],
    ),
    current: Object.freeze({
      areaConnected: bool(outcome?.current?.areaConnected),
      surfaceConnected: bool(outcome?.current?.surfaceConnected),
      targetConnected: bool(outcome?.current?.targetConnected),
      surfaceAreaExact: bool(outcome?.current?.surfaceAreaExact),
      targetAreaExact: bool(outcome?.current?.targetAreaExact),
      surfaceCardinalityExact: bool(outcome?.current?.surfaceCardinalityExact),
      compositorExact: bool(outcome?.current?.compositorExact),
      topologyExact: bool(outcome?.current?.topologyExact),
    }),
  });
}

export function card5PointerDispatchFailureReason(axes) {
  if (axes?.dispatched !== true) return "pointer-not-dispatched";
  if (axes.trusted !== true) return "pointer-untrusted";
  if (axes.buttonExact !== true) return "pointer-button-invalid";
  if (axes.pathExact !== true) return "pointer-path-invalid";
  if (axes.eventOverflow !== false) return "pointer-event-overflow";
  if (axes.mutationOverflow !== false) return "pointer-mutation-overflow";
  if (axes.mutationCount !== 0) return "pointer-mutation-detected";
  for (const [field, reason] of [
    ["areaConnected", "pointer-area-disconnected"],
    ["surfaceConnected", "pointer-surface-disconnected"],
    ["targetConnected", "pointer-target-disconnected"],
    ["surfaceAreaExact", "pointer-surface-area-changed"],
    ["targetAreaExact", "pointer-target-area-changed"],
    ["surfaceCardinalityExact", "pointer-surface-cardinality-changed"],
    ["compositorExact", "pointer-compositor-changed"],
    ["topologyExact", "pointer-topology-changed"],
  ])
    if (axes.current?.[field] !== true) return reason;
  if (axes.allowed !== true) return "pointer-not-allowed";
  if (axes.rejected !== false) return "pointer-rejected";
  return null;
}

export function boundedCard5InputReceiptAxes(outcome, keyHex = null) {
  const boundedCount = (value, cap = 8) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : null;
  const exactBoolean = (value) => (typeof value === "boolean" ? value : null);
  return Object.freeze({
    status: [
      "pending",
      "accepted",
      "input-receipt-invalid",
      "input-receipt-timeout",
      "input-authority-unobserved-timeout",
      "input-authority-rejected",
      "input-authority-timeout",
      "input-authority-unavailable",
      "input-authority-foreign",
      "input-ack-timeout",
    ].includes(outcome?.status)
      ? outcome.status
      : "invalid",
    baselineCount: boundedCount(outcome?.baselineCount),
    currentCount: boundedCount(outcome?.currentCount),
    candidateCount: boundedCount(outcome?.candidateCount),
    countRegressed: exactBoolean(outcome?.countRegressed),
    countAdvanced: exactBoolean(outcome?.countAdvanced),
    surfaceExact: exactBoolean(outcome?.surfaceExact),
    textareaExact: exactBoolean(outcome?.textareaExact),
    focusExact: exactBoolean(outcome?.focusExact),
    bindingExact: exactBoolean(outcome?.bindingExact),
    generationExact: exactBoolean(outcome?.generationExact),
    sessionExact: exactBoolean(outcome?.sessionExact),
    workspaceExact: exactBoolean(outcome?.workspaceExact),
    paneExact: exactBoolean(outcome?.paneExact),
    clientExact: exactBoolean(outcome?.clientExact),
    requestExact: exactBoolean(outcome?.requestExact),
    epochExact: exactBoolean(outcome?.epochExact),
    clientGenerationExact: exactBoolean(outcome?.clientGenerationExact),
    targetExact: exactBoolean(outcome?.targetExact),
    mutationCount: boundedCount(outcome?.mutationCount, 32),
    mutationOverflow: exactBoolean(outcome?.mutationOverflow),
    authorityState: ["null", "expected", "foreign", "invalid"].includes(outcome?.authorityState)
      ? outcome.authorityState
      : "invalid",
    timerCleared: exactBoolean(outcome?.timerCleared),
    settled: exactBoolean(outcome?.settled),
    operationCount: boundedCount(outcome?.operationCount, 64),
    operationOverflow: exactBoolean(outcome?.operationOverflow),
    operationTail: Object.freeze(
      Array.isArray(outcome?.operationTail)
        ? outcome.operationTail.slice(-2).map((event) =>
            Object.freeze({
              ordinal: boundedCount(event?.ordinal, 0xffff_ffff),
              stage: [
                "xterm-enqueue",
                "surface-write",
                "authority-request",
                "authority-result",
                "input-send",
                "input-ack",
                "receipt-published",
              ].includes(event?.stage)
                ? event.stage
                : "invalid",
              outcome: [
                "attempt",
                "ok",
                "sent",
                "send-failed",
                "granted",
                "rejected",
                "authority-timeout",
                "ack-timeout",
                "closed",
                "unavailable",
                "failed",
              ].includes(event?.outcome)
                ? event.outcome
                : "invalid",
              identityHmac:
                typeof keyHex === "string" && /^[0-9a-f]{64}$/u.test(keyHex)
                  ? createHmac("sha256", Buffer.from(keyHex, "hex"))
                      .update(
                        `input-operation\0${event?.generation ?? ""}\0${event?.lifecycleRequestId ?? ""}\0${event?.authorityRequestId ?? ""}\0${event?.clientId ?? ""}\0${event?.pane ?? ""}\0${event?.seq ?? ""}`,
                      )
                      .digest("hex")
                  : null,
            }),
          )
        : [],
    ),
  });
}

export function boundedCard5InputReceiptStartAxes(result) {
  const bool = (value) => (typeof value === "boolean" ? value : null);
  const boundedMilliseconds = (value) =>
    Number.isFinite(value) && value >= 0 ? Math.min(10_000, Math.floor(value)) : null;
  const initial = result?.initial ?? {};
  return Object.freeze({
    status: [
      "started",
      "initial-invalid",
      "already-started",
      "deadline-invalid",
      "reserve-insufficient",
    ].includes(result?.status)
      ? result.status
      : "invalid",
    settledStatus:
      typeof result?.settledStatus === "string" && result.settledStatus.length <= 32
        ? result.settledStatus
        : "invalid",
    fixedDeadlineInstalled: bool(result?.fixedDeadlineInstalled),
    fixedDeadlineFinite: bool(result?.fixedDeadlineFinite),
    browserRemainingMs: boundedMilliseconds(result?.browserRemainingMs),
    reserveMs: boundedMilliseconds(result?.reserveMs),
    dispatchFresh: bool(result?.dispatchFresh),
    initial: Object.freeze({
      surfaceExact: bool(initial.surfaceExact),
      textareaExact: bool(initial.textareaExact),
      focusExact: bool(initial.focusExact),
      bindingEpochExact: bool(initial.bindingEpochExact),
      bindingGenerationExact: bool(initial.bindingGenerationExact),
      bindingSessionExact: bool(initial.bindingSessionExact),
      bindingWorkspaceExact: bool(initial.bindingWorkspaceExact),
      bindingPaneExact: bool(initial.bindingPaneExact),
      bindingPaneSetHmacExact: bool(initial.bindingPaneSetHmacExact),
      bindingStageExact: bool(initial.bindingStageExact),
      bindingClientExact: bool(initial.bindingClientExact),
      bindingRequestExact: bool(initial.bindingRequestExact),
      authorityGenerationExact: bool(initial.authorityGenerationExact),
      authoritySessionExact: bool(initial.authoritySessionExact),
      clientGenerationExact: bool(initial.clientGenerationExact),
      targetExact: bool(initial.targetExact),
      baselineCountSafe: bool(initial.baselineCountSafe),
      currentCountSafe: bool(initial.currentCountSafe),
      currentCountExact: bool(initial.currentCountExact),
      operationBoundarySafe: bool(initial.operationBoundarySafe),
    }),
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function descendantPids(rootPid) {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter(([pid, ppid]) => Number.isSafeInteger(pid) && Number.isSafeInteger(ppid));
  const found = new Set();
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const parents = new Set(frontier);
    frontier = rows
      .filter(([pid, ppid]) => parents.has(ppid) && !found.has(pid))
      .map(([pid]) => pid);
    for (const pid of frontier) found.add(pid);
  }
  return [...found];
}

function processRows() {
  try {
    return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) =>
        /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/u.exec(
          line.trim(),
        ),
      )
      .filter(Boolean)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        state: match[4],
        startToken: match[5],
        command: match[6],
      }));
  } catch {
    return [];
  }
}

function lsofCount(args, predicate = () => true) {
  try {
    return execFileSync("lsof", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .slice(1)
      .filter((line) => line && predicate(line)).length;
  } catch (error) {
    return error?.status === 1 ? 0 : null;
  }
}

function abortError() {
  const error = new Error("Card5 production host launch was aborted");
  error.name = "AbortError";
  return error;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(abortError());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        rejectPromise(error);
      },
    );
  });
}

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Card5 host close deadline expired")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function exactOwnedFile(path, root, label) {
  if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
  const exact = resolve(path);
  const base = resolve(root);
  if (exact !== base && !exact.startsWith(`${base}/`)) {
    throw new TypeError(`${label} must be ProductRig-owned`);
  }
  return exact;
}

async function preparePage(page, pageUrl, signal, evidenceKey) {
  await page.addInitScript(() => {
    globalThis.__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__ = true;
    globalThis.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
  });
  await abortable(page.goto(pageUrl, { waitUntil: "domcontentloaded" }), signal);
  await abortable(
    page.locator(".app[data-shell-source='runtime']").waitFor({ timeout: 60_000 }),
    signal,
  );
  await abortable(waitForQualifiedTerminal(page), signal);
  await qualifiedTerminalIdentity(page, evidenceKey);
}

function installReadinessPageEvents(page) {
  const counts = { pageError: 0, close: 0, crash: 0 };
  const events = [];
  const record = (kind) => {
    counts[kind] = Math.min(0xffff, counts[kind] + 1);
    if (events.length < CARD5_MAX_PAGE_EVENTS) events.push(kind);
  };
  page.on?.("pageerror", () => record("pageError"));
  page.on?.("close", () => record("close"));
  page.on?.("crash", () => record("crash"));
  return () =>
    Object.freeze({
      pageErrorCount: counts.pageError,
      closeCount: counts.close,
      crashCount: counts.crash,
      events: Object.freeze([...events]),
      eventOverflow: Math.min(
        0xffff,
        Math.max(0, counts.pageError + counts.close + counts.crash - events.length),
      ),
    });
}

async function waitForQualifiedTerminal(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.()),
    undefined,
    { timeout: 60_000 },
  );
}

async function qualifiedTerminalIdentity(page, evidenceKey) {
  if (!HASH.test(evidenceKey ?? "")) throw new TypeError("Card5 evidence key is malformed");
  const surfaceHandle = await page.evaluateHandle(
    () => globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.() ?? null,
  );
  const identity = await page.evaluate(
    async ({ exactKey, exactSurface }) => {
      const surface = globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.() ?? null;
      if (!surface || surface !== exactSurface) return null;
      const bytes = Uint8Array.from(
        exactKey.match(/../gu).map((pair) => Number.parseInt(pair, 16)),
      );
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const hmac = async (domain, value) => {
        if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
        const signed = await globalThis.crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${domain}\0${value}`),
        );
        return [...new Uint8Array(signed)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      };
      return {
        workspaceHmac: await hmac("workspace", surface.getAttribute("data-workspace-name")),
        paneHmac: await hmac("pane", surface.getAttribute("data-semantic-pane-id")),
      };
    },
    { exactKey: evidenceKey, exactSurface: surfaceHandle },
  );
  if (!HASH.test(identity?.workspaceHmac ?? "") || !HASH.test(identity?.paneHmac ?? "")) {
    await surfaceHandle.dispose();
    throw new Error("Card5 qualified terminal identity was unavailable");
  }
  const prior = qualifiedTerminalIdentities.get(page);
  await prior?.surfaceHandle.dispose();
  const authority = Object.freeze({ ...identity, surfaceHandle });
  qualifiedTerminalIdentities.set(page, authority);
  const retire = () => {
    if (qualifiedTerminalIdentities.get(page) !== authority) return;
    qualifiedTerminalIdentities.delete(page);
    void surfaceHandle.dispose().catch(() => undefined);
  };
  page.on?.("close", retire);
  page.on?.("crash", retire);
  page.on?.("framenavigated", (frame) => {
    if (typeof page.mainFrame !== "function" || frame === page.mainFrame()) retire();
  });
  return authority;
}

async function waitForElectronReadyTerminal(page, signal, evidenceKey) {
  await abortable(waitForQualifiedTerminal(page), signal);
  await qualifiedTerminalIdentity(page, evidenceKey);
}

async function observeHostReadiness(page, evidenceKey, pageEvents) {
  if (!HASH.test(evidenceKey ?? "")) throw new TypeError("Card5 evidence key is malformed");
  const observation = await page.evaluate(
    async ({
      evidenceKey: exactKey,
      panelSelector,
      maxCandidates,
      maxSocketEvents,
      maxLifecycleEvents,
    }) => {
      const boundedInteger = (value, ceiling = 0xffff) => {
        if (typeof value !== "string" || !/^\d{1,10}$/u.test(value)) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, ceiling) : null;
      };
      const boundedDimension = (value) =>
        Number.isFinite(value) && value >= 0 ? Math.min(0xffff, Math.round(value)) : null;
      const exactDimension = (value) =>
        /^[1-9]\d{0,4}x[1-9]\d{0,4}$/u.test(value ?? "") ? value : null;
      const phase = (value) =>
        ["unavailable", "measuring", "connecting", "connected", "disconnected", "error"].includes(
          value,
        )
          ? value
          : "unknown";
      const attachPhase = (value) =>
        [
          "unavailable",
          "renderer-loading",
          "renderer-ready",
          "waiting-for-viewport",
          "attach-requested",
          "transport-ready",
          "attachment-ready",
          "awaiting-first-output",
          "first-output-received",
          "painting-first-frame",
          "live",
          "disconnected",
          "failed",
        ].includes(value)
          ? value
          : "unknown";
      const failureCode = (value) =>
        [
          "none",
          "geometry-authority-conflict",
          "resize-rejected",
          "resize-exception",
          "attach-failed",
          "input-failed",
          "renderer-failed",
          "output-failed",
        ].includes(value)
          ? value
          : "unknown";
      const resizeOutcome = (value) =>
        [
          "none",
          "geometry-authority-conflict",
          "authority-timeout",
          "viewport-timeout",
          "stream-closed",
          "lifecycle-retired",
          "failed",
        ].includes(value)
          ? value
          : "unknown";
      const reason = (surfacePhase, surfaceAttachPhase, preservesFrame) => {
        if (surfacePhase === "connected") return preservesFrame ? "none" : "frame-unavailable";
        if (surfacePhase === "unavailable") return "transport-unavailable";
        if (surfacePhase === "measuring")
          return surfaceAttachPhase === "waiting-for-viewport"
            ? "viewport-unavailable"
            : "renderer-pending";
        if (surfacePhase === "connecting")
          return surfaceAttachPhase === "transport-ready"
            ? "attachment-handle-pending"
            : "transport-pending";
        if (surfacePhase === "disconnected") return "transport-disconnected";
        if (surfacePhase === "error") return "terminal-failed";
        return "unknown";
      };
      const bytes = Uint8Array.from(
        exactKey.match(/../gu).map((pair) => Number.parseInt(pair, 16)),
      );
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const hmac = async (domain, value) => {
        if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
        const signed = await globalThis.crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${domain}\0${value}`),
        );
        return [...new Uint8Array(signed)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      };
      const panel = globalThis.document.querySelector(panelSelector);
      const surfaces = panel ? [...panel.querySelectorAll(".terminal-surface")] : [];
      const qualifiedSurface = globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.() ?? null;
      const candidates = await Promise.all(
        surfaces.slice(0, maxCandidates).map(async (surface) => {
          const style = globalThis.getComputedStyle(surface);
          const rect = surface.getBoundingClientRect();
          const surfacePhase = phase(surface.getAttribute("data-phase"));
          const surfaceAttachPhase = attachPhase(surface.getAttribute("data-attach-phase"));
          const preservesFrame = surface.getAttribute("data-preserves-frame") === "true";
          const visible =
            globalThis.document.visibilityState === "visible" &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            rect.width > 0 &&
            rect.height > 0 &&
            surface.getClientRects().length > 0;
          return {
            phase: surfacePhase,
            attachPhase: surfaceAttachPhase,
            failureCode: failureCode(surface.getAttribute("data-attach-failure-code")),
            resizeOutcome: resizeOutcome(surface.getAttribute("data-resize-outcome")),
            resizeOrdinal: boundedInteger(surface.getAttribute("data-resize-ordinal")),
            attempt: boundedInteger(surface.getAttribute("data-attach-attempt")),
            reason: reason(surfacePhase, surfaceAttachPhase, preservesFrame),
            qualified: surface === qualifiedSurface,
            visible,
            bbox: Object.freeze({
              width: boundedDimension(rect.width),
              height: boundedDimension(rect.height),
            }),
            hasXterm: surface.querySelector(".xterm") !== null,
            preservesFrame,
            sourceDimensions: exactDimension(surface.getAttribute("data-source-grid")),
            clientDimensions: exactDimension(surface.getAttribute("data-client-viewport")),
            workspaceHmac: await hmac("workspace", surface.getAttribute("data-workspace-name")),
            paneHmac: await hmac("pane", surface.getAttribute("data-semantic-pane-id")),
          };
        }),
      );
      const app = globalThis.document.querySelector(".app");
      const workspaceEvidence =
        typeof globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ === "function"
          ? globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__()
          : null;
      const clientPhase = workspaceEvidence?.snapshot?.phase;
      const envelopeEvidence =
        typeof globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ === "function"
          ? globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__()
          : null;
      const boundedCount = (value, ceiling = 0xffff) =>
        Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ceiling) : null;
      const socketEvents = Array.isArray(envelopeEvidence?.socketEvents)
        ? envelopeEvidence.socketEvents.slice(-maxSocketEvents)
        : [];
      const socketOutcomes = await Promise.all(
        socketEvents.map(async (event) => ({
          outcome: ["open", "closed", "failed"].includes(event?.outcome)
            ? event.outcome
            : "unknown",
          ordinal: boundedCount(event?.ordinal, 0xffff_ffff),
          generationHmac: await hmac("generation", event?.generation),
        })),
      );
      const socketEventCount = boundedCount(envelopeEvidence?.socketEventCount, 0xffff_ffff);
      const lifecycleEvents = Array.isArray(envelopeEvidence?.lifecycleEvents)
        ? envelopeEvidence.lifecycleEvents.slice(-maxLifecycleEvents)
        : [];
      const lifecycle = await Promise.all(
        lifecycleEvents.map(async (event) => ({
          stage: [
            "issued",
            "socket-open",
            "server-ready",
            "layout-validated",
            "delivery-open",
            "first-seed",
            "terminal",
          ].includes(event?.stage)
            ? event.stage
            : "unknown",
          code:
            typeof event?.code === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(event.code)
              ? event.code
              : "unknown",
          origin: ["client", "peer", "dispose", "unknown"].includes(event?.origin)
            ? event.origin
            : "unknown",
          closeCode:
            Number.isSafeInteger(event?.closeCode) &&
            event.closeCode >= 1000 &&
            event.closeCode <= 4999
              ? event.closeCode
              : null,
          closeReason:
            typeof event?.closeReason === "string" &&
            /^[a-z][a-z0-9-]{0,63}$/u.test(event.closeReason)
              ? event.closeReason
              : "unknown",
          ordinal: boundedCount(event?.ordinal, 0xffff_ffff),
          generationHmac: await hmac("generation", event?.generation),
          requestHmac: await hmac("request", event?.requestId),
        })),
      );
      const lifecycleEventCount = boundedCount(envelopeEvidence?.lifecycleEventCount, 0xffff_ffff);
      const descriptorEventCount = boundedCount(
        envelopeEvidence?.descriptorEventCount,
        0xffff_ffff,
      );
      const replacementCount = boundedCount(envelopeEvidence?.replacementCount, 0xffff);
      const predecessorAcceptedAfterReplacement = boundedCount(
        envelopeEvidence?.predecessorAcceptedAfterReplacement,
        0xffff,
      );
      const reconnectOutcome =
        predecessorAcceptedAfterReplacement === null || replacementCount === null
          ? "unknown"
          : predecessorAcceptedAfterReplacement > 0
            ? "replacement-violation"
            : replacementCount > 0
              ? "replacement-observed"
              : descriptorEventCount !== null &&
                  descriptorEventCount > 0 &&
                  socketOutcomes.length === 0
                ? "issued-without-socket"
                : "none";
      return {
        probeInstalled: typeof globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ === "function",
        candidateCount: Math.min(surfaces.length, 0xffff),
        candidateOverflow: Math.min(0xffff, Math.max(0, surfaces.length - candidates.length)),
        candidates,
        documentVisibility:
          globalThis.document.visibilityState === "visible" ? "visible" : "hidden",
        activePanelPresent: panel !== null,
        shellPresent: app?.getAttribute("data-shell-source") === "runtime",
        bootstrapPhase: app?.getAttribute("data-daemon-generation") ? "connected" : "pending",
        clientPhase: [
          "loading",
          "live",
          "stale",
          "degraded",
          "unavailable",
          "error",
          "disposed",
        ].includes(clientPhase)
          ? clientPhase
          : "unknown",
        transport: Object.freeze({
          descriptorEventCount,
          socketEventCount,
          socketEventOverflow:
            socketEventCount === null
              ? null
              : Math.max(0, socketEventCount - socketOutcomes.length),
          socketOutcomes,
          lifecycleEventCount,
          lifecycleEventOverflow:
            lifecycleEventCount === null
              ? null
              : Math.max(0, lifecycleEventCount - lifecycle.length),
          lifecycle,
          replacementCount,
          predecessorAcceptedAfterReplacement,
          reconnectOutcome,
        }),
      };
    },
    {
      evidenceKey,
      panelSelector: CARD5_ACTIVE_TERMINAL_PANEL,
      maxCandidates: CARD5_MAX_READINESS_CANDIDATES,
      maxSocketEvents: CARD5_MAX_PAGE_EVENTS,
      maxLifecycleEvents: 64,
    },
  );
  return Object.freeze({ ...observation, pageEvents: pageEvents() });
}

function unavailableReadinessObservation(readReason, pageEvents) {
  return Object.freeze({
    readReason,
    probeInstalled: null,
    candidateCount: null,
    candidateOverflow: null,
    candidates: Object.freeze([]),
    documentVisibility: "unknown",
    activePanelPresent: null,
    shellPresent: null,
    bootstrapPhase: "unknown",
    clientPhase: "unknown",
    transport: Object.freeze({
      descriptorEventCount: null,
      socketEventCount: null,
      socketEventOverflow: null,
      socketOutcomes: Object.freeze([]),
      lifecycleEventCount: null,
      lifecycleEventOverflow: null,
      lifecycle: Object.freeze([]),
      replacementCount: null,
      predecessorAcceptedAfterReplacement: null,
      reconnectOutcome: "unknown",
    }),
    pageEvents: pageEvents(),
  });
}

async function captureFailedReadiness(
  page,
  evidenceKey,
  pageEvents,
  signal,
  timeoutMs,
  scheduleTimeout,
) {
  if (page?.isClosed?.() === true) {
    return unavailableReadinessObservation("page-closed", pageEvents);
  }
  const observation = observeHostReadiness(page, evidenceKey, pageEvents);
  return await new Promise((resolveObservation) => {
    let settled = false;
    let cancelTimeout = () => undefined;
    let onAbort = () => undefined;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      signal?.removeEventListener("abort", onAbort);
      resolveObservation(value);
    };
    onAbort = () => finish(unavailableReadinessObservation("read-aborted", pageEvents));
    Promise.resolve(observation).then(
      (value) => finish(value),
      () => finish(unavailableReadinessObservation("read-failed", pageEvents)),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      const cancel = scheduleTimeout(
        () => finish(unavailableReadinessObservation("read-timeout", pageEvents)),
        timeoutMs,
      );
      if (typeof cancel === "function") cancelTimeout = cancel;
    } catch {
      finish(unavailableReadinessObservation("read-failed", pageEvents));
    }
  });
}

/**
 * A synchronously-created cleanup authority for a possibly partial Card5 host
 * launch. The owner can abort/retire it before any awaited acquisition returns.
 */
export function createCard5ProductionWebHostLease(input) {
  const cleanupRuntime = input.cleanupRuntime ?? {};
  const isAlive = cleanupRuntime.processAlive ?? processAlive;
  const readProcessRows = cleanupRuntime.processRows ?? processRows;
  const signalProcess =
    cleanupRuntime.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const inspectLsof = cleanupRuntime.lsofCount ?? lsofCount;
  const sleep =
    cleanupRuntime.sleep ??
    ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const closeGraceMs = cleanupRuntime.closeGraceMs ?? CLOSE_GRACE_MS;
  const closeTermMs = cleanupRuntime.closeTermMs ?? CLOSE_TERM_MS;
  const readinessObservationTimeoutMs =
    cleanupRuntime.readinessObservationTimeoutMs ?? CARD5_READINESS_OBSERVATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(readinessObservationTimeoutMs) ||
    readinessObservationTimeoutMs < 1 ||
    readinessObservationTimeoutMs > CARD5_READINESS_OBSERVATION_TIMEOUT_MS
  ) {
    throw new TypeError("Card5 readiness observation timeout is invalid");
  }
  const scheduleReadinessObservationTimeout =
    cleanupRuntime.scheduleReadinessObservationTimeout ??
    ((callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    });
  const controller = new AbortController();
  const externallyAborted = () => controller.abort();
  input.signal?.addEventListener("abort", externallyAborted, { once: true });
  const resources = {
    stage: "created",
    browser: null,
    chromiumContext: null,
    chromiumPage: null,
    chromiumPageEvents: () =>
      Object.freeze({
        pageErrorCount: 0,
        closeCount: 0,
        crashCount: 0,
        events: Object.freeze([]),
        eventOverflow: 0,
      }),
    chromiumReadinessObservation: null,
    chromiumPid: null,
    chromiumIdentityObserved: false,
    electronApp: null,
    electronPage: null,
    electronPageEvents: () =>
      Object.freeze({
        pageErrorCount: 0,
        closeCount: 0,
        crashCount: 0,
        events: Object.freeze([]),
        eventOverflow: 0,
      }),
    electronReadinessObservation: null,
    electronPid: null,
    electronIdentityObserved: false,
    knownChromium: new Set(),
    knownElectron: new Set(),
    chromiumIdentities: new Map(),
    electronIdentities: new Map(),
    chromiumCloseObserved: false,
    electronCloseObserved: false,
  };
  let launchSettled = false;
  let closePromise = null;
  let retiredReceipt = null;
  const pendingAcquisitions = new Set();
  const acquisition = (promise, assign) => {
    const tracked = Promise.resolve(promise).then((value) => {
      assign(value);
      if (controller.signal.aborted) void close();
      return value;
    });
    pendingAcquisitions.add(tracked);
    void tracked.finally(() => pendingAcquisitions.delete(tracked)).catch(() => {});
    return tracked;
  };
  const waitRetired = async (pids, milliseconds = closeGraceMs) => {
    const deadline = performance.now() + milliseconds;
    while (performance.now() < deadline && pids.some(isAlive)) await sleep(10);
  };

  const ownedProcessRows = (rootPid, known, identities, ownedPath) => {
    const rows = readProcessRows();
    const rowByPid = new Map(rows.map((row) => [row.pid, row]));
    const identity = (row) => `${row.startToken}\0${row.pgid}\0${row.command}`;
    const register = (pid) => {
      const row = rowByPid.get(pid);
      if (!row) return;
      if (identities.has(pid)) {
        if (identities.get(pid) === identity(row)) known.add(pid);
        return;
      }
      known.add(pid);
      identities.set(pid, identity(row));
    };
    if (Number.isSafeInteger(rootPid) && !known.has(rootPid)) register(rootPid);
    for (const pid of [...known]) {
      if (!identities.has(pid)) register(pid);
      const row = rowByPid.get(pid);
      if (!row || identities.get(pid) !== identity(row)) known.delete(pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (
          !known.has(row.pid) &&
          known.has(row.ppid) &&
          (!ownedPath ||
            row.command.includes(ownedPath) ||
            row.pgid === rowByPid.get(row.ppid)?.pgid)
        ) {
          register(row.pid);
          changed = true;
        }
      }
    }
    return [...known].map((pid) => rowByPid.get(pid)).filter((row) => row && isAlive(row.pid));
  };
  const terminalProcessState = (row) => typeof row?.state === "string" && /[EZ]/u.test(row.state);
  const boundedProcessEvidence = (rows, host) =>
    Object.freeze(
      rows.slice(0, 32).map((row) =>
        Object.freeze({
          identityHmac: createHmac("sha256", Buffer.from(input.evidenceKey, "hex"))
            .update(`${host}\0${row.pid}\0${row.startToken}\0${row.pgid}\0${row.command}`)
            .digest("hex"),
          terminalState: terminalProcessState(row),
        }),
      ),
    );
  const receipt = (reason = null) => {
    const chromiumRows = ownedProcessRows(
      resources.chromiumPid,
      resources.knownChromium,
      resources.chromiumIdentities,
      null,
    );
    const electronRows = ownedProcessRows(
      resources.electronPid,
      resources.knownElectron,
      resources.electronIdentities,
      input.electronUserData,
    );
    const chromium = chromiumRows.filter((row) => !terminalProcessState(row));
    const electron = electronRows.filter((row) => !terminalProcessState(row));
    const chromiumTerminal = chromiumRows.filter(terminalProcessState);
    const electronTerminal = electronRows.filter(terminalProcessState);
    const chromiumMain = chromium.some(({ pid }) => pid === resources.chromiumPid) ? 1 : 0;
    const electronMain = electron.some(({ pid }) => pid === resources.electronPid) ? 1 : 0;
    const inspectedCount = (pids, inspect) => {
      const values = pids.map(inspect);
      return values.some((value) => value === null)
        ? null
        : values.reduce((sum, value) => sum + value, 0);
    };
    const electronOpenHandleCount = inspectedCount(electronRows, ({ pid }) =>
      inspectLsof(["-n", "-P", "-a", "-p", String(pid)], (line) =>
        line.includes(input.runtimeRoot),
      ),
    );
    const chromiumListenerCount = inspectedCount(chromiumRows, ({ pid }) =>
      inspectLsof(["-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]),
    );
    const electronListenerCount = inspectedCount(electronRows, ({ pid }) =>
      inspectLsof(["-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]),
    );
    return Object.freeze({
      launchStage: resources.stage,
      reason: reason ?? (controller.signal.aborted ? "graceful-retirement" : "active"),
      chromiumReason:
        resources.browser === null ? "not-acquired" : (reason ?? "graceful-retirement"),
      electronReason:
        resources.electronApp === null ? "not-acquired" : (reason ?? "graceful-retirement"),
      acquisitionPendingCount: pendingAcquisitions.size,
      chromiumOwned: resources.browser !== null || Number.isSafeInteger(resources.chromiumPid),
      chromiumRetired:
        pendingAcquisitions.size === 0 &&
        chromium.length === 0 &&
        (resources.browser === null ||
          (resources.chromiumIdentityObserved && resources.chromiumCloseObserved)) &&
        resources.chromiumPage?.isClosed?.() !== false &&
        resources.browser?.isConnected?.() !== true &&
        chromiumListenerCount === 0,
      chromiumProcessCount: chromiumMain,
      chromiumDescendantCount: Math.max(0, chromium.length - chromiumMain),
      chromiumTerminalProcessCount: chromiumTerminal.length,
      chromiumProcessEvidence: boundedProcessEvidence(chromiumRows, "chromium"),
      chromiumProcessEvidenceOverflow: chromiumRows.length > 32,
      chromiumPageCount: resources.chromiumPage?.isClosed?.() === false ? 1 : 0,
      chromiumContextCount: resources.browser?.isConnected?.() === true ? 1 : 0,
      chromiumListenerCount,
      electronOwned: resources.electronApp !== null || Number.isSafeInteger(resources.electronPid),
      electronRetired:
        pendingAcquisitions.size === 0 &&
        electron.length === 0 &&
        (resources.electronApp === null ||
          (resources.electronIdentityObserved && resources.electronCloseObserved)) &&
        resources.electronPage?.isClosed?.() !== false &&
        electronOpenHandleCount === 0 &&
        electronListenerCount === 0,
      electronProcessCount: electronMain,
      electronDescendantCount: Math.max(0, electron.length - electronMain),
      electronTerminalProcessCount: electronTerminal.length,
      electronProcessEvidence: boundedProcessEvidence(electronRows, "electron"),
      electronProcessEvidenceOverflow: electronRows.length > 32,
      retainedProcessIdentities: Object.freeze(
        [
          ...chromiumTerminal.map((row) => ({ ...row, host: "chromium" })),
          ...electronTerminal.map((row) => ({ ...row, host: "electron" })),
        ].map(({ host, pid, ppid, pgid, state, startToken, command }) =>
          Object.freeze({ host, pid, ppid, pgid, state, startToken, command }),
        ),
      ),
      electronWindowCount: resources.electronPage?.isClosed?.() === false ? 1 : 0,
      electronListenerCount,
      electronOpenHandleCount,
    });
  };
  const close = async () => {
    controller.abort();
    if (retiredReceipt) return retiredReceipt;
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!launchSettled)
        await bounded(
          ready.catch(() => undefined),
          closeGraceMs,
        ).catch(() => {});
      await bounded(Promise.allSettled([...pendingAcquisitions]), closeGraceMs).catch(() => {});
      if (!Number.isSafeInteger(resources.chromiumPid) && resources.browser) {
        await bounded(
          Promise.resolve()
            .then(() => resources.browser.newBrowserCDPSession())
            .then((session) => session.send("SystemInfo.getProcessInfo"))
            .then((system) => {
              resources.chromiumPid =
                system.processInfo.find(({ type }) => type === "browser")?.id ?? null;
              if (Number.isSafeInteger(resources.chromiumPid)) {
                resources.chromiumIdentityObserved = true;
                resources.knownChromium.add(resources.chromiumPid);
                ownedProcessRows(
                  resources.chromiumPid,
                  resources.knownChromium,
                  resources.chromiumIdentities,
                  null,
                );
              }
            }),
          closeGraceMs,
        ).catch(() => {});
      }
      const graceful = await Promise.allSettled([
        bounded(
          Promise.resolve().then(() => resources.electronApp?.close?.()),
          closeGraceMs,
        ),
        bounded(
          Promise.resolve().then(() => resources.browser?.close?.()),
          closeGraceMs,
        ),
      ]);
      resources.electronCloseObserved = graceful[0]?.status === "fulfilled";
      resources.chromiumCloseObserved = graceful[1]?.status === "fulfilled";
      await waitRetired([...resources.knownChromium, ...resources.knownElectron]);
      let current = receipt(
        graceful.some(({ status }) => status === "rejected") ? "graceful-close-failed" : null,
      );
      if (!current.chromiumRetired || !current.electronRetired) {
        const ownedRows = [
          ...ownedProcessRows(
            resources.chromiumPid,
            resources.knownChromium,
            resources.chromiumIdentities,
            null,
          ).map((row) => ({ ...row, host: "chromium" })),
          ...ownedProcessRows(
            resources.electronPid,
            resources.knownElectron,
            resources.electronIdentities,
            input.electronUserData,
          ).map((row) => ({ ...row, host: "electron" })),
        ].filter((row) => !terminalProcessState(row));
        const ownedPidSet = new Set(ownedRows.map(({ pid }) => pid));
        const depth = (row) => {
          let value = 0;
          let parent = row.ppid;
          while (ownedPidSet.has(parent) && value <= ownedRows.length) {
            value += 1;
            parent = ownedRows.find(({ pid }) => pid === parent)?.ppid;
          }
          return value;
        };
        const childrenFirst = [...ownedRows].sort((a, b) => depth(b) - depth(a));
        const exactCurrentRow = (row) => {
          const chromium = row.host === "chromium";
          return ownedProcessRows(
            chromium ? resources.chromiumPid : resources.electronPid,
            chromium ? resources.knownChromium : resources.knownElectron,
            chromium ? resources.chromiumIdentities : resources.electronIdentities,
            chromium ? null : input.electronUserData,
          ).find(({ pid }) => pid === row.pid);
        };
        for (const row of childrenFirst) {
          const exactRow = exactCurrentRow(row);
          if (!exactRow || terminalProcessState(exactRow)) continue;
          try {
            signalProcess(row.pid, "SIGTERM");
          } catch {
            // The identity-validated owned process may retire after observation.
          }
        }
        await waitRetired(childrenFirst.map(({ pid }) => pid));
        const remaining = childrenFirst.filter(({ pid }) => isAlive(pid));
        await sleep(closeTermMs);
        for (const row of remaining) {
          const exactRow = exactCurrentRow(row);
          if (!exactRow || terminalProcessState(exactRow)) continue;
          try {
            signalProcess(row.pid, "SIGKILL");
          } catch {
            // The identity-validated owned process may retire after observation.
          }
        }
        await waitRetired(remaining.map(({ pid }) => pid));
        current = receipt("owner-scoped-escalation");
      }
      if (current.chromiumRetired && current.electronRetired) retiredReceipt = current;
      return current;
    })().finally(() => {
      closePromise = null;
    });
    return closePromise;
  };

  const ready = (async () => {
    if (!HASH.test(input.evidenceKey ?? "")) throw new TypeError("Card5 evidence key is malformed");
    const detailedUrl = new URL(input.pageUrl);
    detailedUrl.searchParams.set("performanceHud", "1");
    detailedUrl.searchParams.set("tmuxIdeResourceTelemetry", "1");
    detailedUrl.searchParams.set(CARD5_PROBE_QUERY, "1");
    const topology = card5ProductionHostTopology({ ...input, pageUrl: detailedUrl.toString() });
    const electronEntry = exactOwnedFile(input.electronEntry, input.repoRoot, "Electron entry");
    const environment = { ...input.environment };
    for (const name of [
      "TMUX_IDE_RIG_OWNER_TOKEN",
      "TMUX_IDE_OWNER_TOKEN",
      "TMUX_IDE_AUTH_TOKEN",
      "TMUX_IDE_CAPABILITY",
    ])
      delete environment[name];
    try {
      resources.stage = "chromium-launch";
      resources.browser = await abortable(
        acquisition(input.chromium.launch({ headless: true }), (value) => {
          resources.browser = value;
        }),
        controller.signal,
      );
      resources.stage = "chromium-identity";
      const chromiumSystem = await abortable(
        resources.browser
          .newBrowserCDPSession()
          .then((session) => session.send("SystemInfo.getProcessInfo")),
        controller.signal,
      );
      resources.chromiumPid =
        chromiumSystem.processInfo.find(({ type }) => type === "browser")?.id ?? null;
      if (Number.isSafeInteger(resources.chromiumPid)) {
        resources.chromiumIdentityObserved = true;
        resources.knownChromium.add(resources.chromiumPid);
        ownedProcessRows(
          resources.chromiumPid,
          resources.knownChromium,
          resources.chromiumIdentities,
          null,
        );
      }
      resources.stage = "chromium-context";
      resources.chromiumContext = await abortable(
        resources.browser.newContext({ viewport: { width: 1440, height: 900 } }),
        controller.signal,
      );
      resources.chromiumPage = await abortable(
        resources.chromiumContext.newPage(),
        controller.signal,
      );
      resources.chromiumPageEvents = installReadinessPageEvents(resources.chromiumPage);
      resources.stage = "chromium-readiness";
      await preparePage(
        resources.chromiumPage,
        topology.chromium.pageUrl,
        controller.signal,
        input.evidenceKey,
      );
      resources.stage = "electron-launch";
      resources.electronApp = await abortable(
        acquisition(
          input.electron.launch({
            args: [electronEntry, `--user-data-dir=${topology.electron.userData}`],
            env: {
              ...environment,
              TMUX_IDE_RENDERER_URL: topology.electron.rendererUrl,
              TMUX_IDE_DAEMON_INFO_DIR: resolve(input.daemonInfoDir),
              TMUX_IDE_HOME: topology.ownership.runtimeRoot,
              TMUX_IDE_REGISTRY_DIR: exactOwnedFile(
                input.registryDir,
                topology.ownership.runtimeRoot,
                "Electron registry directory",
              ),
              TMUX_IDE_SETTINGS_DIR: exactOwnedFile(
                input.settingsDir,
                topology.ownership.runtimeRoot,
                "Electron settings directory",
              ),
            },
          }),
          (value) => {
            resources.electronApp = value;
            resources.electronPid = value.process()?.pid ?? null;
            if (Number.isSafeInteger(resources.electronPid)) {
              resources.electronIdentityObserved = true;
              resources.knownElectron.add(resources.electronPid);
              ownedProcessRows(
                resources.electronPid,
                resources.knownElectron,
                resources.electronIdentities,
                input.electronUserData,
              );
            }
          },
        ),
        controller.signal,
      );
      resources.electronPid = resources.electronApp.process()?.pid ?? null;
      if (Number.isSafeInteger(resources.electronPid))
        resources.knownElectron.add(resources.electronPid);
      resources.stage = "electron-window";
      const electronPageEvents = new WeakMap();
      const registerElectronPage = (page) => {
        if (!electronPageEvents.has(page))
          electronPageEvents.set(page, installReadinessPageEvents(page));
      };
      resources.electronApp.on?.("window", registerElectronPage);
      resources.electronPage = await abortable(
        resources.electronApp.firstWindow({ timeout: 60_000 }),
        controller.signal,
      );
      registerElectronPage(resources.electronPage);
      resources.electronPageEvents = electronPageEvents.get(resources.electronPage);
      await resources.electronPage.addInitScript(() => {
        globalThis.__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__ = true;
        globalThis.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
      });
      resources.stage = "electron-readiness";
      await abortable(
        resources.electronPage
          .locator(".app[data-shell-source='runtime']")
          .waitFor({ timeout: 60_000 }),
        controller.signal,
      );
      await waitForElectronReadyTerminal(
        resources.electronPage,
        controller.signal,
        input.evidenceKey,
      );
      if (
        !Number.isSafeInteger(resources.chromiumPid) ||
        !Number.isSafeInteger(resources.electronPid)
      )
        throw new Error("Card5 production host process identities were unavailable");
      resources.knownChromium = new Set([
        resources.chromiumPid,
        ...descendantPids(resources.chromiumPid),
      ]);
      resources.knownElectron = new Set([
        resources.electronPid,
        ...descendantPids(resources.electronPid),
      ]);
      resources.stage = "ready";
      return Object.freeze({
        topology,
        chromiumPage: resources.chromiumPage,
        electronPage: resources.electronPage,
        chromiumProcessIdentity: `chromium:${resources.chromiumPid}`,
        electronProcessIdentity: `electron:${resources.electronPid}`,
        lifecycle: Object.freeze({
          chromiumPid: resources.chromiumPid,
          electronPid: resources.electronPid,
          chromiumDescendants: Object.freeze(
            [...resources.knownChromium].filter((pid) => pid !== resources.chromiumPid),
          ),
          electronDescendants: Object.freeze(
            [...resources.knownElectron].filter((pid) => pid !== resources.electronPid),
          ),
        }),
        setElectronSlowHidden: async (rate = 4) => {
          if (!Number.isSafeInteger(rate) || rate < 1 || rate > 20)
            throw new TypeError("Electron throttle rate is outside the bounded Card5 range");
          const session = await resources.electronPage
            .context()
            .newCDPSession(resources.electronPage);
          await session.send("Emulation.setCPUThrottlingRate", { rate });
          await resources.electronApp.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            if (windows.length !== 1) throw new Error("Card5 expected one Electron BrowserWindow");
            windows[0].hide();
          });
          await resources.electronPage.waitForFunction(
            () => globalThis.document.visibilityState === "hidden",
          );
          return Object.freeze({ hidden: true, throttled: rate > 1, session });
        },
        setElectronSinkBlocked: async (blocked) =>
          resources.electronPage.evaluate((next) => {
            const control = globalThis.__TMUX_IDE_CARD5_SINK_CONTROL__;
            if (!control) throw new Error("Card5 detailed sink control is unavailable");
            control.setBlocked(next);
            return control.snapshot();
          }, blocked === true),
        observeElectronSink: async () =>
          resources.electronPage.evaluate(() => {
            const control = globalThis.__TMUX_IDE_CARD5_SINK_CONTROL__;
            if (!control) throw new Error("Card5 detailed sink control is unavailable");
            return control.snapshot();
          }),
        restoreElectron: async (slow) => {
          await resources.electronPage.evaluate(() =>
            globalThis.__TMUX_IDE_CARD5_SINK_CONTROL__?.setBlocked(false),
          );
          await slow.session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          await resources.electronApp.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            if (windows.length !== 1) throw new Error("Card5 expected one Electron BrowserWindow");
            windows[0].show();
          });
        },
        close,
      });
    } catch (error) {
      if (resources.stage === "chromium-readiness" && resources.chromiumPage)
        resources.chromiumReadinessObservation = await captureFailedReadiness(
          resources.chromiumPage,
          input.evidenceKey,
          resources.chromiumPageEvents,
          controller.signal,
          readinessObservationTimeoutMs,
          scheduleReadinessObservationTimeout,
        );
      if (resources.stage === "electron-readiness" && resources.electronPage)
        resources.electronReadinessObservation = await captureFailedReadiness(
          resources.electronPage,
          input.evidenceKey,
          resources.electronPageEvents,
          controller.signal,
          readinessObservationTimeoutMs,
          scheduleReadinessObservationTimeout,
        );
      resources.stage = `${resources.stage}:failed`;
      launchSettled = true;
      if (!closePromise) await close();
      if (error && typeof error === "object")
        error.observation = Object.freeze({
          operation: "card5-production-host-launch",
          reason: "host-unavailable",
          stage: resources.stage.replace(/:failed$/u, ""),
          chromiumCreated: resources.browser !== null,
          electronCreated: resources.electronApp !== null,
          ...(resources.chromiumReadinessObservation
            ? { chromiumReadiness: resources.chromiumReadinessObservation }
            : {}),
          ...(resources.electronReadinessObservation
            ? { electronReadiness: resources.electronReadinessObservation }
            : {}),
        });
      throw error;
    } finally {
      launchSettled = true;
    }
  })();
  return Object.freeze({ ready, close, snapshot: () => receipt() });
}

/**
 * Launch the two real Web hosts used by Card5 from the existing ProductRig
 * owner. Electron runs its production main/preload/broker entry and attaches
 * to the exact canonical daemon record; it never receives a bearer token.
 */
export async function launchCard5ProductionWebHosts(input) {
  return createCard5ProductionWebHostLease(input).ready;
}

/** Exact browser-side canonical observation; it returns no cell or pane text. */
export async function observeCard5WebCanonical(page, keyHex, processIdentity) {
  if (!HASH.test(keyHex ?? "")) throw new TypeError("Card5 evidence key is malformed");
  if (typeof processIdentity !== "string" || processIdentity.length > 256) {
    throw new TypeError("Card5 process identity is malformed");
  }
  const expectedIdentity = qualifiedTerminalIdentities.get(page);
  if (!expectedIdentity) throw new Error("Card5 qualified terminal readiness was not established");
  const observed = await page.evaluate(
    async ({
      exactKey,
      processIdentity: exactProcessIdentity,
      expectedIdentity: expected,
      expectedSurface,
      daemonInstanceIdPattern,
    }) => {
      const exactDaemonInstanceId = (value) =>
        typeof value === "string" &&
        value.length === 36 &&
        new RegExp(`^(?:${daemonInstanceIdPattern})$`, "iu").test(value);
      const surface = globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") ?? null;
      const surfaceProbeFailure = (axes) => ({
        card5ObservationFailure: "surface-probe-identity-invalid",
        surfaceProbeIdentity: Object.freeze({
          qualifiedSurfaceExact: axes.qualifiedSurfaceExact === true,
          probeSurfaceExact: axes.probeSurfaceExact === true,
          connected: axes.connected === true,
          documentExact: axes.documentExact === true,
          workspaceExact: axes.workspaceExact === true,
          paneExact: axes.paneExact === true,
          phaseExact: axes.phaseExact === true,
          framePreserved: axes.framePreserved === true,
          mutationCount: Number.isSafeInteger(axes.mutationCount)
            ? Math.min(64, axes.mutationCount)
            : null,
          mutationOverflow: axes.mutationOverflow === true,
          physicalBindingStable:
            axes.physicalBindingStable === null ? null : axes.physicalBindingStable === true,
          workspaceSnapshotStable:
            axes.workspaceSnapshotStable === null ? null : axes.workspaceSnapshotStable === true,
          workspaceHmac: /^[0-9a-f]{64}$/u.test(axes.workspaceHmac ?? "")
            ? axes.workspaceHmac
            : null,
          paneHmac: /^[0-9a-f]{64}$/u.test(axes.paneHmac ?? "") ? axes.paneHmac : null,
        }),
      });
      const initialAxes = () => ({
        qualifiedSurfaceExact:
          surface !== null &&
          surface === expectedSurface &&
          globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") === expectedSurface,
        probeSurfaceExact: false,
        connected: surface?.isConnected === true,
        documentExact:
          surface?.ownerDocument === globalThis.document &&
          globalThis.document?.defaultView === globalThis,
        workspaceExact: false,
        paneExact: false,
        phaseExact: surface?.getAttribute?.("data-phase") === "connected",
        framePreserved: surface?.getAttribute?.("data-preserves-frame") === "true",
        mutationCount: 0,
        mutationOverflow: false,
        physicalBindingStable: null,
        workspaceSnapshotStable: null,
        workspaceHmac: null,
        paneHmac: null,
      });
      const firstAxes = initialAxes();
      let lastAxes = firstAxes;
      if (
        !firstAxes.qualifiedSurfaceExact ||
        !firstAxes.connected ||
        !firstAxes.documentExact ||
        !firstAxes.phaseExact ||
        !firstAxes.framePreserved
      )
        return surfaceProbeFailure(firstAxes);
      const workspaceName = surface.getAttribute("data-workspace-name");
      const paneId = surface.getAttribute("data-semantic-pane-id");
      let mutationCount = 0;
      let mutationOverflow = false;
      const relevantElement = (node) => {
        if (!(node instanceof globalThis.Element)) return false;
        if (node === surface || node.contains?.(surface)) return true;
        if (
          node.matches?.(
            `.terminal-surface[data-semantic-pane-id=${globalThis.CSS.escape(paneId)}]`,
          )
        )
          return true;
        return (
          node.querySelector?.(
            `.terminal-surface[data-semantic-pane-id=${globalThis.CSS.escape(paneId)}]`,
          ) !== null
        );
      };
      const recordMutations = (records) => {
        for (const record of records) {
          const relevant =
            record.type === "attributes"
              ? relevantElement(record.target)
              : [...record.addedNodes, ...record.removedNodes].some(relevantElement);
          if (!relevant) continue;
          if (mutationCount === 64) mutationOverflow = true;
          else mutationCount += 1;
        }
      };
      const observer = new globalThis.MutationObserver(recordMutations);
      observer.observe(globalThis.document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: [
          "data-workspace-name",
          "data-semantic-pane-id",
          "data-phase",
          "data-preserves-frame",
        ],
      });
      const drainMutations = () => recordMutations(observer.takeRecords());
      let expectedPhysicalBindingCaptured = false;
      let expectedPhysicalBinding = null;
      let physicalBindingUnstable = false;
      let expectedWorkspaceSnapshotKey = null;
      let workspaceSnapshotUnstable = false;
      const physicalBindingStable = () => {
        if (!expectedPhysicalBindingCaptured) return true;
        if (physicalBindingUnstable) return false;
        try {
          const current =
            globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?.()?.currentPhysicalBinding;
          const exact =
            expectedPhysicalBinding === null
              ? (current ?? null) === null
              : current?.physicalEpoch === expectedPhysicalBinding.physicalEpoch &&
                current?.generation === expectedPhysicalBinding.generation &&
                current?.requestId === expectedPhysicalBinding.requestId &&
                current?.runtimeSession === expectedPhysicalBinding.runtimeSession &&
                current?.workspaceName === expectedPhysicalBinding.workspaceName &&
                current?.clientId === expectedPhysicalBinding.clientId &&
                current?.stage === expectedPhysicalBinding.stage &&
                JSON.stringify(current?.semanticPaneIds) ===
                  JSON.stringify(expectedPhysicalBinding.semanticPaneIds);
          if (!exact) physicalBindingUnstable = true;
          return exact;
        } catch {
          physicalBindingUnstable = true;
          return false;
        }
      };
      const workspaceSnapshotStable = () => {
        if (expectedWorkspaceSnapshotKey === null) return true;
        if (workspaceSnapshotUnstable) return false;
        try {
          const current = globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__?.()?.snapshot;
          const exact =
            JSON.stringify({
              generation: current?.generation,
              phase: current?.phase,
              targetDaemonGeneration: current?.target?.daemon?.instanceId,
              authorityGeneration: current?.authority?.generation,
              authoritySession: current?.authority?.session,
              authorityClients: current?.authority?.clients,
            }) === expectedWorkspaceSnapshotKey;
          if (!exact) workspaceSnapshotUnstable = true;
          return exact;
        } catch {
          workspaceSnapshotUnstable = true;
          return false;
        }
      };
      const stillExact = () => (
        drainMutations(),
        mutationCount === 0 &&
          mutationOverflow === false &&
          surface === expectedSurface &&
          surface.isConnected === true &&
          surface.ownerDocument === globalThis.document &&
          globalThis.document?.defaultView === globalThis &&
          globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") === expectedSurface &&
          surface.getAttribute("data-workspace-name") === workspaceName &&
          surface.getAttribute("data-semantic-pane-id") === paneId &&
          surface.getAttribute("data-phase") === "connected" &&
          surface.getAttribute("data-preserves-frame") === "true" &&
          physicalBindingStable() &&
          workspaceSnapshotStable()
      );
      const assessedAxes = (overrides = {}) => ({
        ...lastAxes,
        qualifiedSurfaceExact:
          surface === expectedSurface &&
          globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") === expectedSurface,
        connected: surface?.isConnected === true,
        documentExact:
          surface?.ownerDocument === globalThis.document &&
          globalThis.document?.defaultView === globalThis,
        workspaceExact: surface?.getAttribute?.("data-workspace-name") === workspaceName,
        paneExact: surface?.getAttribute?.("data-semantic-pane-id") === paneId,
        phaseExact: surface?.getAttribute?.("data-phase") === "connected",
        framePreserved: surface?.getAttribute?.("data-preserves-frame") === "true",
        mutationCount,
        mutationOverflow,
        physicalBindingStable: expectedPhysicalBindingCaptured ? physicalBindingStable() : null,
        workspaceSnapshotStable:
          expectedWorkspaceSnapshotKey === null ? null : workspaceSnapshotStable(),
        ...overrides,
      });
      try {
        const bytes = Uint8Array.from(
          exactKey.match(/../gu).map((pair) => Number.parseInt(pair, 16)),
        );
        const key = await globalThis.crypto.subtle.importKey(
          "raw",
          bytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        if (!stillExact()) return surfaceProbeFailure(assessedAxes());
        const hmac = async (domain, value) => {
          const maxLength = domain === "pane-set" ? 16_384 : 512;
          if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
            return null;
          const signed = await globalThis.crypto.subtle.sign(
            "HMAC",
            key,
            new TextEncoder().encode(`${domain}\0${value}`),
          );
          const digest = [...new Uint8Array(signed)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          return stillExact() ? digest : null;
        };
        const paneSetValue = (paneIds) => {
          const sorted = Array.isArray(paneIds) ? [...paneIds].sort() : [];
          return `${sorted.length}\0${sorted.map((paneId) => `${paneId.length}\0${paneId}`).join("")}`;
        };
        const workspaceHmac = await hmac("workspace", workspaceName);
        lastAxes = assessedAxes({ workspaceHmac });
        if (!stillExact()) return surfaceProbeFailure(assessedAxes({ workspaceHmac }));
        if (workspaceHmac !== expected.workspaceHmac) return null;
        const paneHmac = await hmac("pane", paneId);
        lastAxes = assessedAxes({ workspaceHmac, paneHmac });
        if (!stillExact()) return surfaceProbeFailure(assessedAxes({ workspaceHmac, paneHmac }));
        if (paneHmac !== expected.paneHmac) return null;
        const probe = globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__;
        if (!paneId || typeof probe !== "function") return null;
        const result = await probe(paneId, exactKey);
        const resultAxes = assessedAxes({
          probeSurfaceExact: result?.surface === surface && result?.surface === expectedSurface,
          workspaceHmac,
          paneHmac,
        });
        lastAxes = resultAxes;
        if (!result) return surfaceProbeFailure(resultAxes);
        const resultStillExact = stillExact();
        if (!resultStillExact || !resultAxes.probeSurfaceExact)
          return surfaceProbeFailure(
            assessedAxes({
              probeSurfaceExact: resultAxes.probeSurfaceExact,
              workspaceHmac,
              paneHmac,
            }),
          );
        const queueText = [...globalThis.document.querySelectorAll(".gui-performance-hud dl")]
          .find((row) => row.querySelector("dt")?.textContent?.trim() === "Queue")
          ?.querySelector("dd")
          ?.textContent?.trim();
        const queue = /^(\d+)\s*\/\s*(\d+)$/u.exec(queueText ?? "");
        const evidence =
          typeof globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ === "function"
            ? globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__()
            : null;
        const workspaceEvidence =
          typeof globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ === "function"
            ? globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__()
            : null;
        const workspaceSnapshot = workspaceEvidence?.snapshot ?? null;
        const physicalBinding = evidence?.currentPhysicalBinding ?? null;
        expectedPhysicalBinding =
          physicalBinding === null
            ? null
            : Object.freeze({
                physicalEpoch: physicalBinding.physicalEpoch,
                generation: physicalBinding.generation,
                requestId: physicalBinding.requestId,
                runtimeSession: physicalBinding.runtimeSession,
                workspaceName: physicalBinding.workspaceName,
                clientId: physicalBinding.clientId,
                stage: physicalBinding.stage,
                semanticPaneIds: Array.isArray(physicalBinding.semanticPaneIds)
                  ? Object.freeze([...physicalBinding.semanticPaneIds])
                  : physicalBinding.semanticPaneIds,
              });
        expectedPhysicalBindingCaptured = true;
        expectedWorkspaceSnapshotKey = JSON.stringify({
          generation: workspaceSnapshot?.generation,
          phase: workspaceSnapshot?.phase,
          targetDaemonGeneration: workspaceSnapshot?.target?.daemon?.instanceId,
          authorityGeneration: workspaceSnapshot?.authority?.generation,
          authoritySession: workspaceSnapshot?.authority?.session,
          authorityClients: workspaceSnapshot?.authority?.clients,
        });
        if (!stillExact())
          return surfaceProbeFailure(
            assessedAxes({
              physicalBindingStable: physicalBindingStable(),
              workspaceSnapshotStable: workspaceSnapshotStable(),
            }),
          );
        const authorityGeneration = workspaceSnapshot?.authority?.generation;
        const targetDaemonGeneration = workspaceSnapshot?.target?.daemon?.instanceId;
        const daemonGeneration =
          exactDaemonInstanceId(authorityGeneration) &&
          authorityGeneration === targetDaemonGeneration
            ? authorityGeneration
            : null;
        const physicalBindingAxes = Object.freeze({
          present: physicalBinding !== null,
          epochSafe:
            Number.isSafeInteger(physicalBinding?.physicalEpoch) &&
            physicalBinding.physicalEpoch > 0,
          generationExact:
            daemonGeneration !== null &&
            physicalBinding?.generation === daemonGeneration &&
            result.canonical.generation === daemonGeneration,
          runtimeSessionExact:
            physicalBinding?.runtimeSession === workspaceSnapshot?.authority?.session,
          workspaceExact: physicalBinding?.workspaceName === workspaceName,
          paneExact:
            Array.isArray(physicalBinding?.semanticPaneIds) &&
            physicalBinding.semanticPaneIds.includes(paneId),
          stageExact: physicalBinding?.stage === "first-seed",
          clientExact:
            Array.isArray(workspaceSnapshot?.authority?.clients) &&
            workspaceSnapshot.authority.clients.filter(
              (client) =>
                client?.clientId === physicalBinding?.clientId && client?.surface === "web",
            ).length === 1,
        });
        const physicalBindingExact = Object.values(physicalBindingAxes).every(Boolean);
        const rawLifecycleRequests = Array.isArray(evidence?.activeLifecycleRequests)
          ? evidence.activeLifecycleRequests.filter(
              (request) =>
                daemonGeneration !== null &&
                request?.generation === daemonGeneration &&
                request.workspaceName === workspaceName &&
                Array.isArray(request.semanticPaneIds) &&
                request.semanticPaneIds.includes(paneId),
            )
          : [];
        const epochLifecycleRequests = Array.isArray(evidence?.activeLifecycleRequests)
          ? evidence.activeLifecycleRequests.filter(
              (request) =>
                physicalBindingExact &&
                request?.physicalEpoch === physicalBinding.physicalEpoch &&
                daemonGeneration !== null &&
                request?.generation === daemonGeneration &&
                request.workspaceName === workspaceName &&
                Array.isArray(request.semanticPaneIds) &&
                request.semanticPaneIds.includes(paneId),
            )
          : [];
        const activeLifecycleRequests = epochLifecycleRequests.filter(
          (request) => request?.requestId === physicalBinding.requestId,
        );
        const activeLifecycleRequestOverflow =
          evidence?.activeLifecycleRequestGlobalOverflow === true ||
          (Array.isArray(evidence?.activeLifecycleRequestOverflowGenerations) &&
            daemonGeneration !== null &&
            evidence.activeLifecycleRequestOverflowGenerations.includes(daemonGeneration)) ||
          epochLifecycleRequests.length > 8;
        const currentLifecycleRequestStatus = activeLifecycleRequestOverflow
          ? "overflow"
          : activeLifecycleRequests.length === 0
            ? "missing"
            : activeLifecycleRequests.length === 1 && epochLifecycleRequests.length === 1
              ? "exact"
              : "ambiguous";
        const currentLifecycleRequestHmac =
          currentLifecycleRequestStatus === "exact"
            ? await hmac("request", activeLifecycleRequests[0].requestId)
            : null;
        if (!stillExact()) return surfaceProbeFailure(assessedAxes());
        const epochLifecycleDescriptors =
          currentLifecycleRequestStatus === "exact" && Array.isArray(evidence?.descriptorEvents)
            ? evidence.descriptorEvents.filter(
                (descriptor) =>
                  descriptor?.physicalEpoch === physicalBinding.physicalEpoch &&
                  daemonGeneration !== null &&
                  descriptor?.generation === daemonGeneration,
              )
            : [];
        const currentLifecycleDescriptors = epochLifecycleDescriptors.filter(
          (descriptor) =>
            descriptor?.requestId === activeLifecycleRequests[0]?.requestId &&
            descriptor?.requestId === physicalBinding.requestId,
        );
        const currentLifecycleDescriptorContractCount =
          epochLifecycleDescriptors.length === 0
            ? 0
            : epochLifecycleDescriptors.length === 1 && currentLifecycleDescriptors.length === 1
              ? 1
              : Math.min(Math.max(epochLifecycleDescriptors.length, 2), 8);
        const currentLifecycleSocketHmac =
          epochLifecycleDescriptors.length === 1 && currentLifecycleDescriptors.length === 1
            ? await hmac(
                "socket",
                `${currentLifecycleDescriptors[0].socketUrl}\0${activeLifecycleRequests[0].requestId}`,
              )
            : null;
        const activeLifecycleTail = Array.isArray(evidence?.activeLifecycleRequests)
          ? evidence.activeLifecycleRequests.slice(-2)
          : [];
        if (!stillExact()) return surfaceProbeFailure(assessedAxes());
        if (
          surface.getAttribute("data-workspace-name") !== workspaceName ||
          surface.getAttribute("data-semantic-pane-id") !== paneId
        ) {
          return null;
        }
        const authorityActivityEvidence =
          typeof globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__ === "function"
            ? globalThis.__TMUX_IDE_CARD5_AUTHORITY_ACTIVITY_EVIDENCE__()
            : null;
        const geometryOkEvents = Array.isArray(authorityActivityEvidence?.events)
          ? authorityActivityEvidence.events.filter(
              (event) => event?.kind === "geometry" && event?.outcome === "ok",
            )
          : [];
        const geometrySettlements = Array.isArray(evidence?.geometryReceipts)
          ? await Promise.all(
              evidence.geometryReceipts.slice(-16).map(async (receipt, index) => ({
                ordinal: Number.isSafeInteger(receipt?.ordinal) ? receipt.ordinal : null,
                operationOrdinal: Number.isSafeInteger(geometryOkEvents[index]?.operationOrdinal)
                  ? geometryOkEvents[index].operationOrdinal
                  : null,
                requestHmac: await hmac("geometry-request", receipt?.requestId),
                clientHmac: await hmac("geometry-client", receipt?.authorityClientId),
                dimensionsHmac: await hmac(
                  "geometry-dimensions",
                  `${receipt?.cols}x${receipt?.rows}`,
                ),
              })),
            )
          : [];
        const authorityActivityProjection = authorityActivityEvidence
          ? {
              count: authorityActivityEvidence.count,
              overflow: authorityActivityEvidence.overflow,
              events: await Promise.all(
                authorityActivityEvidence.events.slice(-64).map(async (event) => ({
                  ordinal: event.ordinal,
                  surface: event.surface,
                  kind: event.kind,
                  outcome: event.outcome,
                  operationOrdinal: event.operationOrdinal,
                  dimensionsHmac:
                    event.kind === "geometry"
                      ? await hmac("geometry-dimensions", `${event.cols}x${event.rows}`)
                      : null,
                })),
              ),
              geometrySettlements,
            }
          : null;
        const lifecycleTail = Array.isArray(evidence?.lifecycleEvents)
          ? evidence.lifecycleEvents
              .filter((event) => event?.physicalEpoch === physicalBinding?.physicalEpoch)
              .slice(-2)
          : [];
        const observation = {
          workspaceName,
          semanticPaneId: paneId,
          incarnation: result.canonical.incarnation,
          processIdentity: exactProcessIdentity,
          clockId: "browser-performance-now",
          atMicros: Math.round(globalThis.performance.now() * 1_000),
          generation: result.canonical.generation,
          revision: result.canonical.revision,
          cols: result.canonical.cols,
          rows: result.canonical.rows,
          deliveryFence: evidence?.acceptedCount ?? null,
          deliveryAckFence: evidence?.ackSentCount ?? null,
          canonicalStateHash: result.canonical.stateHash,
          contentHmac: result.rendition.renditionHmac,
          connected: true,
          surfaceProbeIdentity: Object.freeze({
            qualifiedSurfaceExact: true,
            probeSurfaceExact: true,
            connected: true,
            documentExact: true,
            workspaceExact: true,
            paneExact: true,
            phaseExact: true,
            framePreserved: true,
            mutationCount: 0,
            mutationOverflow: false,
            physicalBindingStable: true,
            workspaceSnapshotStable: true,
            workspaceHmac,
            paneHmac,
          }),
          presence: globalThis.document.visibilityState === "visible" ? "foreground" : "background",
          passive: surface.getAttribute("data-size-passive") === "true",
          geometryOwner: surface.getAttribute("data-geometry-ownership") === "owner",
          queueCurrent: queue ? Number(queue[1]) : null,
          queuePeak: queue ? Number(queue[2]) : null,
          envelopes: evidence?.events ?? [],
          runtimeReplacement: evidence
            ? {
                replacementCount: evidence.replacementCount,
                replacementBoundary: evidence.replacementBoundary,
                predecessorAcceptedAfterReplacement: evidence.predecessorAcceptedAfterReplacement,
                socketEvents: evidence.socketEvents,
                socketEventCount: evidence.socketEventCount,
                ackEvents: evidence.ackEvents,
                ackSentCount: evidence.ackSentCount,
                inputReceipts: evidence.inputReceipts,
                inputReceiptCount: evidence.inputReceiptCount,
                geometryReceipts: evidence.geometryReceipts,
                geometryReceiptCount: evidence.geometryReceiptCount,
                descriptorEvents: evidence.descriptorEvents,
                descriptorEventCount: evidence.descriptorEventCount,
                currentLifecycleRequest: Object.freeze({
                  status: currentLifecycleRequestStatus,
                  requestHmac: currentLifecycleRequestHmac,
                  socketHmac: currentLifecycleSocketHmac,
                  activeCount: Math.min(activeLifecycleRequests.length, 8),
                  overflow: activeLifecycleRequestOverflow,
                  descriptorCount: currentLifecycleDescriptorContractCount,
                  rawActiveCount: Math.min(rawLifecycleRequests.length, 8),
                  rawDescriptorCount: Math.min(
                    Array.isArray(evidence.descriptorEvents) ? evidence.descriptorEvents.length : 0,
                    8,
                  ),
                  physicalBindingExact,
                  physicalBindingAxes: Object.freeze({
                    ...physicalBindingAxes,
                    epochActiveCount: Math.min(epochLifecycleRequests.length, 8),
                    bindingRequestExact:
                      activeLifecycleRequests.length === 1 &&
                      activeLifecycleRequests[0].requestId === physicalBinding?.requestId,
                    descriptorExact:
                      currentLifecycleDescriptorContractCount === 1 &&
                      currentLifecycleSocketHmac !== null,
                  }),
                  physicalEpochHmac: physicalBindingExact
                    ? await hmac("physical-epoch", String(physicalBinding.physicalEpoch))
                    : null,
                  bindingRequestHmac:
                    physicalBindingExact && typeof physicalBinding.requestId === "string"
                      ? await hmac("request", physicalBinding.requestId)
                      : null,
                  bindingClientHmac:
                    physicalBindingExact && typeof physicalBinding.clientId === "string"
                      ? await hmac("authority-client", physicalBinding.clientId)
                      : null,
                  deliveryClientHmac:
                    physicalBindingExact && typeof physicalBinding.clientId === "string"
                      ? await hmac("client", physicalBinding.clientId)
                      : null,
                  activeTail: Object.freeze(
                    await Promise.all(
                      activeLifecycleTail.map(async (request) => ({
                        ordinal: Number.isSafeInteger(request?.firstSeedOrdinal)
                          ? request.firstSeedOrdinal
                          : null,
                        epochHmac: await hmac("physical-epoch", String(request?.physicalEpoch)),
                        generationHmac: await hmac("generation", request?.generation),
                        requestHmac: await hmac("request", request?.requestId),
                        workspaceHmac: await hmac("workspace", request?.workspaceName),
                        paneSetHmac: await hmac("pane-set", paneSetValue(request?.semanticPaneIds)),
                      })),
                    ),
                  ),
                  lifecycleTail: Object.freeze(
                    await Promise.all(
                      lifecycleTail.map(async (event) => ({
                        stage: event.stage,
                        code: event.code,
                        epochHmac: await hmac("physical-epoch", String(event.physicalEpoch)),
                        ordinal: Number.isSafeInteger(event.ordinal) ? event.ordinal : null,
                      })),
                    ),
                  ),
                  firstSeedOrdinal:
                    currentLifecycleRequestStatus === "exact" &&
                    Number.isSafeInteger(activeLifecycleRequests[0].firstSeedOrdinal)
                      ? activeLifecycleRequests[0].firstSeedOrdinal
                      : null,
                }),
              }
            : null,
          workspaceEvidence: workspaceSnapshot
            ? {
                generation: workspaceSnapshot.generation,
                phase: workspaceSnapshot.phase,
                target: workspaceSnapshot.target,
                authority: workspaceSnapshot.authority,
                operations: workspaceSnapshot.operations,
                authorityRecords: workspaceEvidence.authorityRecords,
                authorityRecordCount: workspaceEvidence.authorityRecordCount,
                authorityActivity: authorityActivityProjection,
              }
            : null,
        };
        if (!stillExact())
          return surfaceProbeFailure(
            assessedAxes({
              physicalBindingStable: physicalBindingStable(),
              workspaceSnapshotStable: workspaceSnapshotStable(),
            }),
          );
        return observation;
      } finally {
        observer.disconnect();
      }
    },
    {
      exactKey: keyHex,
      processIdentity,
      expectedIdentity: {
        workspaceHmac: expectedIdentity.workspaceHmac,
        paneHmac: expectedIdentity.paneHmac,
      },
      expectedSurface: expectedIdentity.surfaceHandle,
      daemonInstanceIdPattern: DAEMON_INSTANCE_ID_PATTERN,
    },
  );
  if (observed?.card5ObservationFailure === "surface-probe-identity-invalid") {
    const error = new Error("Card5 canonical surface probe identity changed");
    error.observation = Object.freeze({
      operation: "card5-web-canonical-observation",
      reason: "surface-probe-identity-invalid",
      surfaceProbeIdentity: observed.surfaceProbeIdentity,
    });
    throw error;
  }
  return observed;
}

/**
 * Identity-fenced authority/receipt observation for handoff polling. Unlike the
 * canonical observer this never requests a rendition, so authority progress is
 * not coupled to a potentially slow terminal capture.
 */
export async function observeCard5WebAuthorityReceipt(page, keyHex, processIdentity) {
  if (!HASH.test(keyHex ?? "")) throw new TypeError("Card5 evidence key is malformed");
  if (typeof processIdentity !== "string" || processIdentity.length > 256) {
    throw new TypeError("Card5 process identity is malformed");
  }
  const expectedIdentity = qualifiedTerminalIdentities.get(page);
  if (!expectedIdentity) throw new Error("Card5 qualified terminal readiness was not established");
  return page.evaluate(
    async ({
      exactKey,
      processIdentity: exactProcessIdentity,
      expectedIdentity: expected,
      expectedSurface,
      daemonInstanceIdPattern,
    }) => {
      const exactDaemonInstanceId = (value) =>
        typeof value === "string" &&
        value.length === 36 &&
        new RegExp(`^(?:${daemonInstanceIdPattern})$`, "iu").test(value);
      const surface = globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") ?? null;
      if (!surface || surface !== expectedSurface) return null;
      const bytes = Uint8Array.from(
        exactKey.match(/../gu).map((pair) => Number.parseInt(pair, 16)),
      );
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const hmac = async (domain, value) => {
        const maxLength = domain === "pane-set" ? 16_384 : 512;
        if (typeof value !== "string" || value.length === 0 || value.length > maxLength)
          return null;
        const signed = await globalThis.crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${domain}\0${value}`),
        );
        return [...new Uint8Array(signed)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      };
      const paneSetValue = (paneIds) => {
        const sorted = Array.isArray(paneIds) ? [...paneIds].sort() : [];
        return `${sorted.length}\0${sorted.map((paneId) => `${paneId.length}\0${paneId}`).join("")}`;
      };
      const workspaceName = surface.getAttribute("data-workspace-name");
      const paneId = surface.getAttribute("data-semantic-pane-id");
      const stillExact = () =>
        globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") === expectedSurface &&
        surface.getAttribute("data-workspace-name") === workspaceName &&
        surface.getAttribute("data-semantic-pane-id") === paneId;
      if (
        (await hmac("workspace", workspaceName)) !== expected.workspaceHmac ||
        (await hmac("pane", paneId)) !== expected.paneHmac ||
        !stillExact()
      ) {
        return null;
      }
      const envelope =
        typeof globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ === "function"
          ? globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__()
          : null;
      const workspace =
        typeof globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ === "function"
          ? globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__()
          : null;
      const snapshot = workspace?.snapshot ?? null;
      if (!envelope || !snapshot || !stillExact()) return null;
      const physicalBinding = envelope.currentPhysicalBinding ?? null;
      const authorityGeneration = snapshot.authority?.generation;
      const targetDaemonGeneration = snapshot.target?.daemon?.instanceId;
      const daemonGeneration =
        exactDaemonInstanceId(authorityGeneration) && authorityGeneration === targetDaemonGeneration
          ? authorityGeneration
          : null;
      const physicalBindingAxes = Object.freeze({
        present: physicalBinding !== null,
        epochSafe:
          Number.isSafeInteger(physicalBinding?.physicalEpoch) && physicalBinding.physicalEpoch > 0,
        generationExact:
          daemonGeneration !== null && physicalBinding?.generation === daemonGeneration,
        runtimeSessionExact: physicalBinding?.runtimeSession === snapshot.authority?.session,
        workspaceExact: physicalBinding?.workspaceName === workspaceName,
        paneExact:
          Array.isArray(physicalBinding?.semanticPaneIds) &&
          physicalBinding.semanticPaneIds.includes(paneId),
        stageExact: physicalBinding?.stage === "first-seed",
        clientExact:
          Array.isArray(snapshot.authority?.clients) &&
          snapshot.authority.clients.filter(
            (client) => client?.clientId === physicalBinding?.clientId && client?.surface === "web",
          ).length === 1,
      });
      const physicalBindingExact = Object.values(physicalBindingAxes).every(Boolean);
      const rawActive = Array.isArray(envelope.activeLifecycleRequests)
        ? envelope.activeLifecycleRequests.filter(
            (request) =>
              daemonGeneration !== null &&
              request?.generation === daemonGeneration &&
              request.workspaceName === workspaceName &&
              Array.isArray(request.semanticPaneIds) &&
              request.semanticPaneIds.includes(paneId),
          )
        : [];
      const epochActive = Array.isArray(envelope.activeLifecycleRequests)
        ? envelope.activeLifecycleRequests.filter(
            (request) =>
              physicalBindingExact &&
              request?.physicalEpoch === physicalBinding.physicalEpoch &&
              daemonGeneration !== null &&
              request?.generation === daemonGeneration &&
              request.workspaceName === workspaceName &&
              Array.isArray(request.semanticPaneIds) &&
              request.semanticPaneIds.includes(paneId),
          )
        : [];
      const active = epochActive.filter(
        (request) => request?.requestId === physicalBinding.requestId,
      );
      const overflow =
        envelope.activeLifecycleRequestGlobalOverflow === true ||
        (Array.isArray(envelope.activeLifecycleRequestOverflowGenerations) &&
          daemonGeneration !== null &&
          envelope.activeLifecycleRequestOverflowGenerations.includes(daemonGeneration)) ||
        epochActive.length > 8;
      const requestStatus = overflow
        ? "overflow"
        : active.length === 0
          ? "missing"
          : active.length === 1 && epochActive.length === 1
            ? "exact"
            : "ambiguous";
      const requestHmac =
        requestStatus === "exact" ? await hmac("request", active[0].requestId) : null;
      const epochDescriptors =
        requestStatus === "exact" && Array.isArray(envelope.descriptorEvents)
          ? envelope.descriptorEvents.filter(
              (descriptor) =>
                descriptor?.physicalEpoch === physicalBinding.physicalEpoch &&
                daemonGeneration !== null &&
                descriptor?.generation === daemonGeneration,
            )
          : [];
      const descriptors = epochDescriptors.filter(
        (descriptor) =>
          descriptor?.requestId === active[0]?.requestId &&
          descriptor?.requestId === physicalBinding.requestId,
      );
      const descriptorContractCount =
        epochDescriptors.length === 0
          ? 0
          : epochDescriptors.length === 1 && descriptors.length === 1
            ? 1
            : Math.min(Math.max(epochDescriptors.length, 2), 8);
      if (!stillExact()) return null;
      const lifecycleTail = Array.isArray(envelope.lifecycleEvents)
        ? envelope.lifecycleEvents
            .filter((event) => event?.physicalEpoch === physicalBinding?.physicalEpoch)
            .slice(-2)
        : [];
      const activeLifecycleTail = Array.isArray(envelope.activeLifecycleRequests)
        ? envelope.activeLifecycleRequests.slice(-2)
        : [];
      return {
        workspaceName,
        semanticPaneId: paneId,
        processIdentity: exactProcessIdentity,
        generation: daemonGeneration,
        runtimeReplacement: {
          inputReceipts: envelope.inputReceipts,
          inputReceiptCount: envelope.inputReceiptCount,
          currentLifecycleRequest: {
            status: requestStatus,
            requestHmac,
            paneSetHmac:
              requestStatus === "exact" && active.length === 1
                ? await hmac("pane-set", paneSetValue(active[0].semanticPaneIds))
                : null,
            activeCount: Math.min(active.length, 8),
            descriptorCount: descriptorContractCount,
            overflow,
            rawActiveCount: Math.min(rawActive.length, 8),
            rawDescriptorCount: Math.min(
              Array.isArray(envelope.descriptorEvents) ? envelope.descriptorEvents.length : 0,
              8,
            ),
            physicalBindingExact,
            physicalBindingAxes: Object.freeze({
              ...physicalBindingAxes,
              epochActiveCount: Math.min(epochActive.length, 8),
              bindingRequestExact:
                active.length === 1 && active[0].requestId === physicalBinding?.requestId,
              descriptorExact: descriptorContractCount === 1,
            }),
            physicalEpochHmac: physicalBindingExact
              ? await hmac("physical-epoch", String(physicalBinding.physicalEpoch))
              : null,
            bindingRequestHmac:
              physicalBindingExact && typeof physicalBinding.requestId === "string"
                ? await hmac("request", physicalBinding.requestId)
                : null,
            bindingClientHmac:
              physicalBindingExact && typeof physicalBinding.clientId === "string"
                ? await hmac("authority-client", physicalBinding.clientId)
                : null,
            activeTail: await Promise.all(
              activeLifecycleTail.map(async (request) => ({
                ordinal: Number.isSafeInteger(request?.firstSeedOrdinal)
                  ? request.firstSeedOrdinal
                  : null,
                epochHmac: await hmac("physical-epoch", String(request?.physicalEpoch)),
                generationHmac: await hmac("generation", request?.generation),
                requestHmac: await hmac("request", request?.requestId),
                workspaceHmac: await hmac("workspace", request?.workspaceName),
                paneSetHmac: await hmac("pane-set", paneSetValue(request?.semanticPaneIds)),
              })),
            ),
            lifecycleTail: await Promise.all(
              lifecycleTail.map(async (event) => ({
                stage: event.stage,
                code: event.code,
                epochHmac: await hmac("physical-epoch", String(event.physicalEpoch)),
                ordinal: Number.isSafeInteger(event.ordinal) ? event.ordinal : null,
              })),
            ),
          },
        },
        workspaceEvidence: {
          generation: snapshot.generation,
          phase: snapshot.phase,
          target: snapshot.target,
          authority: snapshot.authority,
          authorityRecords: workspace.authorityRecords,
          authorityRecordCount: workspace.authorityRecordCount,
        },
      };
    },
    {
      exactKey: keyHex,
      processIdentity,
      expectedIdentity: {
        workspaceHmac: expectedIdentity.workspaceHmac,
        paneHmac: expectedIdentity.paneHmac,
      },
      expectedSurface: expectedIdentity.surfaceHandle,
      daemonInstanceIdPattern: DAEMON_INSTANCE_ID_PATTERN,
    },
  );
}

/** Trusted pointer activation for the one already-qualified Card5 terminal. */
export async function activateCard5ExactTerminalSurface({
  mode,
  page,
  keyHex,
  processIdentity,
  expectedPane,
  expectedPaneHmac,
  inputText,
  inputSha256,
  inputHostRole,
  inputOrdinal,
  deadline = performance.now() + 3_000,
  observeAuthorityReceipt = observeCard5WebAuthorityReceipt,
}) {
  const activationStartedAt = performance.now();
  let activationPhase = "contract";
  let activationTargetKind = null;
  let activationTargetAxes = null;
  let activationLifecycleAxes = null;
  let activationInputGuardAxes = null;
  let activationInputGuardReason = null;
  let activationInputReceiptAxes = null;
  let activationInputReceiptStartAxes = null;
  let activationPointerDispatchAxes = null;
  let activationPointerDispatchReason = null;
  const boundedInputContextHmac = (domain, value) =>
    typeof keyHex === "string" && /^[0-9a-f]{64}$/u.test(keyHex) && value !== undefined
      ? createHmac("sha256", Buffer.from(keyHex, "hex"))
          .update(`${domain}\0${String(value)}`)
          .digest("hex")
      : null;
  const fail = (reason, cause) => {
    const failedAt = performance.now();
    const error = new Error("Card5 exact Web terminal focus activation failed", { cause });
    error.observation = Object.freeze({
      operation: "card5-web-terminal-focus",
      reason,
      expectedPaneHmac: HASH.test(expectedPaneHmac ?? "") ? expectedPaneHmac : null,
      phase: activationPhase,
      elapsedMs:
        Number.isFinite(failedAt) && Number.isFinite(activationStartedAt)
          ? Math.min(10_000, Math.max(0, Math.round(failedAt - activationStartedAt)))
          : null,
      remainingMs:
        Number.isFinite(failedAt) && Number.isFinite(deadline)
          ? Math.min(10_000, Math.max(0, Math.round(deadline - failedAt)))
          : null,
      targetKind: activationTargetKind,
      targetAxes: activationTargetAxes,
      lifecycleAxes: activationLifecycleAxes,
      inputGuardAxes: activationInputGuardAxes,
      inputGuardReason: activationInputGuardReason,
      inputReceiptAxes: activationInputReceiptAxes,
      inputReceiptStartAxes: activationInputReceiptStartAxes,
      pointerDispatchAxes: activationPointerDispatchAxes,
      pointerDispatchReason: activationPointerDispatchReason,
      inputHostRoleHmac: insertsInput
        ? boundedInputContextHmac("input-host-role", inputHostRole)
        : null,
      inputOrdinalHmac: insertsInput
        ? boundedInputContextHmac("input-ordinal", inputOrdinal)
        : null,
    });
    return error;
  };
  const insertsInput = mode === "input";
  if (
    !["focus", "input"].includes(mode) ||
    (insertsInput &&
      (typeof inputText !== "string" ||
        inputText.length === 0 ||
        inputText.length > 4_096 ||
        !HASH.test(inputSha256 ?? "") ||
        !["chromium", "electron"].includes(inputHostRole) ||
        !Number.isSafeInteger(inputOrdinal) ||
        inputOrdinal < 1 ||
        inputOrdinal > 2)) ||
    !Number.isFinite(deadline)
  ) {
    throw fail("input-contract-invalid");
  }
  const withinDeadline = async (operation, reason, phase = reason, disposeLateResult = null) => {
    activationPhase = phase;
    const startedAt = performance.now();
    if (!Number.isFinite(startedAt) || startedAt >= deadline) throw fail("activation-deadline");
    const remaining = deadline - startedAt;
    let timer;
    const pending = Promise.resolve().then(operation);
    let raceFinished = false;
    let resultAccepted = false;
    if (disposeLateResult !== null) {
      pending
        .then((result) => {
          if (raceFinished && !resultAccepted) return disposeLateResult(result);
          return undefined;
        })
        .catch(() => {});
    }
    pending.catch(() => {});
    try {
      const result = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(fail(reason)), remaining);
        }),
      ]);
      raceFinished = true;
      const settledAt = performance.now();
      if (!Number.isFinite(settledAt) || settledAt >= deadline) {
        await disposeLateResult?.(result);
        throw fail(reason);
      }
      resultAccepted = true;
      return result;
    } catch (error) {
      raceFinished = true;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const observe = () =>
    withinDeadline(
      () => observeAuthorityReceipt(page, keyHex, processIdentity),
      "authority-observation-timeout",
    );
  await withinDeadline(() => page.bringToFront(), "page-activation-timeout", "bring-to-front");
  let before = await observe();
  if (before?.semanticPaneId !== expectedPane) throw fail("surface-identity-invalid");
  const exactDaemonGeneration = (observed) => {
    const generation = observed?.generation;
    return exactDaemonInstanceId(generation) &&
      observed?.workspaceEvidence?.authority?.generation === generation &&
      observed?.workspaceEvidence?.target?.daemon?.instanceId === generation
      ? generation
      : null;
  };
  if (exactDaemonGeneration(before) === null) throw fail("activation-lifecycle-invalid");
  const lifecycleIdentity = (observed) => {
    const lifecycle = observed?.runtimeReplacement?.currentLifecycleRequest;
    if (
      lifecycle?.status === "missing" &&
      lifecycle.requestHmac === null &&
      lifecycle.activeCount === 0 &&
      lifecycle.overflow === false &&
      lifecycle.descriptorCount === 0
    ) {
      return Object.freeze({
        status: "missing",
        requestHmac: null,
        activeCount: 0,
        descriptorCount: 0,
        overflow: false,
      });
    }
    if (
      lifecycle?.status === "exact" &&
      HASH.test(lifecycle.requestHmac ?? "") &&
      HASH.test(lifecycle.paneSetHmac ?? "") &&
      lifecycle.physicalBindingExact === true &&
      HASH.test(lifecycle.physicalEpochHmac ?? "") &&
      lifecycle.activeCount === 1 &&
      lifecycle.overflow === false &&
      lifecycle.descriptorCount === 1
    ) {
      return Object.freeze({
        status: "exact",
        requestHmac: lifecycle.requestHmac,
        paneSetHmac: lifecycle.paneSetHmac,
        activeCount: 1,
        descriptorCount: 1,
        overflow: false,
      });
    }
    return null;
  };
  const samePhysicalBinding = (observed) =>
    observed?.semanticPaneId === before.semanticPaneId &&
    observed?.workspaceName === before.workspaceName &&
    Number.isSafeInteger(before?.workspaceEvidence?.generation) &&
    before.workspaceEvidence.generation >= 0 &&
    Number.isSafeInteger(observed?.workspaceEvidence?.generation) &&
    observed.workspaceEvidence.generation === before.workspaceEvidence.generation &&
    exactDaemonGeneration(observed) === exactDaemonGeneration(before) &&
    observed?.generation === before.generation &&
    observed?.processIdentity === before.processIdentity &&
    JSON.stringify(observed?.workspaceEvidence?.target) ===
      JSON.stringify(before.workspaceEvidence?.target);
  let beforeLifecycle;
  let stableBefore;
  let receiptBoundary;
  let activationRequestHmac;
  let activationPaneSetHmac;
  if (insertsInput) {
    let previousCandidate = null;
    let previousObserved = null;
    let highestReceiptCount = -1;
    let observedRequestHmac = null;
    let observedPaneSetHmac = null;
    let current = before;
    while (performance.now() < deadline) {
      if (!samePhysicalBinding(current)) throw fail("input-activation-binding-changed");
      const lifecycle = current?.runtimeReplacement?.currentLifecycleRequest;
      const identity = lifecycleIdentity(current);
      const count = current?.runtimeReplacement?.inputReceiptCount;
      activationLifecycleAxes = Object.freeze({
        status:
          typeof lifecycle?.status === "string" && lifecycle.status.length <= 16
            ? lifecycle.status
            : "invalid",
        activeCount: Number.isSafeInteger(lifecycle?.activeCount)
          ? Math.min(8, Math.max(0, lifecycle.activeCount))
          : null,
        descriptorCount: Number.isSafeInteger(lifecycle?.descriptorCount)
          ? Math.min(8, Math.max(0, lifecycle.descriptorCount))
          : null,
        overflow: lifecycle?.overflow === true,
        rawActiveCount: Number.isSafeInteger(lifecycle?.rawActiveCount)
          ? Math.min(8, Math.max(0, lifecycle.rawActiveCount))
          : null,
        rawDescriptorCount: Number.isSafeInteger(lifecycle?.rawDescriptorCount)
          ? Math.min(8, Math.max(0, lifecycle.rawDescriptorCount))
          : null,
        physicalBindingExact: lifecycle?.physicalBindingExact === true,
        physicalBindingAxes: Object.freeze({
          present: lifecycle?.physicalBindingAxes?.present === true,
          epochSafe: lifecycle?.physicalBindingAxes?.epochSafe === true,
          generationExact: lifecycle?.physicalBindingAxes?.generationExact === true,
          runtimeSessionExact: lifecycle?.physicalBindingAxes?.runtimeSessionExact === true,
          workspaceExact: lifecycle?.physicalBindingAxes?.workspaceExact === true,
          paneExact: lifecycle?.physicalBindingAxes?.paneExact === true,
          stageExact: lifecycle?.physicalBindingAxes?.stageExact === true,
          clientExact: lifecycle?.physicalBindingAxes?.clientExact === true,
          epochActiveCount: Number.isSafeInteger(lifecycle?.physicalBindingAxes?.epochActiveCount)
            ? Math.min(8, Math.max(0, lifecycle.physicalBindingAxes.epochActiveCount))
            : null,
          bindingRequestExact: lifecycle?.physicalBindingAxes?.bindingRequestExact === true,
          descriptorExact: lifecycle?.physicalBindingAxes?.descriptorExact === true,
        }),
        physicalEpochHmacValid: HASH.test(lifecycle?.physicalEpochHmac ?? ""),
        bindingRequestHmacValid: HASH.test(lifecycle?.bindingRequestHmac ?? ""),
        bindingClientHmacValid: HASH.test(lifecycle?.bindingClientHmac ?? ""),
        activeTail: Object.freeze(
          Array.isArray(lifecycle?.activeTail)
            ? lifecycle.activeTail.slice(-2).map((request) =>
                Object.freeze({
                  ordinal: Number.isSafeInteger(request?.ordinal) ? request.ordinal : null,
                  epochHmacValid: HASH.test(request?.epochHmac ?? ""),
                  generationHmacValid: HASH.test(request?.generationHmac ?? ""),
                  requestHmacValid: HASH.test(request?.requestHmac ?? ""),
                  workspaceHmacValid: HASH.test(request?.workspaceHmac ?? ""),
                  paneSetHmacValid: HASH.test(request?.paneSetHmac ?? ""),
                }),
              )
            : [],
        ),
        lifecycleTail: Object.freeze(
          Array.isArray(lifecycle?.lifecycleTail)
            ? lifecycle.lifecycleTail.slice(-2).map((event) =>
                Object.freeze({
                  stage:
                    typeof event?.stage === "string" && event.stage.length <= 24
                      ? event.stage
                      : "invalid",
                  code:
                    typeof event?.code === "string" && event.code.length <= 64
                      ? event.code
                      : "invalid",
                  epochHmacValid: HASH.test(event?.epochHmac ?? ""),
                  ordinal: Number.isSafeInteger(event?.ordinal) ? event.ordinal : null,
                }),
              )
            : [],
        ),
        countValid: Number.isSafeInteger(count) && count >= 0,
        requestHmacValid: HASH.test(lifecycle?.requestHmac ?? ""),
      });
      if (!Number.isSafeInteger(count) || count < 0) throw fail("input-receipt-boundary-invalid");
      if (count < highestReceiptCount) throw fail("input-receipt-boundary-regressed");
      highestReceiptCount = count;
      if (lifecycle?.status === "overflow") throw fail("activation-lifecycle-overflow");
      if (lifecycle?.status === "ambiguous") throw fail("activation-lifecycle-ambiguous");
      if (identity === null) throw fail("activation-lifecycle-invalid");
      if (identity?.status === "exact") {
        if (observedRequestHmac !== null && observedRequestHmac !== identity.requestHmac)
          throw fail("input-activation-request-changed");
        if (observedPaneSetHmac !== null && observedPaneSetHmac !== identity.paneSetHmac)
          throw fail("input-activation-pane-set-changed");
        observedRequestHmac = identity.requestHmac;
        observedPaneSetHmac = identity.paneSetHmac;
        const candidate = JSON.stringify({
          requestHmac: identity.requestHmac,
          paneSetHmac: identity.paneSetHmac,
          count,
        });
        if (candidate === previousCandidate) {
          before = previousObserved;
          stableBefore = current;
          beforeLifecycle = identity;
          activationRequestHmac = identity.requestHmac;
          activationPaneSetHmac = identity.paneSetHmac;
          receiptBoundary = count;
          break;
        }
        previousCandidate = candidate;
        previousObserved = current;
      } else {
        previousCandidate = null;
        previousObserved = null;
      }
      await withinDeadline(
        () => new Promise((resolveWait) => setTimeout(resolveWait, 5)),
        "input-activation-request-timeout",
        "input-lifecycle-readiness",
      );
      current = await observe();
    }
    if (stableBefore === undefined) throw fail("input-activation-request-timeout");
  } else {
    beforeLifecycle = lifecycleIdentity(before);
    if (beforeLifecycle === null) {
      const status = before?.runtimeReplacement?.currentLifecycleRequest?.status;
      throw fail(
        status === "overflow"
          ? "activation-lifecycle-overflow"
          : status === "ambiguous"
            ? "activation-lifecycle-ambiguous"
            : "activation-lifecycle-invalid",
      );
    }
    activationRequestHmac = beforeLifecycle.requestHmac;
    activationPaneSetHmac = beforeLifecycle.paneSetHmac;
    receiptBoundary = before?.runtimeReplacement?.inputReceiptCount;
    stableBefore = await observe();
    if (
      !samePhysicalBinding(stableBefore) ||
      JSON.stringify(lifecycleIdentity(stableBefore)) !== JSON.stringify(beforeLifecycle)
    ) {
      throw fail("activation-binding-unstable");
    }
  }
  const sameBinding = (observed) =>
    samePhysicalBinding(observed) &&
    JSON.stringify(lifecycleIdentity(observed)) === JSON.stringify(beforeLifecycle);
  const samePreInputBinding = (observed) =>
    sameBinding(observed) && observed?.runtimeReplacement?.inputReceiptCount === receiptBoundary;
  const surfaces = page.locator(".terminal-surface[data-phase='connected']");
  const retainedHandles = new Set();
  let deferRetainedHandleDisposal = false;
  let deferredRetainedHandleTrigger = null;
  const disposeHandles = (handles) =>
    Promise.allSettled(
      (Array.isArray(handles) ? handles : []).map((handle) =>
        Promise.resolve().then(() => handle?.dispose?.()),
      ),
    );
  const disposeHandle = (handle) => Promise.resolve().then(() => handle?.dispose?.());
  const surfaceHandles = await withinDeadline(
    () => surfaces.elementHandles(),
    "surface-observation-timeout",
    "surface-handle-snapshot",
    disposeHandles,
  );
  surfaceHandles.forEach((handle) => retainedHandles.add(handle));
  try {
    const exactSurfaceHandles = [];
    for (const handle of surfaceHandles) {
      const exact = await withinDeadline(
        () =>
          handle.evaluate(
            (surface, exactPane) =>
              surface instanceof globalThis.HTMLElement &&
              surface.isConnected &&
              surface.getAttribute("data-phase") === "connected" &&
              surface.getAttribute("data-semantic-pane-id") === exactPane,
            expectedPane,
          ),
        "surface-observation-timeout",
        "surface-handle-qualification",
      );
      if (exact) exactSurfaceHandles.push(handle);
    }
    if (exactSurfaceHandles.length !== 1) throw fail("surface-handle-cardinality-invalid");
    const exactSurfaceHandle = exactSurfaceHandles[0];
    const areaJsHandle = await withinDeadline(
      () =>
        exactSurfaceHandle.evaluateHandle((surface) =>
          surface instanceof globalThis.HTMLElement ? surface.closest(".tiled-pane-area") : null,
        ),
      "surface-observation-timeout",
      "pointer-area-resolution",
      disposeHandle,
    );
    retainedHandles.add(areaJsHandle);
    const areaHandle = areaJsHandle.asElement();
    if (areaHandle === null) throw fail("pointer-target-cardinality-invalid");
    retainedHandles.add(areaHandle);
    const pointerTargetJsHandle = await withinDeadline(
      () =>
        exactSurfaceHandle.evaluateHandle(
          (surface, { area, exactPane }) => {
            if (!(surface instanceof globalThis.HTMLElement)) return null;
            if (
              !(area instanceof globalThis.HTMLElement) ||
              area.isConnected !== true ||
              surface.closest(".tiled-pane-area") !== area
            )
              return null;
            const paneCount = Number(area.getAttribute("data-pane-count"));
            const exactSurfaces = [
              ...globalThis.document.querySelectorAll(".terminal-surface[data-phase='connected']"),
            ].filter((candidate) => candidate.getAttribute("data-semantic-pane-id") === exactPane);
            if (exactSurfaces.length !== 1 || exactSurfaces[0] !== surface) return null;
            const composedBodies = [
              ...area.querySelectorAll(
                ":scope > .tiled-pane-area__overlay > .pane-tile[data-composed='true'] > .pane-tile__body",
              ),
            ];
            if (area.getAttribute("data-pane-compositor") === "true") {
              const composedPanes = composedBodies.map((body) =>
                body.parentElement?.getAttribute("data-pane"),
              );
              if (
                !Number.isSafeInteger(paneCount) ||
                paneCount <= 1 ||
                composedBodies.length !== paneCount ||
                composedPanes.some((pane) => typeof pane !== "string") ||
                new Set(composedPanes).size !== paneCount
              )
                return null;
              const matchingBodies = composedBodies.filter(
                (body) => body.parentElement?.getAttribute("data-pane") === exactPane,
              );
              return matchingBodies.length === 1 ? matchingBodies[0] : null;
            }
            return area.getAttribute("data-pane-compositor") === "false" &&
              paneCount === 1 &&
              composedBodies.length === 0
              ? surface
              : null;
          },
          { area: areaHandle, exactPane: expectedPane },
        ),
      "surface-observation-timeout",
      "pointer-target-resolution",
      disposeHandle,
    );
    retainedHandles.add(pointerTargetJsHandle);
    const pointerTargetHandle = pointerTargetJsHandle.asElement();
    if (pointerTargetHandle === null) throw fail("pointer-target-cardinality-invalid");
    retainedHandles.add(pointerTargetHandle);
    const observePointerTarget = () =>
      withinDeadline(
        () =>
          pointerTargetHandle.evaluate(
            (target, { surface, area, exactPane }) => {
              if (
                !(target instanceof globalThis.HTMLElement) ||
                !(surface instanceof globalThis.HTMLElement) ||
                !(area instanceof globalThis.HTMLElement) ||
                area.isConnected !== true
              )
                return null;
              if (
                surface.closest(".tiled-pane-area") !== area ||
                target.closest(".tiled-pane-area") !== area
              )
                return null;
              const paneCount = Number(area.getAttribute("data-pane-count"));
              const exactSurfaces = [
                ...globalThis.document.querySelectorAll(
                  ".terminal-surface[data-phase='connected']",
                ),
              ].filter(
                (candidate) => candidate.getAttribute("data-semantic-pane-id") === exactPane,
              );
              const composedBodies = [
                ...area.querySelectorAll(
                  ":scope > .tiled-pane-area__overlay > .pane-tile[data-composed='true'] > .pane-tile__body",
                ),
              ];
              const compositor = area.getAttribute("data-pane-compositor") === "true";
              const kind = compositor ? "compositor-pane-body" : "single-pane-surface";
              const matchingBodies = composedBodies.filter(
                (body) => body.parentElement?.getAttribute("data-pane") === exactPane,
              );
              const composedPanes = composedBodies.map((body) =>
                body.parentElement?.getAttribute("data-pane"),
              );
              const identityExact = compositor
                ? paneCount > 1 &&
                  composedBodies.length === paneCount &&
                  composedPanes.every((pane) => typeof pane === "string") &&
                  new Set(composedPanes).size === paneCount &&
                  matchingBodies.length === 1 &&
                  matchingBodies[0] === target
                : area.getAttribute("data-pane-compositor") === "false" &&
                  paneCount === 1 &&
                  composedBodies.length === 0 &&
                  target === surface;
              if (exactSurfaces.length !== 1 || exactSurfaces[0] !== surface || !identityExact)
                return null;
              const rect = target.getBoundingClientRect();
              const style = globalThis.getComputedStyle(target);
              const hit = globalThis.document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              const axes = Object.freeze({
                connected: target.isConnected === true && surface.isConnected === true,
                visible:
                  style.display !== "none" &&
                  style.visibility !== "hidden" &&
                  Number(style.opacity) > 0,
                nonempty:
                  Number.isFinite(rect.width) &&
                  Number.isFinite(rect.height) &&
                  rect.width > 0 &&
                  rect.height > 0,
                hitTarget:
                  hit === target || (hit instanceof globalThis.Node && target.contains(hit)),
              });
              return {
                kind,
                paneCount,
                axes,
                rect: [rect.left, rect.top, rect.width, rect.height].map((value) =>
                  Math.round(value * 1000),
                ),
              };
            },
            { surface: exactSurfaceHandle, area: areaHandle, exactPane: expectedPane },
          ),
        "surface-observation-timeout",
        "pointer-target-observation",
      );
    const selectedTarget = await observePointerTarget();
    if (selectedTarget === null) throw fail("pointer-target-cardinality-invalid");
    activationTargetKind = selectedTarget.kind;
    activationTargetAxes = Object.freeze(selectedTarget.axes);
    if (Object.values(selectedTarget.axes).some((value) => value !== true))
      throw fail("pointer-target-actionability-invalid");
    let dispatchGuardHandle = null;
    try {
      if (!(insertsInput ? samePreInputBinding(await observe()) : sameBinding(await observe())))
        throw fail("activation-binding-unstable");
      dispatchGuardHandle = await withinDeadline(
        () =>
          pointerTargetHandle.evaluateHandle(
            (target, { surface, area, exactPane, keyHex: pointerKeyHex }) => {
              if (
                !(target instanceof globalThis.HTMLElement) ||
                !(surface instanceof globalThis.HTMLElement) ||
                !(area instanceof globalThis.HTMLElement)
              )
                return null;
              const outcome = {
                dispatched: false,
                trusted: false,
                buttonExact: false,
                pathExact: false,
                allowed: false,
                mutationCount: 0,
                mutationOverflow: false,
                eventCount: 0,
                eventOverflow: false,
                rejected: false,
                mutationCategories: {
                  identityNode: 0,
                  areaDescendant: 0,
                  terminalAttribute: 0,
                  paneAttribute: 0,
                  childList: 0,
                  inspectionOverflow: 0,
                },
                mutationTail: [],
                current: {
                  areaConnected: false,
                  surfaceConnected: false,
                  targetConnected: false,
                  surfaceAreaExact: false,
                  targetAreaExact: false,
                  surfaceCardinalityExact: false,
                  compositorExact: false,
                  topologyExact: false,
                },
              };
              let active = true;
              let mutationInspectionCount = 0;
              let relevantCategory = null;
              const touchesIdentity = (record) => {
                relevantCategory = null;
                mutationInspectionCount += 1;
                if (mutationInspectionCount > 256) {
                  outcome.mutationOverflow = true;
                  relevantCategory = "inspectionOverflow";
                  return true;
                }
                const node = record.target;
                if (node === area || node === surface || node === target) {
                  relevantCategory = "identityNode";
                  return true;
                }
                if (node instanceof globalThis.Node && area.contains(node)) {
                  relevantCategory = "areaDescendant";
                  return true;
                }
                if (
                  record.type === "attributes" &&
                  node instanceof globalThis.HTMLElement &&
                  node.matches(".terminal-surface") &&
                  ((record.attributeName === "data-semantic-pane-id" &&
                    (record.oldValue === exactPane ||
                      node.getAttribute("data-semantic-pane-id") === exactPane)) ||
                    (record.attributeName === "data-phase" &&
                      (record.oldValue === "connected" ||
                        node.getAttribute("data-phase") === "connected")))
                ) {
                  relevantCategory = "terminalAttribute";
                  return true;
                }
                if (
                  record.type === "attributes" &&
                  node instanceof globalThis.HTMLElement &&
                  node.matches(".pane-tile[data-composed='true']") &&
                  record.attributeName === "data-pane" &&
                  (record.oldValue === exactPane || node.getAttribute("data-pane") === exactPane)
                ) {
                  relevantCategory = "paneAttribute";
                  return true;
                }
                const changed = [...record.addedNodes, ...record.removedNodes];
                for (const entry of changed) {
                  if (entry === area || entry === surface || entry === target) {
                    relevantCategory = "childList";
                    return true;
                  }
                  if (!(entry instanceof globalThis.HTMLElement)) continue;
                  if (
                    area.contains(entry) ||
                    entry.contains(area) ||
                    entry.contains(surface) ||
                    entry.contains(target)
                  ) {
                    relevantCategory = "childList";
                    return true;
                  }
                  const descendants = [entry];
                  let inspected = 0;
                  while (descendants.length > 0) {
                    const descendant = descendants.pop();
                    inspected += 1;
                    if (inspected > 64) {
                      outcome.mutationOverflow = true;
                      relevantCategory = "inspectionOverflow";
                      return true;
                    }
                    if (
                      descendant.matches(".terminal-surface") &&
                      descendant.getAttribute("data-semantic-pane-id") === exactPane
                    ) {
                      relevantCategory = "childList";
                      return true;
                    }
                    for (const child of descendant.children) {
                      if (descendants.length + inspected >= 64) {
                        outcome.mutationOverflow = true;
                        relevantCategory = "inspectionOverflow";
                        return true;
                      }
                      descendants.push(child);
                    }
                  }
                }
                return false;
              };
              const retainMutations = (records) => {
                for (const record of records) {
                  if (outcome.mutationOverflow) break;
                  if (!touchesIdentity(record)) continue;
                  if (outcome.mutationCount >= 64) outcome.mutationOverflow = true;
                  else {
                    outcome.mutationCount += 1;
                    const category = relevantCategory ?? "inspectionOverflow";
                    outcome.mutationCategories[category] = Math.min(
                      64,
                      outcome.mutationCategories[category] + 1,
                    );
                    outcome.mutationTail.push({
                      type: record.type,
                      attribute: record.type === "attributes" ? record.attributeName : null,
                      relevance: `${category}\0${record.type}\0${record.attributeName ?? ""}`,
                    });
                    if (outcome.mutationTail.length > 2) outcome.mutationTail.shift();
                  }
                }
              };
              const observer = new globalThis.MutationObserver((records) =>
                retainMutations(records),
              );
              observer.observe(globalThis.document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeOldValue: true,
                attributeFilter: [
                  "data-composed",
                  "data-pane",
                  "data-pane-compositor",
                  "data-pane-count",
                  "data-phase",
                  "data-semantic-pane-id",
                ],
              });
              const stop = () => {
                if (!active) return;
                active = false;
                globalThis.document.removeEventListener("pointerdown", onPointerDown, true);
                for (const type of ["pointerup", "pointercancel", "click", "mousedown", "mouseup"])
                  globalThis.document.removeEventListener(type, onPoisonedGesture, true);
                observer.disconnect();
              };
              const retainEvent = () => {
                if (outcome.eventCount >= 8) outcome.eventOverflow = true;
                else outcome.eventCount += 1;
              };
              const onPoisonedGesture = (event) => {
                if (!active || outcome.rejected !== true) return;
                retainEvent();
                event.preventDefault();
                event.stopImmediatePropagation();
              };
              const onPointerDown = (event) => {
                if (!active) return;
                retainEvent();
                outcome.dispatched = true;
                outcome.trusted = event.isTrusted === true;
                outcome.buttonExact = event.button === 0;
                retainMutations(observer.takeRecords());
                const exactSurfaces = [
                  ...globalThis.document.querySelectorAll(
                    ".terminal-surface[data-phase='connected']",
                  ),
                ].filter(
                  (candidate) => candidate.getAttribute("data-semantic-pane-id") === exactPane,
                );
                const composedBodies = [
                  ...area.querySelectorAll(
                    ":scope > .tiled-pane-area__overlay > .pane-tile[data-composed='true'] > .pane-tile__body",
                  ),
                ];
                const paneCount = Number(area.getAttribute("data-pane-count"));
                const compositor = area.getAttribute("data-pane-compositor") === "true";
                const composedPanes = composedBodies.map((body) =>
                  body.parentElement?.getAttribute("data-pane"),
                );
                const matchingBodies = composedBodies.filter(
                  (body) => body.parentElement?.getAttribute("data-pane") === exactPane,
                );
                const topologyExact = compositor
                  ? paneCount > 1 &&
                    composedBodies.length === paneCount &&
                    composedPanes.every((pane) => typeof pane === "string") &&
                    new Set(composedPanes).size === paneCount &&
                    matchingBodies.length === 1 &&
                    matchingBodies[0] === target
                  : area.getAttribute("data-pane-compositor") === "false" &&
                    paneCount === 1 &&
                    composedBodies.length === 0 &&
                    target === surface;
                const path = event.composedPath();
                outcome.pathExact = path.includes(target);
                outcome.current = {
                  areaConnected: area.isConnected === true,
                  surfaceConnected: surface.isConnected === true,
                  targetConnected: target.isConnected === true,
                  surfaceAreaExact: surface.closest(".tiled-pane-area") === area,
                  targetAreaExact: target.closest(".tiled-pane-area") === area,
                  surfaceCardinalityExact:
                    exactSurfaces.length === 1 && exactSurfaces[0] === surface,
                  compositorExact: compositor ? target !== surface : target === surface,
                  topologyExact,
                };
                const allowed =
                  event.button === 0 &&
                  outcome.trusted &&
                  outcome.rejected === false &&
                  outcome.eventOverflow === false &&
                  outcome.mutationCount === 0 &&
                  outcome.mutationOverflow === false &&
                  area.isConnected === true &&
                  surface.isConnected === true &&
                  target.isConnected === true &&
                  surface.closest(".tiled-pane-area") === area &&
                  target.closest(".tiled-pane-area") === area &&
                  exactSurfaces.length === 1 &&
                  exactSurfaces[0] === surface &&
                  topologyExact &&
                  outcome.pathExact;
                if (allowed) {
                  outcome.allowed = true;
                  stop();
                } else {
                  outcome.rejected = true;
                  event.preventDefault();
                  event.stopImmediatePropagation();
                }
              };
              globalThis.document.addEventListener("pointerdown", onPointerDown, true);
              for (const type of ["pointerup", "pointercancel", "click", "mousedown", "mouseup"])
                globalThis.document.addEventListener(type, onPoisonedGesture, true);
              return {
                async finish() {
                  retainMutations(observer.takeRecords());
                  stop();
                  const key = await globalThis.crypto.subtle.importKey(
                    "raw",
                    Uint8Array.from(pointerKeyHex.match(/.{2}/gu), (byte) =>
                      Number.parseInt(byte, 16),
                    ),
                    { name: "HMAC", hash: "SHA-256" },
                    false,
                    ["sign"],
                  );
                  const mutationTail = await Promise.all(
                    outcome.mutationTail.map(async ({ type, attribute, relevance }) => ({
                      type,
                      attribute,
                      relevanceHmac: [
                        ...new Uint8Array(
                          await globalThis.crypto.subtle.sign(
                            "HMAC",
                            key,
                            new TextEncoder().encode(`card5-pointer-mutation\0${relevance}`),
                          ),
                        ),
                      ]
                        .map((byte) => byte.toString(16).padStart(2, "0"))
                        .join(""),
                    })),
                  );
                  return Object.freeze({ ...outcome, mutationTail });
                },
              };
            },
            {
              surface: exactSurfaceHandle,
              area: areaHandle,
              exactPane: expectedPane,
              keyHex,
            },
          ),
        "surface-observation-timeout",
        "trusted-pointer-dispatch-guard",
        disposeHandle,
      );
      retainedHandles.add(dispatchGuardHandle);
      const immediateTarget = await observePointerTarget();
      if (JSON.stringify(immediateTarget) !== JSON.stringify(selectedTarget))
        throw fail("pointer-target-changed");
      const clickRemaining = deadline - performance.now();
      if (!Number.isFinite(clickRemaining) || clickRemaining <= 25) {
        activationPhase = "trusted-pointer";
        throw fail("trusted-pointer-deadline");
      }
      await withinDeadline(
        () =>
          pointerTargetHandle.click({
            timeout: Math.max(1, Math.floor(clickRemaining - 25)),
          }),
        "trusted-pointer-deadline",
        "trusted-pointer",
      );
      const dispatchOutcome = await withinDeadline(
        () => dispatchGuardHandle.evaluate((guard) => guard?.finish?.() ?? null),
        "trusted-pointer-deadline",
        "trusted-pointer-dispatch-fence",
      );
      dispatchGuardHandle = null;
      activationPointerDispatchAxes = boundedCard5PointerDispatchAxes(dispatchOutcome);
      activationPointerDispatchReason = card5PointerDispatchFailureReason(
        activationPointerDispatchAxes,
      );
      if (
        dispatchOutcome?.dispatched !== true ||
        dispatchOutcome.trusted !== true ||
        dispatchOutcome.allowed !== true ||
        dispatchOutcome.mutationCount !== 0 ||
        dispatchOutcome.mutationOverflow !== false ||
        dispatchOutcome.eventOverflow !== false ||
        dispatchOutcome.rejected !== false
      )
        throw fail("trusted-pointer-topology-rejected");
    } catch (cause) {
      if (cause?.observation?.operation === "card5-web-terminal-focus") throw cause;
      if (cause?.name === "TimeoutError")
        throw fail("trusted-pointer-actionability-timeout", cause);
      throw fail("trusted-pointer-rejected", cause);
    } finally {
      if (dispatchGuardHandle !== null) {
        await Promise.resolve()
          .then(() => dispatchGuardHandle.evaluate((guard) => guard?.finish?.() ?? null))
          .catch(() => {});
      }
    }
    const exactXtermFocused = () =>
      withinDeadline(
        () =>
          exactSurfaceHandle.evaluate((surface, exactPane) => {
            if (!(surface instanceof globalThis.HTMLElement)) return false;
            const active = globalThis.document.activeElement;
            return (
              surface.isConnected &&
              surface.getAttribute("data-phase") === "connected" &&
              surface.getAttribute("data-semantic-pane-id") === exactPane &&
              active instanceof globalThis.HTMLTextAreaElement &&
              active.classList.contains("xterm-helper-textarea") &&
              surface.contains(active)
            );
          }, expectedPane),
        "focus-observation-timeout",
      );
    const focused = await exactXtermFocused();
    if (!focused) throw fail("xterm-focus-invalid");
    const pointerTargetUnchanged = async () => {
      const observed = await observePointerTarget();
      return JSON.stringify(observed) === JSON.stringify(selectedTarget);
    };
    if (!(await pointerTargetUnchanged())) throw fail("pointer-target-changed");
    const afterClick = await observe();
    if (!(insertsInput ? samePreInputBinding(afterClick) : sameBinding(afterClick)))
      throw fail("surface-binding-changed");
    if (!(await pointerTargetUnchanged())) throw fail("pointer-target-changed");
    if (!(await exactXtermFocused())) throw fail("xterm-focus-changed");
    if (!insertsInput) {
      const completedAt = performance.now();
      if (!Number.isFinite(completedAt) || completedAt >= deadline)
        throw fail("activation-deadline");
      return Object.freeze({
        before: Object.freeze({
          workspaceName: before.workspaceName,
          semanticPaneId: before.semanticPaneId,
          generation: before.generation,
          target: before.workspaceEvidence.target,
        }),
        after: Object.freeze({
          workspaceName: afterClick.workspaceName,
          semanticPaneId: afterClick.semanticPaneId,
          generation: afterClick.generation,
          target: afterClick.workspaceEvidence.target,
        }),
        receiptBoundary: null,
        requestHmac: activationRequestHmac,
        authorityClientId: null,
        receiptOrdinal: null,
      });
    }
    if (!(await exactXtermFocused())) throw fail("pre-input-focus-changed");
    const preInsert = await observe();
    if (!samePreInputBinding(preInsert)) throw fail("pre-input-receipt-boundary-changed");
    if (!(await pointerTargetUnchanged())) throw fail("pre-input-target-changed");
    const inputTextareaHandle = await withinDeadline(
      () =>
        exactSurfaceHandle.evaluateHandle((surface, exactPane) => {
          const active = globalThis.document.activeElement;
          return surface.isConnected &&
            surface.getAttribute("data-phase") === "connected" &&
            surface.getAttribute("data-semantic-pane-id") === exactPane &&
            active instanceof globalThis.HTMLTextAreaElement &&
            active.classList.contains("xterm-helper-textarea") &&
            surface.contains(active)
            ? active
            : null;
        }, expectedPane),
      "pre-input-focus-changed",
      "input-textarea-latch",
      disposeHandle,
    );
    retainedHandles.add(inputTextareaHandle);
    if (inputTextareaHandle.asElement() === null) throw fail("pre-input-focus-changed");
    const inputReceiptWaiterHandle = await withinDeadline(
      () =>
        inputTextareaHandle.evaluateHandle(
          async (
            textarea,
            {
              surface,
              exactPane,
              expectedWorkspace,
              expectedGeneration,
              expectedSession,
              expectedClientGeneration,
              expectedTarget,
              expectedRequestHmac,
              expectedPaneSetHmac,
              expectedInputSha,
              baselineCount,
              keyHex,
              paneIdPattern,
              paneIdReserved,
              paneIdDiscoveredPrefix,
              reserveMs,
            },
          ) => {
            const invalid = { status: "input-receipt-invalid", settled: true };
            if (
              !(textarea instanceof globalThis.HTMLTextAreaElement) ||
              !(surface instanceof globalThis.HTMLElement) ||
              !Number.isSafeInteger(baselineCount) ||
              baselineCount < 0 ||
              !Number.isFinite(reserveMs) ||
              reserveMs < 4_000
            )
              return { browserArmSample: globalThis.performance.now(), invalid };
            const bytes = Uint8Array.from(keyHex.match(/../gu) ?? [], (byte) =>
              Number.parseInt(byte, 16),
            );
            const cryptoKey = await globalThis.crypto.subtle.importKey(
              "raw",
              bytes,
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            );
            const hmac = async (domain, value) =>
              [
                ...new Uint8Array(
                  await globalThis.crypto.subtle.sign(
                    "HMAC",
                    cryptoKey,
                    new TextEncoder().encode(`${domain}\0${value}`),
                  ),
                ),
              ]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
            const envelope = globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?.();
            const snapshot = globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__?.()?.snapshot;
            const binding = envelope?.currentPhysicalBinding;
            const workspaceName = surface.getAttribute("data-workspace-name");
            // The immediately preceding lightweight observation authenticated the
            // exact request HMAC and binding-request equality. Capture its raw
            // request only to join the later browser-local receipt without doing
            // another broad/HMAC-tail projection here.
            const requestExact =
              typeof expectedRequestHmac === "string" &&
              expectedRequestHmac.length === 64 &&
              typeof binding?.requestId === "string" &&
              binding.requestId.length > 0 &&
              binding.requestId.length <= 512 &&
              (await hmac("request", binding.requestId)) === expectedRequestHmac;
            const clientExact =
              typeof binding?.clientId === "string" &&
              Array.isArray(snapshot?.authority?.clients) &&
              snapshot.authority.clients.filter(
                (client) => client?.clientId === binding.clientId && client?.surface === "web",
              ).length === 1;
            const captured = {
              physicalEpoch: binding?.physicalEpoch,
              generation: binding?.generation,
              runtimeSession: binding?.runtimeSession,
              workspaceName: binding?.workspaceName,
              semanticPaneIds: Array.isArray(binding?.semanticPaneIds)
                ? [...binding.semanticPaneIds]
                : null,
              stage: binding?.stage,
              clientId: binding?.clientId,
              requestId: binding?.requestId,
            };
            const bindingPaneIds = binding?.semanticPaneIds;
            const paneIdRegex = new RegExp(`^(?:${paneIdPattern})$`, "u");
            const exactPaneId = (paneId) =>
              typeof paneId === "string" &&
              paneIdRegex.test(paneId) &&
              !paneIdReserved.includes(paneId) &&
              !paneId.startsWith(paneIdDiscoveredPrefix);
            const paneSetValue = (paneIds) =>
              `${paneIds.length}\0${paneIds
                .map((paneId) => `${paneId.length}\0${paneId}`)
                .join("")}`;
            const bindingPaneSetExact =
              Array.isArray(bindingPaneIds) &&
              bindingPaneIds.length > 0 &&
              bindingPaneIds.length <= 64 &&
              bindingPaneIds.every(exactPaneId) &&
              new Set(bindingPaneIds).size === bindingPaneIds.length &&
              JSON.stringify(bindingPaneIds) === JSON.stringify([...bindingPaneIds].sort()) &&
              bindingPaneIds.filter((paneId) => paneId === exactPane).length === 1;
            const bindingPaneSetHmacExact =
              bindingPaneSetExact &&
              typeof expectedPaneSetHmac === "string" &&
              expectedPaneSetHmac.length === 64 &&
              (await hmac("pane-set", paneSetValue([...bindingPaneIds].sort()))) ===
                expectedPaneSetHmac;
            const initial = {
              surfaceExact:
                surface.isConnected === true &&
                surface.getAttribute("data-phase") === "connected" &&
                surface.getAttribute("data-semantic-pane-id") === exactPane &&
                workspaceName === expectedWorkspace,
              textareaExact: surface.contains(textarea),
              focusExact: globalThis.document.activeElement === textarea,
              bindingEpochExact:
                Number.isSafeInteger(binding?.physicalEpoch) && binding.physicalEpoch > 0,
              bindingGenerationExact: binding?.generation === expectedGeneration,
              bindingSessionExact: binding?.runtimeSession === expectedSession,
              bindingWorkspaceExact: binding?.workspaceName === expectedWorkspace,
              bindingPaneExact: bindingPaneSetExact,
              bindingPaneSetHmacExact,
              bindingStageExact: binding?.stage === "first-seed",
              bindingClientExact: clientExact,
              bindingRequestExact: requestExact,
              authorityGenerationExact: snapshot?.authority?.generation === expectedGeneration,
              authoritySessionExact: snapshot?.authority?.session === expectedSession,
              clientGenerationExact: snapshot?.generation === expectedClientGeneration,
              targetExact: JSON.stringify(snapshot?.target) === expectedTarget,
              baselineCountSafe: Number.isSafeInteger(baselineCount) && baselineCount >= 0,
              currentCountSafe:
                Number.isSafeInteger(envelope?.inputReceiptCount) &&
                envelope.inputReceiptCount >= 0,
              currentCountExact: envelope?.inputReceiptCount === baselineCount,
              operationBoundarySafe:
                Number.isSafeInteger(envelope?.inputOperationCount) &&
                envelope.inputOperationCount >= 0,
            };
            const inputOperationBoundary = Number.isSafeInteger(envelope?.inputOperationCount)
              ? envelope.inputOperationCount
              : null;
            const initialExact =
              initial.surfaceExact &&
              initial.textareaExact &&
              initial.focusExact &&
              initial.bindingEpochExact &&
              initial.bindingGenerationExact &&
              initial.bindingSessionExact &&
              initial.bindingWorkspaceExact &&
              initial.bindingPaneExact &&
              initial.bindingPaneSetHmacExact &&
              initial.bindingStageExact &&
              initial.bindingClientExact &&
              initial.bindingRequestExact &&
              initial.authorityGenerationExact &&
              initial.authoritySessionExact &&
              initial.clientGenerationExact &&
              initial.targetExact &&
              initial.baselineCountSafe &&
              initial.currentCountSafe &&
              initial.currentCountExact &&
              initial.operationBoundarySafe;
            const state = {
              status: initialExact ? "pending" : "input-receipt-invalid",
              baselineCount,
              currentCount: Number.isSafeInteger(envelope?.inputReceiptCount)
                ? envelope.inputReceiptCount
                : null,
              candidateCount: 0,
              countRegressed: false,
              countAdvanced: false,
              surfaceExact: initialExact,
              textareaExact: initialExact,
              focusExact: initialExact,
              bindingExact: initialExact,
              generationExact: initialExact,
              sessionExact: initialExact,
              workspaceExact: initialExact,
              paneExact: initialExact,
              clientExact,
              requestExact,
              epochExact: initialExact,
              clientGenerationExact: initialExact,
              targetExact: initialExact,
              mutationCount: 0,
              mutationOverflow: false,
              authorityState: "null",
              timerCleared: false,
              settled: !initialExact,
              authorityClientId: null,
              receiptOrdinal: null,
              operationCount: 0,
              operationOverflow: false,
              operationTail: [],
            };
            let fixedDeadline = null;
            let dispatchAt = null;
            let authorityRequestAt = null;
            let inputSentAt = null;
            let timer = null;
            const recordMutations = (records) => {
              for (const record of records) {
                const changed = [...(record.addedNodes ?? []), ...(record.removedNodes ?? [])];
                const relevant =
                  record.target === surface ||
                  record.target === textarea ||
                  changed.some(
                    (node) =>
                      node === surface ||
                      node === textarea ||
                      (node instanceof globalThis.Node &&
                        (node.contains?.(surface) || node.contains?.(textarea))),
                  );
                if (!relevant) continue;
                if (state.mutationCount < 32) state.mutationCount += 1;
                else state.mutationOverflow = true;
              }
            };
            const observer = new globalThis.MutationObserver(recordMutations);
            observer.observe(globalThis.document.documentElement, {
              attributes: true,
              childList: true,
              subtree: true,
            });
            let resolveOutcome;
            const outcomePromise = new Promise((resolve) => {
              resolveOutcome = resolve;
            });
            const finish = (status = state.status) => {
              if (!state.settled) state.settled = true;
              state.status = status;
              if (timer !== null) globalThis.clearInterval(timer);
              timer = null;
              recordMutations(observer.takeRecords());
              observer.disconnect();
              state.timerCleared = true;
              resolveOutcome?.({ ...state });
              resolveOutcome = null;
              return { ...state };
            };
            if (!initialExact) finish("input-receipt-invalid");
            const poll = () => {
              if (state.settled || dispatchAt === null) return;
              const now = globalThis.performance.now();
              if (
                !Number.isFinite(now) ||
                !Number.isFinite(fixedDeadline) ||
                now >= fixedDeadline
              ) {
                finish(
                  authorityRequestAt === null
                    ? "input-authority-unobserved-timeout"
                    : "input-receipt-timeout",
                );
                return;
              }
              const nextEnvelope = globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?.();
              const nextSnapshot = globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__?.()?.snapshot;
              const nextBinding = nextEnvelope?.currentPhysicalBinding;
              recordMutations(observer.takeRecords());
              const sameBinding = JSON.stringify(nextBinding) === JSON.stringify(binding);
              state.surfaceExact =
                surface.isConnected === true &&
                surface.getAttribute("data-phase") === "connected" &&
                surface.getAttribute("data-workspace-name") === expectedWorkspace &&
                surface.getAttribute("data-semantic-pane-id") === exactPane;
              state.textareaExact = textarea.isConnected === true && surface.contains(textarea);
              state.focusExact = globalThis.document.activeElement === textarea;
              state.bindingExact = sameBinding;
              state.generationExact =
                nextBinding?.generation === captured.generation &&
                nextSnapshot?.authority?.generation === expectedGeneration;
              state.sessionExact =
                nextBinding?.runtimeSession === captured.runtimeSession &&
                nextSnapshot?.authority?.session === expectedSession;
              state.workspaceExact = nextBinding?.workspaceName === captured.workspaceName;
              state.paneExact =
                JSON.stringify(nextBinding?.semanticPaneIds) ===
                JSON.stringify(captured.semanticPaneIds);
              state.clientExact = nextBinding?.clientId === captured.clientId;
              state.requestExact = nextBinding?.requestId === captured.requestId;
              state.epochExact = nextBinding?.physicalEpoch === captured.physicalEpoch;
              state.clientGenerationExact = nextSnapshot?.generation === expectedClientGeneration;
              state.targetExact = JSON.stringify(nextSnapshot?.target) === expectedTarget;
              if (
                !state.surfaceExact ||
                !state.textareaExact ||
                !state.focusExact ||
                !state.bindingExact ||
                !state.generationExact ||
                !state.sessionExact ||
                !state.workspaceExact ||
                !state.paneExact ||
                !state.clientExact ||
                !state.requestExact ||
                !state.epochExact ||
                !state.clientGenerationExact ||
                !state.targetExact ||
                state.mutationCount !== 0 ||
                state.mutationOverflow
              ) {
                finish("input-receipt-invalid");
                return;
              }
              const nextInputOperationCount = nextEnvelope?.inputOperationCount;
              const inputOperationDelta =
                Number.isSafeInteger(inputOperationBoundary) &&
                Number.isSafeInteger(nextInputOperationCount)
                  ? nextInputOperationCount - inputOperationBoundary
                  : null;
              const rawOperationEvents =
                Number.isSafeInteger(inputOperationBoundary) &&
                Array.isArray(nextEnvelope?.inputOperations)
                  ? nextEnvelope.inputOperations.filter(
                      (event) =>
                        Number.isSafeInteger(event?.ordinal) &&
                        event.ordinal >= inputOperationBoundary,
                    )
                  : [];
              const operationEvents = rawOperationEvents.filter(
                (event) =>
                  event?.physicalEpoch === captured.physicalEpoch &&
                  event?.generation === captured.generation &&
                  event?.lifecycleRequestId === captured.requestId &&
                  (event?.pane === null || event?.pane === exactPane) &&
                  (event?.clientId === null || event?.clientId === captured.clientId),
              );
              const allowedOutcomes = {
                "xterm-enqueue": new Set(["ok"]),
                "surface-write": new Set(["attempt", "ok", "failed"]),
                "authority-request": new Set(["attempt", "sent", "send-failed"]),
                "authority-result": new Set([
                  "granted",
                  "rejected",
                  "authority-timeout",
                  "closed",
                  "unavailable",
                ]),
                "input-send": new Set(["attempt", "sent", "send-failed"]),
                "input-ack": new Set(["ok", "ack-timeout"]),
                "receipt-published": new Set(["ok"]),
              };
              const eventIndex = (stage, outcome) =>
                operationEvents.findIndex(
                  (event) => event.stage === stage && event.outcome === outcome,
                );
              const eventCount = (stage, outcome = null) =>
                operationEvents.filter(
                  (event) =>
                    event.stage === stage && (outcome === null || event.outcome === outcome),
                ).length;
              const authorityEvents = operationEvents.filter(
                (event) =>
                  event.stage === "authority-request" || event.stage === "authority-result",
              );
              const authorityIds = new Set(
                authorityEvents.map((event) => event.authorityRequestId),
              );
              const inputEvents = operationEvents.filter((event) =>
                ["input-send", "input-ack", "receipt-published"].includes(event.stage),
              );
              const inputSequences = new Set(inputEvents.map((event) => event.seq));
              const surfaceAttempt = eventIndex("surface-write", "attempt");
              const authorityAttempt = eventIndex("authority-request", "attempt");
              const authoritySent = eventIndex("authority-request", "sent");
              const authoritySendFailed = eventIndex("authority-request", "send-failed");
              const authorityGranted = eventIndex("authority-result", "granted");
              const authorityTerminal = operationEvents.findIndex(
                (event) =>
                  event.stage === "authority-result" &&
                  ["rejected", "authority-timeout", "closed", "unavailable"].includes(
                    event.outcome,
                  ),
              );
              const inputAttempt = eventIndex("input-send", "attempt");
              const inputSent = eventIndex("input-send", "sent");
              const inputSendFailed = eventIndex("input-send", "send-failed");
              const inputAck = eventIndex("input-ack", "ok");
              const inputAckTimeout = eventIndex("input-ack", "ack-timeout");
              const receiptPublished = eventIndex("receipt-published", "ok");
              const operationTokens = operationEvents.map(
                (event) => `${event.stage}/${event.outcome}`,
              );
              const base = ["xterm-enqueue/ok", "surface-write/attempt"];
              const authorityGrantedPath = [
                ...base,
                "authority-request/attempt",
                "authority-request/sent",
                "authority-result/granted",
              ];
              const inputSuccessTail = [
                "input-send/attempt",
                "input-send/sent",
                "input-ack/ok",
                "receipt-published/ok",
                "surface-write/ok",
              ];
              const inputBranches = (prefix) => [
                [...prefix, ...inputSuccessTail],
                [...prefix, "input-send/attempt", "input-send/send-failed"],
                [...prefix, "input-send/attempt", "input-send/send-failed", "surface-write/failed"],
                [...prefix, "input-send/attempt", "input-send/sent", "input-ack/ack-timeout"],
                [
                  ...prefix,
                  "input-send/attempt",
                  "input-send/sent",
                  "input-ack/ack-timeout",
                  "surface-write/failed",
                ],
                [
                  ...prefix,
                  "input-send/attempt",
                  "input-send/sent",
                  "input-ack/ok",
                  "surface-write/failed",
                ],
                [...prefix, "input-send/attempt", "input-send/sent", "surface-write/failed"],
              ];
              const operationBranches = [
                [...base, "surface-write/failed"],
                ...inputBranches(base),
                ...inputBranches(authorityGrantedPath),
                ...["rejected", "authority-timeout", "closed", "unavailable"].flatMap((outcome) => {
                  const terminal = [
                    ...base,
                    "authority-request/attempt",
                    "authority-request/sent",
                    `authority-result/${outcome}`,
                  ];
                  return [terminal, [...terminal, "surface-write/failed"]];
                }),
                [
                  ...base,
                  "authority-request/attempt",
                  "authority-result/closed",
                  "authority-request/send-failed",
                ],
                [
                  ...base,
                  "authority-request/attempt",
                  "authority-result/closed",
                  "authority-request/send-failed",
                  "surface-write/failed",
                ],
              ];
              const operationFsmExact =
                operationTokens.length === 0 ||
                operationBranches.some(
                  (branch) =>
                    operationTokens.length <= branch.length &&
                    operationTokens.every((token, index) => branch[index] === token),
                );
              const operationShapeExact =
                Number.isSafeInteger(inputOperationDelta) &&
                inputOperationDelta >= 0 &&
                inputOperationDelta <= 64 &&
                inputOperationDelta === rawOperationEvents.length &&
                rawOperationEvents.every(
                  (event, index) => event.ordinal === inputOperationBoundary + index,
                ) &&
                operationEvents.length === rawOperationEvents.length &&
                operationEvents.every(
                  (event) =>
                    Object.hasOwn(allowedOutcomes, event.stage) &&
                    allowedOutcomes[event.stage].has(event.outcome),
                ) &&
                operationEvents.every((event) => eventCount(event.stage, event.outcome) === 1) &&
                operationFsmExact &&
                authorityIds.size <= 1 &&
                !authorityIds.has(null) &&
                inputSequences.size <= 1 &&
                !inputSequences.has(null) &&
                (authorityEvents.length === 0 || authorityAttempt >= 2) &&
                (authoritySent < 0 ||
                  (authorityAttempt >= 0 && authoritySent > authorityAttempt)) &&
                (authoritySendFailed < 0 ||
                  (authorityAttempt >= 0 && authoritySendFailed > authorityAttempt)) &&
                (authorityGranted < 0 ||
                  (authoritySent >= 0 && authorityGranted > authoritySent)) &&
                (authorityTerminal < 0 ||
                  (authoritySent >= 0 && authorityTerminal > authoritySent) ||
                  (authoritySendFailed >= 0 && authorityTerminal < authoritySendFailed)) &&
                (inputAttempt < 0 ||
                  ((authorityEvents.length === 0 ||
                    (authorityGranted >= 0 && inputAttempt > authorityGranted)) &&
                    inputAttempt > surfaceAttempt)) &&
                (inputSent < 0 || (inputAttempt >= 0 && inputSent > inputAttempt)) &&
                (inputSendFailed < 0 || (inputAttempt >= 0 && inputSendFailed > inputAttempt)) &&
                (inputAck < 0 || (inputSent >= 0 && inputAck > inputSent)) &&
                (inputAckTimeout < 0 || (inputSent >= 0 && inputAckTimeout > inputSent)) &&
                (receiptPublished < 0 || (inputAck >= 0 && receiptPublished > inputAck));
              state.operationCount = Math.min(operationEvents.length, 64);
              state.operationOverflow = !operationShapeExact;
              const boundedOperationIdentity = (value) =>
                typeof value === "string" && value.length <= 512 ? value : null;
              state.operationTail = operationEvents.slice(-2).map((event) => ({
                ordinal: Number.isSafeInteger(event.ordinal) ? event.ordinal : null,
                stage: event.stage,
                outcome: event.outcome,
                generation: boundedOperationIdentity(event.generation),
                lifecycleRequestId: boundedOperationIdentity(event.lifecycleRequestId),
                authorityRequestId: boundedOperationIdentity(event.authorityRequestId),
                clientId: boundedOperationIdentity(event.clientId),
                pane: boundedOperationIdentity(event.pane),
                seq: Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : null,
              }));
              if (state.operationOverflow) {
                finish("input-receipt-invalid");
                return;
              }
              if (
                operationEvents.some(
                  (event) => event.stage === "surface-write" && event.outcome === "failed",
                )
              ) {
                finish("input-receipt-invalid");
                return;
              }
              const latestAuthorityResult = operationEvents
                .filter((event) => event.stage === "authority-result")
                .at(-1);
              if (latestAuthorityResult?.outcome === "rejected") {
                finish("input-authority-rejected");
                return;
              }
              if (latestAuthorityResult?.outcome === "authority-timeout") {
                finish("input-authority-timeout");
                return;
              }
              if (["closed", "unavailable"].includes(latestAuthorityResult?.outcome)) {
                finish("input-authority-unavailable");
                return;
              }
              if (
                operationEvents.some(
                  (event) => event.stage === "authority-request" && event.outcome === "send-failed",
                )
              ) {
                finish("input-authority-unavailable");
                return;
              }
              if (
                authorityRequestAt === null &&
                operationEvents.some(
                  (event) => event.stage === "authority-request" && event.outcome === "sent",
                )
              )
                authorityRequestAt = now;
              if (
                inputSentAt === null &&
                operationEvents.some(
                  (event) => event.stage === "input-send" && event.outcome === "sent",
                )
              )
                inputSentAt = now;
              if (
                operationEvents.some(
                  (event) => event.stage === "input-ack" && event.outcome === "ack-timeout",
                )
              ) {
                finish("input-ack-timeout");
                return;
              }
              const owner = nextSnapshot?.authority?.owners?.input;
              state.authorityState =
                owner === null
                  ? "null"
                  : owner === captured.clientId
                    ? "expected"
                    : typeof owner === "string"
                      ? "foreign"
                      : "invalid";
              if (state.authorityState === "foreign" || state.authorityState === "invalid") {
                finish("input-authority-foreign");
                return;
              }
              if (
                authorityRequestAt !== null &&
                state.authorityState !== "expected" &&
                now - authorityRequestAt >= 2_000
              ) {
                finish("input-authority-timeout");
                return;
              }
              const count = nextEnvelope?.inputReceiptCount;
              state.currentCount = Number.isSafeInteger(count) && count >= 0 ? count : null;
              state.countRegressed = Number.isSafeInteger(count) && count < baselineCount;
              state.countAdvanced = Number.isSafeInteger(count) && count > baselineCount + 1;
              if (state.currentCount === null || state.countRegressed || state.countAdvanced) {
                finish("input-receipt-invalid");
                return;
              }
              const boundaryReceipts = Array.isArray(nextEnvelope?.inputReceipts)
                ? nextEnvelope.inputReceipts.filter((receipt) => receipt?.ordinal === baselineCount)
                : [];
              const candidates = boundaryReceipts.filter(
                (receipt) =>
                  receipt?.generation === expectedGeneration &&
                  receipt?.pane === exactPane &&
                  receipt?.inputSha256 === expectedInputSha &&
                  receipt?.authorityClientId === captured.clientId &&
                  receipt?.requestId === captured.requestId,
              );
              state.candidateCount = Math.min(candidates.length, 8);
              if (
                boundaryReceipts.length > 1 ||
                candidates.length > 1 ||
                (count === baselineCount + 1 &&
                  (boundaryReceipts.length !== 1 || candidates.length !== 1))
              ) {
                finish("input-receipt-invalid");
                return;
              }
              if (count === baselineCount + 1 && candidates.length === 1) {
                state.authorityClientId = captured.clientId;
                state.receiptOrdinal = baselineCount;
                state.clientGeneration = nextSnapshot.generation;
                state.target = nextSnapshot.target;
                finish("accepted");
                return;
              }
              if (inputSentAt !== null && now - inputSentAt >= 2_000) finish("input-ack-timeout");
            };
            return {
              browserArmSample: globalThis.performance.now(),
              armDeadline(deadline) {
                if (fixedDeadline !== null || !Number.isFinite(deadline)) return false;
                fixedDeadline = deadline;
                return true;
              },
              deadlineInstalled(deadline) {
                return fixedDeadline === deadline && globalThis.performance.now() < deadline;
              },
              startDispatch() {
                const now = globalThis.performance.now();
                const fixedDeadlineInstalled = fixedDeadline !== null;
                const fixedDeadlineFinite = Number.isFinite(fixedDeadline);
                const browserRemainingMs = fixedDeadlineFinite ? fixedDeadline - now : null;
                const dispatchFresh = dispatchAt === null;
                const result = (status) => ({
                  status,
                  settledStatus: state.status,
                  fixedDeadlineInstalled,
                  fixedDeadlineFinite,
                  browserRemainingMs,
                  reserveMs,
                  dispatchFresh,
                  initial: { ...initial },
                  receipt: { ...state },
                });
                if (!initialExact) return result("initial-invalid");
                if (!dispatchFresh) return result("already-started");
                if (!fixedDeadlineFinite || !Number.isFinite(now))
                  return result("deadline-invalid");
                if (browserRemainingMs < reserveMs) return result("reserve-insufficient");
                dispatchAt = now;
                timer = globalThis.setInterval(poll, 5);
                poll();
                return result("started");
              },
              awaitOutcome() {
                return outcomePromise;
              },
              finish() {
                return finish(state.settled ? state.status : "input-receipt-timeout");
              },
            };
          },
          {
            surface: exactSurfaceHandle,
            exactPane: expectedPane,
            expectedWorkspace: before.workspaceName,
            expectedGeneration: before.generation,
            expectedSession: before.workspaceEvidence.authority.session,
            expectedClientGeneration: before.workspaceEvidence.generation,
            expectedTarget: JSON.stringify(before.workspaceEvidence.target),
            expectedRequestHmac: activationRequestHmac,
            expectedPaneSetHmac: activationPaneSetHmac,
            expectedInputSha: inputSha256,
            baselineCount: receiptBoundary,
            keyHex,
            paneIdPattern: TERMINAL_ATTACHMENT_PANE_ID_PATTERN,
            paneIdReserved: TERMINAL_ATTACHMENT_PANE_ID_RESERVED,
            paneIdDiscoveredPrefix: TERMINAL_ATTACHMENT_PANE_ID_DISCOVERED_PREFIX,
            reserveMs: CARD5_INPUT_PRODUCT_PATH_RESERVE_MS + CARD5_INPUT_PREFLIGHT_MARGIN_MS,
          },
        ),
      "input-receipt-invalid",
      "input-receipt-waiter-arm",
      disposeHandle,
    );
    const inputGuardHandle = await withinDeadline(
      () =>
        inputTextareaHandle.evaluateHandle(
          (textarea, { surface, exactPane, exactInput }) => {
            if (
              !(textarea instanceof globalThis.HTMLTextAreaElement) ||
              !(surface instanceof globalThis.HTMLElement)
            )
              return null;
            const outcome = {
              beforeInputCount: 0,
              inputCount: 0,
              eventCount: 0,
              eventOverflow: false,
              mutationCount: 0,
              mutationOverflow: false,
              trusted: true,
              exactTarget: true,
              exactData: true,
              exactInputType: true,
              cancelableBeforeInput: true,
              restorationExact: true,
              rejected: false,
            };
            const browserArmSample = globalThis.performance.now();
            let dispatchDeadline = null;
            const valueSnapshots = new WeakMap();
            const retainValue = (target, allowReadOnlyProtection = false) => {
              if (target && typeof target.value === "string" && !valueSnapshots.has(target)) {
                if (target.value.length <= 16_384) {
                  valueSnapshots.set(target, {
                    kind: "value",
                    value: target.value,
                    selectionStart: Number.isSafeInteger(target.selectionStart)
                      ? target.selectionStart
                      : null,
                    selectionEnd: Number.isSafeInteger(target.selectionEnd)
                      ? target.selectionEnd
                      : null,
                  });
                  return true;
                }
                if (allowReadOnlyProtection && typeof target.readOnly === "boolean") {
                  const readOnly = target.readOnly;
                  try {
                    target.readOnly = true;
                    if (target.readOnly !== true) return false;
                    valueSnapshots.set(target, { kind: "read-only", readOnly });
                    return true;
                  } catch {
                    return false;
                  }
                }
              }
              return valueSnapshots.has(target);
            };
            const restoreValue = (target) => {
              const snapshot = valueSnapshots.get(target);
              if (!snapshot) return false;
              try {
                if (snapshot.kind === "read-only") {
                  target.readOnly = snapshot.readOnly;
                  return target.readOnly === snapshot.readOnly;
                }
                if (typeof target?.value !== "string") return false;
                target.value = snapshot.value;
                let selectionExact = true;
                if (
                  snapshot.selectionStart !== null &&
                  snapshot.selectionEnd !== null &&
                  typeof target.setSelectionRange === "function"
                ) {
                  try {
                    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
                  } catch {
                    selectionExact = false;
                  }
                }
                return target.value === snapshot.value && selectionExact;
              } catch {
                return false;
              }
            };
            if (!retainValue(textarea)) return null;
            let active = true;
            const relevantNode = (node) =>
              node instanceof globalThis.Element &&
              (node === surface ||
                node === textarea ||
                node.contains(surface) ||
                node.contains(textarea) ||
                (node.matches(".terminal-surface[data-phase='connected']") &&
                  node.getAttribute("data-semantic-pane-id") === exactPane) ||
                (typeof node.querySelectorAll === "function" &&
                  [...node.querySelectorAll(".terminal-surface[data-phase='connected']")].some(
                    (candidate) => candidate.getAttribute("data-semantic-pane-id") === exactPane,
                  )));
            const recordMutations = (records) => {
              for (const record of records) {
                if (outcome.mutationOverflow) break;
                const changed = [
                  record.target,
                  ...(record.addedNodes ?? []),
                  ...(record.removedNodes ?? []),
                ];
                if (
                  (record.type === "attributes" && relevantNode(record.target)) ||
                  (record.type === "childList" && changed.some(relevantNode))
                ) {
                  outcome.mutationCount += 1;
                  if (outcome.mutationCount > 32) outcome.mutationOverflow = true;
                }
              }
            };
            const observer = new globalThis.MutationObserver(recordMutations);
            observer.observe(globalThis.document.documentElement, {
              attributes: true,
              attributeOldValue: true,
              childList: true,
              subtree: true,
            });
            const currentExact = () =>
              surface.isConnected &&
              textarea.isConnected !== false &&
              surface.getAttribute("data-phase") === "connected" &&
              surface.getAttribute("data-semantic-pane-id") === exactPane &&
              surface.contains(textarea) &&
              globalThis.document.activeElement === textarea &&
              [
                ...globalThis.document.querySelectorAll(
                  ".terminal-surface[data-phase='connected']",
                ),
              ].filter((candidate) => candidate.getAttribute("data-semantic-pane-id") === exactPane)
                .length === 1;
            const block = (event) => {
              outcome.rejected = true;
              try {
                if (event.type === "input")
                  outcome.restorationExact =
                    restoreValue(event.composedPath()[0]) && outcome.restorationExact;
              } finally {
                event.preventDefault();
                event.stopImmediatePropagation();
              }
            };
            const inspect = (event, kind) => {
              recordMutations(observer.takeRecords());
              outcome.eventCount += 1;
              if (outcome.eventCount > 4) outcome.eventOverflow = true;
              const trusted = event.isTrusted === true;
              const exactTarget = event.composedPath()[0] === textarea && event.target === textarea;
              const exactData = event.data === exactInput;
              const exactInputType = event.inputType === "insertText";
              const cancelableBeforeInput = kind !== "beforeinput" || event.cancelable === true;
              const withinDispatchDeadline =
                Number.isFinite(dispatchDeadline) &&
                globalThis.performance.now() < dispatchDeadline;
              outcome.trusted = outcome.trusted && trusted;
              outcome.exactTarget = outcome.exactTarget && exactTarget;
              outcome.exactData = outcome.exactData && exactData;
              outcome.exactInputType = outcome.exactInputType && exactInputType;
              outcome.cancelableBeforeInput =
                outcome.cancelableBeforeInput && cancelableBeforeInput;
              if (
                outcome.rejected ||
                outcome.eventOverflow ||
                outcome.mutationCount !== 0 ||
                outcome.mutationOverflow ||
                !trusted ||
                !exactTarget ||
                !exactData ||
                !exactInputType ||
                !cancelableBeforeInput ||
                !withinDispatchDeadline ||
                !currentExact() ||
                (kind === "beforeinput" && outcome.beforeInputCount !== 0) ||
                (kind === "input" && (outcome.beforeInputCount !== 1 || outcome.inputCount !== 0))
              ) {
                block(event);
                return;
              }
              if (kind === "beforeinput") outcome.beforeInputCount += 1;
              else outcome.inputCount += 1;
            };
            const onBeforeInput = (event) => inspect(event, "beforeinput");
            const onInput = (event) => inspect(event, "input");
            const onFocusChurn = (event) => {
              if (event.type === "focusin")
                outcome.restorationExact =
                  retainValue(event.composedPath()[0], true) && outcome.restorationExact;
              outcome.rejected = true;
            };
            globalThis.document.addEventListener("beforeinput", onBeforeInput, true);
            globalThis.document.addEventListener("input", onInput, true);
            globalThis.document.addEventListener("focusin", onFocusChurn, true);
            globalThis.document.addEventListener("focusout", onFocusChurn, true);
            const stop = () => {
              if (!active) return;
              active = false;
              observer.disconnect();
              globalThis.document.removeEventListener("beforeinput", onBeforeInput, true);
              globalThis.document.removeEventListener("input", onInput, true);
              globalThis.document.removeEventListener("focusin", onFocusChurn, true);
              globalThis.document.removeEventListener("focusout", onFocusChurn, true);
            };
            return {
              browserArmSample,
              armDeadline(fixedBrowserDeadline) {
                if (
                  dispatchDeadline !== null ||
                  !Number.isFinite(fixedBrowserDeadline) ||
                  fixedBrowserDeadline <= browserArmSample
                )
                  return false;
                dispatchDeadline = fixedBrowserDeadline;
                return true;
              },
              deadlineInstalled(fixedBrowserDeadline) {
                return (
                  dispatchDeadline === fixedBrowserDeadline &&
                  globalThis.performance.now() < dispatchDeadline
                );
              },
              finish() {
                recordMutations(observer.takeRecords());
                const exact = currentExact();
                if (outcome.beforeInputCount !== 1 || outcome.inputCount !== 1 || outcome.rejected)
                  for (const target of [textarea, globalThis.document.activeElement])
                    outcome.restorationExact = restoreValue(target) && outcome.restorationExact;
                stop();
                return { ...outcome, exact };
              },
            };
          },
          {
            surface: exactSurfaceHandle,
            exactPane: expectedPane,
            exactInput: inputText,
          },
        ),
      "input-guard-unavailable",
      "input-guard-arm",
      disposeHandle,
    );
    let inputGuardFinished = false;
    let inputOperationPending = false;
    let inputReceiptWaiterFinished = false;
    const finishInputGuard = async () => {
      if (inputGuardFinished) return null;
      const outcome = await inputGuardHandle.evaluate((guard) => guard?.finish?.() ?? null);
      inputGuardFinished = true;
      await Promise.resolve(inputGuardHandle.dispose()).catch(() => {});
      return outcome;
    };
    const finishInputReceiptWaiter = async () => {
      if (inputReceiptWaiterFinished) return null;
      const outcome = await inputReceiptWaiterHandle.evaluate(
        (waiter) => waiter?.finish?.() ?? null,
      );
      inputReceiptWaiterFinished = true;
      const disposal = Promise.resolve(inputReceiptWaiterHandle.dispose()).catch(() => {});
      let disposalTimer;
      await Promise.race([
        disposal,
        new Promise((resolveWait) => {
          disposalTimer = setTimeout(resolveWait, 100);
        }),
      ]);
      clearTimeout(disposalTimer);
      return outcome;
    };
    const boundedFinishInputReceiptWaiter = async () => {
      if (inputReceiptWaiterFinished) return;
      const pending = Promise.resolve().then(finishInputReceiptWaiter);
      pending.catch(() => {});
      deferredRetainedHandleTrigger = pending;
      const wait = async (promise, timeoutMs) => {
        let timer;
        try {
          return await Promise.race([
            Promise.resolve(promise).then(
              () => true,
              () => true,
            ),
            new Promise((resolveWait) => {
              timer = setTimeout(() => resolveWait(false), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (await wait(pending, 250)) return;
      const closePending = Promise.resolve().then(() =>
        page.close({ runBeforeUnload: false, reason: "Card5 input receipt waiter deadline" }),
      );
      closePending.catch(() => {});
      const pendingSettled = pending.then(
        () => undefined,
        () => undefined,
      );
      const closeSucceeded = closePending.then(
        () => undefined,
        () => new Promise(() => {}),
      );
      deferredRetainedHandleTrigger = Promise.race([pendingSettled, closeSucceeded]);
      if (await wait(closePending, 250)) await wait(pending, 250);
    };
    try {
      const browserArmSample = await withinDeadline(
        () =>
          inputGuardHandle.evaluate((guard) =>
            typeof guard?.finish === "function" && Number.isFinite(guard.browserArmSample)
              ? guard.browserArmSample
              : null,
          ),
        "input-guard-unavailable",
        "input-guard-arm",
      );
      const armSampleReceivedAt = performance.now();
      const armRemaining = deadline - armSampleReceivedAt;
      if (
        !Number.isFinite(browserArmSample) ||
        !Number.isFinite(armSampleReceivedAt) ||
        !Number.isFinite(armRemaining) ||
        armRemaining <= 0
      )
        throw fail("input-guard-unavailable");
      const fixedBrowserDeadline = browserArmSample + armRemaining;
      const inputGuardArmed = await withinDeadline(
        () =>
          inputGuardHandle.evaluate(
            (guard, expectedDeadline) => guard?.armDeadline?.(expectedDeadline) === true,
            fixedBrowserDeadline,
          ),
        "input-guard-unavailable",
        "input-guard-arm",
      );
      if (!inputGuardArmed) throw fail("input-guard-unavailable");
      const inputGuardDeadlineVerified = await withinDeadline(
        () =>
          inputGuardHandle.evaluate(
            (guard, expectedDeadline) => guard?.deadlineInstalled?.(expectedDeadline) === true,
            fixedBrowserDeadline,
          ),
        "input-guard-unavailable",
        "input-guard-arm",
      );
      if (!inputGuardDeadlineVerified) throw fail("input-guard-unavailable");
      const inputReceiptWaiterArmed = await withinDeadline(
        () =>
          inputReceiptWaiterHandle.evaluate(
            (waiter, expectedDeadline) => waiter?.armDeadline?.(expectedDeadline) === true,
            fixedBrowserDeadline,
          ),
        "input-receipt-invalid",
        "input-receipt-waiter-arm",
      );
      const inputReceiptWaiterDeadlineVerified = await withinDeadline(
        () =>
          inputReceiptWaiterHandle.evaluate(
            (waiter, expectedDeadline) => waiter?.deadlineInstalled?.(expectedDeadline) === true,
            fixedBrowserDeadline,
          ),
        "input-receipt-invalid",
        "input-receipt-waiter-arm",
      );
      if (!inputReceiptWaiterArmed || !inputReceiptWaiterDeadlineVerified)
        throw fail("input-receipt-invalid");
      if (!(await exactXtermFocused())) throw fail("pre-input-focus-changed");
      const inputReceiptWaiterStart = await withinDeadline(
        () => inputReceiptWaiterHandle.evaluate((waiter) => waiter?.startDispatch?.() ?? null),
        "input-product-path-reserve-insufficient",
        "input-receipt-waiter-dispatch",
      );
      activationInputReceiptStartAxes = boundedCard5InputReceiptStartAxes(inputReceiptWaiterStart);
      activationInputReceiptAxes = boundedCard5InputReceiptAxes(
        inputReceiptWaiterStart?.receipt,
        keyHex,
      );
      if (activationInputReceiptStartAxes.status === "initial-invalid")
        throw fail("input-receipt-invalid");
      if (activationInputReceiptStartAxes.status === "reserve-insufficient")
        throw fail("input-product-path-reserve-insufficient");
      if (activationInputReceiptStartAxes.status !== "started") throw fail("input-receipt-invalid");
      activationPhase = "input-insertion-timeout";
      const insertionStartedAt = performance.now();
      if (!Number.isFinite(insertionStartedAt) || insertionStartedAt >= deadline)
        throw fail("input-insertion-timeout");
      let insertionSettled = false;
      const insertionPending = Promise.resolve()
        .then(() => page.keyboard.insertText(inputText))
        .finally(() => {
          insertionSettled = true;
        });
      insertionPending.catch(() => {});
      let insertionTimer;
      let insertionTimedOut = false;
      try {
        await Promise.race([
          insertionPending,
          new Promise((_, reject) => {
            insertionTimer = setTimeout(() => {
              insertionTimedOut = true;
              reject(fail("input-insertion-timeout"));
            }, deadline - insertionStartedAt);
          }),
        ]);
        const insertionSettledAt = performance.now();
        if (!Number.isFinite(insertionSettledAt) || insertionSettledAt >= deadline) {
          insertionTimedOut = true;
          throw fail("input-insertion-timeout");
        }
      } catch (cause) {
        if (!insertionTimedOut && cause?.observation?.reason !== "input-insertion-timeout")
          throw cause;
        const cleanupWait = async (promise, timeoutMs) => {
          let timer;
          try {
            return await Promise.race([
              Promise.resolve(promise).then(
                () => "fulfilled",
                () => "rejected",
              ),
              new Promise((resolveWait) => {
                timer = setTimeout(() => resolveWait("timeout"), timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        if (!insertionSettled) await cleanupWait(insertionPending, 250);
        let pageCloseSucceeded = false;
        let closePending = null;
        if (!insertionSettled) {
          closePending = Promise.resolve().then(() =>
            page.close({ runBeforeUnload: false, reason: "Card5 input insertion deadline" }),
          );
          closePending.catch(() => {});
          pageCloseSucceeded = (await cleanupWait(closePending, 250)) === "fulfilled";
          if (pageCloseSucceeded) await cleanupWait(insertionPending, 250);
        }
        if (!insertionSettled && !pageCloseSucceeded) {
          inputOperationPending = true;
          const closeSucceeded = closePending
            ? closePending.then(
                () => undefined,
                () => new Promise(() => {}),
              )
            : new Promise(() => {});
          Promise.race([insertionPending.catch(() => {}), closeSucceeded]).finally(() =>
            Promise.allSettled([finishInputGuard(), finishInputReceiptWaiter()]),
          );
        }
        throw cause;
      } finally {
        clearTimeout(insertionTimer);
      }
      const inputGuardOutcome = await withinDeadline(
        finishInputGuard,
        "input-guard-unavailable",
        "input-guard-finish",
      );
      inputGuardFinished = true;
      const inputGuardFinishedAt = performance.now();
      activationInputGuardAxes = boundedCard5InputGuardAxes(inputGuardOutcome, {
        deadlineValid: Number.isFinite(inputGuardFinishedAt) && inputGuardFinishedAt < deadline,
        settled: insertionSettled,
      });
      activationInputGuardReason = card5InputGuardFailureReason(activationInputGuardAxes);
      if (
        inputGuardOutcome?.inputCount !== 1 ||
        inputGuardOutcome?.beforeInputCount !== 1 ||
        inputGuardOutcome.eventCount !==
          inputGuardOutcome.inputCount + inputGuardOutcome.beforeInputCount ||
        inputGuardOutcome.eventOverflow !== false ||
        inputGuardOutcome.mutationCount !== 0 ||
        inputGuardOutcome.mutationOverflow !== false ||
        inputGuardOutcome.trusted !== true ||
        inputGuardOutcome.exactTarget !== true ||
        inputGuardOutcome.exactData !== true ||
        inputGuardOutcome.exactInputType !== true ||
        inputGuardOutcome.cancelableBeforeInput !== true ||
        inputGuardOutcome.restorationExact !== true ||
        inputGuardOutcome.rejected !== false ||
        inputGuardOutcome.exact !== true
      )
        throw fail("input-dispatch-rejected");
      let inputReceiptOutcome;
      try {
        inputReceiptOutcome = await withinDeadline(
          () => inputReceiptWaiterHandle.evaluate((waiter) => waiter?.awaitOutcome?.() ?? null),
          "input-receipt-timeout",
          "input-receipt-wait",
        );
      } catch (cause) {
        if (cause?.observation?.reason === "input-receipt-timeout") {
          deferRetainedHandleDisposal = true;
          await boundedFinishInputReceiptWaiter().catch(() => {});
        }
        throw cause;
      }
      inputReceiptWaiterFinished = true;
      const waiterDisposal = Promise.resolve(inputReceiptWaiterHandle.dispose()).catch(() => {});
      let waiterDisposalTimer;
      await Promise.race([
        waiterDisposal,
        new Promise((resolveWait) => {
          waiterDisposalTimer = setTimeout(resolveWait, 100);
        }),
      ]);
      clearTimeout(waiterDisposalTimer);
      activationInputReceiptAxes = boundedCard5InputReceiptAxes(inputReceiptOutcome, keyHex);
      if (inputReceiptOutcome?.status !== "accepted") {
        const reason = [
          "input-authority-foreign",
          "input-authority-unobserved-timeout",
          "input-authority-rejected",
          "input-authority-timeout",
          "input-authority-unavailable",
          "input-ack-timeout",
          "input-receipt-timeout",
          "input-receipt-invalid",
        ].includes(inputReceiptOutcome?.status)
          ? inputReceiptOutcome.status
          : "input-receipt-invalid";
        throw fail(reason);
      }
      if (!(await pointerTargetUnchanged())) throw fail("post-input-target-changed");
      if (!(await exactXtermFocused())) throw fail("post-input-focus-changed");
      const completedAt = performance.now();
      if (!Number.isFinite(completedAt) || completedAt >= deadline)
        throw fail("activation-deadline");
      return Object.freeze({
        before: Object.freeze({
          workspaceName: before.workspaceName,
          semanticPaneId: before.semanticPaneId,
          generation: before.generation,
          target: before.workspaceEvidence.target,
        }),
        after: Object.freeze({
          workspaceName: before.workspaceName,
          semanticPaneId: before.semanticPaneId,
          generation: before.generation,
          target: inputReceiptOutcome.target,
        }),
        receiptBoundary,
        requestHmac: activationRequestHmac,
        authorityClientId: inputReceiptOutcome.authorityClientId,
        receiptOrdinal: inputReceiptOutcome.receiptOrdinal,
      });
    } finally {
      if (!inputGuardFinished && !inputOperationPending) {
        await Promise.resolve()
          .then(finishInputGuard)
          .catch(() => {});
      }
      if (!inputReceiptWaiterFinished && !inputOperationPending && !deferRetainedHandleDisposal) {
        await boundedFinishInputReceiptWaiter().catch(() => {});
      }
    }
  } finally {
    if (!deferRetainedHandleDisposal) {
      await Promise.allSettled(
        [...retainedHandles].map((handle) => Promise.resolve().then(() => handle.dispose())),
      );
    } else {
      // The exact owned page close releases all of these CDP handles. If the
      // renderer/transport never confirms closure, retaining local JSHandle
      // wrappers is safer than blocking the controller or sending any broader
      // cleanup signal. Late disposal is deliberately best-effort and detached.
      deferredRetainedHandleTrigger
        ?.then(() =>
          Promise.allSettled(
            [...retainedHandles].map((handle) => Promise.resolve().then(() => handle.dispose())),
          ),
        )
        .catch(() => {});
    }
  }
}

/** Release only authority currently owned by this exact detailed-mode Web binding. */
export async function releaseCard5WebOwnedAuthorities(page, expected) {
  return page.evaluate(
    async ({ expected, keyHex }) => {
      const control = globalThis.__TMUX_IDE_CARD5_AUTHORITY_CONTROL__;
      const workspace = globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__?.();
      const envelope = globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?.();
      const snapshot = workspace?.snapshot;
      const authority = snapshot?.authority;
      const active = Array.isArray(envelope?.activeLifecycleRequests)
        ? envelope.activeLifecycleRequests.filter(
            (request) =>
              request?.generation === expected.generation &&
              request?.workspaceName === expected.workspaceName &&
              request?.semanticPaneIds?.includes(expected.semanticPaneId),
          )
        : [];
      const descriptors =
        active.length === 1 && Array.isArray(envelope?.descriptorEvents)
          ? envelope.descriptorEvents.filter(
              (descriptor) =>
                descriptor?.generation === expected.generation &&
                descriptor?.requestId === active[0].requestId,
            )
          : [];
      if (
        !control ||
        snapshot?.phase !== "live" ||
        snapshot?.target?.workspaceName !== expected.workspaceName ||
        snapshot?.target?.daemon?.instanceId !== expected.generation ||
        authority?.generation !== expected.generation ||
        authority?.session !== expected.runtimeSession ||
        active.length !== 1 ||
        descriptors.length !== 1
      ) {
        return Object.freeze({
          status: "binding-invalid",
          pageHmac: expected.pageHmac,
          localClientHmac: null,
          preOwnerTupleHmac: null,
          preRevisionHmac: null,
          receipts: Object.freeze([]),
        });
      }
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        Uint8Array.from(keyHex.match(/../gu) ?? [], (value) => Number.parseInt(value, 16)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const hmac = async (domain, value) => {
        const bytes = new TextEncoder().encode(`${domain}\0${value}`);
        const signed = await globalThis.crypto.subtle.sign("HMAC", key, bytes);
        return [...new Uint8Array(signed)]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join("");
      };
      const preOwnerTupleHmac = await hmac(
        "release-pre-owner-tuple",
        JSON.stringify({
          input: authority.owners?.input ?? null,
          focus: authority.owners?.focus ?? null,
          geometry: authority.owners?.geometry ?? null,
        }),
      );
      const preRevisionHmac = await hmac("release-pre-revision", String(authority.revision));
      const receipts = [];
      for (const authorityKind of ["input", "focus", "geometry"]) {
        const clientId = authority.owners?.[authorityKind];
        const owner = authority.clients?.find((client) => client.clientId === clientId);
        if (clientId === null || owner?.surface !== "web") continue;
        const receipt = await control.release({
          version: 1,
          workspaceName: expected.workspaceName,
          generation: expected.generation,
          runtimeSession: expected.runtimeSession,
          semanticPaneId: expected.semanticPaneId,
          requestId: active[0].requestId,
          clientId,
          authority: authorityKind,
        });
        if (receipt === null) continue;
        receipts.push(
          Object.freeze({
            authority: receipt.authority,
            status: receipt.status,
            operationOrdinal: receipt.operationOrdinal,
            beforeRevision: receipt.beforeRevision,
            afterRevision: receipt.afterRevision,
            workspaceHmac: await hmac("release-workspace", receipt.workspaceName),
            generationHmac: await hmac("release-generation", receipt.generation),
            runtimeSessionHmac: await hmac("release-runtime-session", receipt.runtimeSession),
            paneHmac: await hmac("release-pane", receipt.semanticPaneId),
            requestHmac: await hmac("request", receipt.requestId),
            clientHmac: await hmac("authority-client", receipt.clientId),
          }),
        );
      }
      return Object.freeze({
        status: "exact",
        pageHmac: expected.pageHmac,
        // The WorkspaceClient contract exposes connection-local ownership but
        // intentionally does not expose the raw local client identity.
        localClientHmac: null,
        preOwnerTupleHmac,
        preRevisionHmac,
        receipts: Object.freeze(receipts),
      });
    },
    { expected, keyHex: expected.evidenceKey },
  );
}

export async function issueCard5PredecessorDescriptor(page, expected) {
  if (
    typeof expected?.workspaceName !== "string" ||
    typeof expected?.generation !== "string" ||
    typeof expected?.semanticPaneId !== "string"
  ) {
    throw new TypeError("Card5 predecessor identity is malformed");
  }
  return page.evaluate(async (exact) => {
    const host = globalThis.tmuxIdeHost;
    const shell = await host.daemon.fetchApplicationShell({ workspaceName: exact.workspaceName });
    if (shell.status !== "ok") return null;
    const resource = shell.envelope.resource?.terminalInventory?.resources?.find(
      (entry) =>
        entry.attachability?.status === "available" &&
        entry.attachability?.semanticPaneId === exact.semanticPaneId,
    );
    const pane = resource?.attachability?.semanticPaneId;
    if (!pane) return null;
    const issued = await host.daemon.issuePaneStream({
      protocolVersion: 1,
      workspaceName: exact.workspaceName,
      panes: [pane],
      viewerMode: "read-only",
    });
    if (
      issued.status !== "issued" ||
      issued.descriptor.daemonInstanceId !== exact.generation ||
      issued.descriptor.panes.length !== 1 ||
      issued.descriptor.panes[0] !== exact.semanticPaneId
    ) {
      return null;
    }
    return issued.descriptor;
  }, expected);
}

export async function rejectCard5PredecessorDescriptor(page, descriptor) {
  if (!descriptor) return Object.freeze({ rejected: false, reason: "descriptor-missing" });
  return page.evaluate(async (stale) => {
    const { browserWebSocketHandshakeUrl } =
      await import("/src/runtime/browser-websocket-session.ts");
    return new Promise((resolve) => {
      const socket = new globalThis.WebSocket(
        browserWebSocketHandshakeUrl(stale.webSocketUrl),
        stale.subprotocol,
      );
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already terminal.
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ rejected: false, reason: "timeout" }), 2_000);
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "redeem",
            protocolVersion: 1,
            ticket: stale.redemptionTicket,
            requestId: stale.requestId,
            daemonInstanceId: stale.daemonInstanceId,
            panes: stale.panes,
            effectiveViewerMode: stale.effectiveViewerMode,
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          finish({ rejected: true, reason: "malformed" });
          return;
        }
        if (
          frame?.type === "error" &&
          ["redemption-rejected", "ticket-expired"].includes(frame.code)
        ) {
          finish({ rejected: true, typed: true, reason: frame.code });
        } else if (frame?.type === "error") {
          finish({ rejected: false, typed: false, reason: "unexpected-error-code" });
        } else if (frame?.type === "redeemed" || frame?.type === "seed-batch") {
          finish({ rejected: false, reason: "stale-authority-accepted" });
        }
      });
      socket.addEventListener("close", () =>
        finish({ rejected: false, typed: false, reason: "closed-without-error-frame" }),
      );
      socket.addEventListener("error", () =>
        finish({ rejected: false, typed: false, reason: "socket-error" }),
      );
    });
  }, descriptor);
}
