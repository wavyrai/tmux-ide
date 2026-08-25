import { isAbsolute, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

import { card5ProductionHostTopology } from "./product-card5-host-topology.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const CARD5_PROBE_QUERY = "tmuxIdeCard5Evidence";
const CARD5_ACTIVE_TERMINAL_PANEL = "#workspace-panel-terminals:not([hidden])";
const CARD5_MAX_READINESS_CANDIDATES = 64;
const CARD5_MAX_PAGE_EVENTS = 16;
const CARD5_READINESS_OBSERVATION_TIMEOUT_MS = 1_000;
const CLOSE_GRACE_MS = 2_000;
const CLOSE_TERM_MS = 500;
const qualifiedTerminalIdentities = new WeakMap();

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
    return execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart=,command="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) =>
        /^(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/u.exec(
          line.trim(),
        ),
      )
      .filter(Boolean)
      .map((match) => ({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        startToken: match[4],
        command: match[5],
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

  const ownedPids = (rootPid, known, identities, ownedPath) => {
    const rows = readProcessRows();
    const rowByPid = new Map(rows.map((row) => [row.pid, row]));
    const identity = (row) => `${row.startToken}\0${row.pgid}\0${row.command}`;
    const register = (pid) => {
      const row = rowByPid.get(pid);
      if (!row) return;
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
    return [...known].filter((pid) => isAlive(pid));
  };
  const receipt = (reason = null) => {
    const chromium = ownedPids(
      resources.chromiumPid,
      resources.knownChromium,
      resources.chromiumIdentities,
      null,
    );
    const electron = ownedPids(
      resources.electronPid,
      resources.knownElectron,
      resources.electronIdentities,
      input.electronUserData,
    );
    const chromiumMain = chromium.includes(resources.chromiumPid) ? 1 : 0;
    const electronMain = electron.includes(resources.electronPid) ? 1 : 0;
    const inspectedCount = (pids, inspect) => {
      const values = pids.map(inspect);
      return values.some((value) => value === null)
        ? null
        : values.reduce((sum, value) => sum + value, 0);
    };
    const electronOpenHandleCount = inspectedCount(electron, (pid) =>
      lsofCount(["-n", "-P", "-a", "-p", String(pid)], (line) => line.includes(input.runtimeRoot)),
    );
    const chromiumListenerCount = inspectedCount(chromium, (pid) =>
      lsofCount(["-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]),
    );
    const electronListenerCount = inspectedCount(electron, (pid) =>
      lsofCount(["-n", "-P", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]),
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
                ownedPids(
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
        const directHandles = [
          resources.browser?.process?.(),
          resources.electronApp?.process?.(),
        ].filter(
          (handle) =>
            handle &&
            Number.isSafeInteger(handle.pid) &&
            handle.exitCode == null &&
            handle.signalCode == null &&
            isAlive(handle.pid),
        );
        for (const handle of directHandles) {
          try {
            handle.kill("SIGTERM");
          } catch {
            // The directly-owned child may retire after its handle was checked.
          }
        }
        await waitRetired(directHandles.map(({ pid }) => pid));
        const remaining = directHandles.filter(
          (handle) => handle.exitCode == null && handle.signalCode == null && isAlive(handle.pid),
        );
        await sleep(closeTermMs);
        for (const handle of remaining) {
          try {
            handle.kill("SIGKILL");
          } catch {
            // The directly-owned child may retire after its handle was checked.
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
        ownedPids(
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
              ownedPids(
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
  return page.evaluate(
    async ({
      exactKey,
      processIdentity: exactProcessIdentity,
      expectedIdentity: expected,
      expectedSurface,
    }) => {
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
      const workspaceName = surface.getAttribute("data-workspace-name");
      const paneId = surface.getAttribute("data-semantic-pane-id");
      const stillExact = () =>
        globalThis.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?.("observation") === expectedSurface;
      const workspaceHmac = await hmac("workspace", workspaceName);
      if (!stillExact() || workspaceHmac !== expected.workspaceHmac) return null;
      const paneHmac = await hmac("pane", paneId);
      if (!stillExact() || paneHmac !== expected.paneHmac) return null;
      const probe = globalThis.__TMUX_IDE_PROBE_TERMINAL_RENDITION__;
      if (!paneId || typeof probe !== "function") return null;
      const result = await probe(paneId, exactKey);
      if (!result || !stillExact()) return null;
      if (
        surface.getAttribute("data-workspace-name") !== workspaceName ||
        surface.getAttribute("data-semantic-pane-id") !== paneId
      ) {
        return null;
      }
      const queueText = [...globalThis.document.querySelectorAll(".gui-performance-hud dl")]
        .find((row) => row.querySelector("dt")?.textContent?.trim() === "Queue")
        ?.querySelector("dd")
        ?.textContent?.trim();
      const queue = /^(\d+)\s*\/\s*(\d+)$/u.exec(queueText ?? "");
      const evidence =
        typeof globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ === "function"
          ? globalThis.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__()
          : null;
      const activeLifecycleRequests = Array.isArray(evidence?.activeLifecycleRequests)
        ? evidence.activeLifecycleRequests.filter(
            (request) =>
              request?.generation === result.canonical.generation &&
              request.workspaceName === workspaceName &&
              Array.isArray(request.semanticPaneIds) &&
              request.semanticPaneIds.includes(paneId),
          )
        : [];
      const activeLifecycleRequestOverflow =
        (Array.isArray(evidence?.activeLifecycleRequestOverflowGenerations) &&
          evidence.activeLifecycleRequestOverflowGenerations.includes(
            result.canonical.generation,
          )) ||
        activeLifecycleRequests.length > 8;
      const currentLifecycleRequestStatus = activeLifecycleRequestOverflow
        ? "overflow"
        : activeLifecycleRequests.length === 0
          ? "missing"
          : activeLifecycleRequests.length === 1
            ? "exact"
            : "ambiguous";
      const currentLifecycleRequestHmac =
        currentLifecycleRequestStatus === "exact"
          ? await hmac("request", activeLifecycleRequests[0].requestId)
          : null;
      if (!stillExact()) return null;
      const currentLifecycleDescriptors =
        currentLifecycleRequestStatus === "exact" && Array.isArray(evidence?.descriptorEvents)
          ? evidence.descriptorEvents.filter(
              (descriptor) =>
                descriptor?.generation === result.canonical.generation &&
                descriptor?.requestId === activeLifecycleRequests[0].requestId,
            )
          : [];
      const currentLifecycleSocketHmac =
        currentLifecycleDescriptors.length === 1
          ? await hmac(
              "socket",
              `${currentLifecycleDescriptors[0].socketUrl}\0${activeLifecycleRequests[0].requestId}`,
            )
          : null;
      if (!stillExact()) return null;
      if (
        surface.getAttribute("data-workspace-name") !== workspaceName ||
        surface.getAttribute("data-semantic-pane-id") !== paneId
      ) {
        return null;
      }
      const workspaceEvidence =
        typeof globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__ === "function"
          ? globalThis.__TMUX_IDE_CARD5_WORKSPACE_EVIDENCE__()
          : null;
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
      const workspaceSnapshot = workspaceEvidence?.snapshot ?? null;
      return {
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
                descriptorCount: Math.min(currentLifecycleDescriptors.length, 8),
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
    },
    {
      exactKey: keyHex,
      processIdentity,
      expectedIdentity: {
        workspaceHmac: expectedIdentity.workspaceHmac,
        paneHmac: expectedIdentity.paneHmac,
      },
      expectedSurface: expectedIdentity.surfaceHandle,
    },
  );
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
    }) => {
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
      const active = Array.isArray(envelope.activeLifecycleRequests)
        ? envelope.activeLifecycleRequests.filter(
            (request) =>
              request?.generation === snapshot.generation &&
              request.workspaceName === workspaceName &&
              Array.isArray(request.semanticPaneIds) &&
              request.semanticPaneIds.includes(paneId),
          )
        : [];
      const overflow =
        (Array.isArray(envelope.activeLifecycleRequestOverflowGenerations) &&
          envelope.activeLifecycleRequestOverflowGenerations.includes(snapshot.generation)) ||
        active.length > 8;
      const requestStatus = overflow
        ? "overflow"
        : active.length === 0
          ? "missing"
          : active.length === 1
            ? "exact"
            : "ambiguous";
      const requestHmac =
        requestStatus === "exact" ? await hmac("request", active[0].requestId) : null;
      const descriptors =
        requestStatus === "exact" && Array.isArray(envelope.descriptorEvents)
          ? envelope.descriptorEvents.filter(
              (descriptor) =>
                descriptor?.generation === snapshot.generation &&
                descriptor?.requestId === active[0].requestId,
            )
          : [];
      if (!stillExact()) return null;
      return {
        workspaceName,
        semanticPaneId: paneId,
        processIdentity: exactProcessIdentity,
        generation: snapshot.generation,
        runtimeReplacement: {
          inputReceipts: envelope.inputReceipts,
          inputReceiptCount: envelope.inputReceiptCount,
          currentLifecycleRequest: {
            status: requestStatus,
            requestHmac,
            activeCount: Math.min(active.length, 8),
            descriptorCount: Math.min(descriptors.length, 8),
            overflow,
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
      lifecycle.activeCount === 1 &&
      lifecycle.overflow === false &&
      lifecycle.descriptorCount === 1
    ) {
      return Object.freeze({
        status: "exact",
        requestHmac: lifecycle.requestHmac,
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
    observed?.generation === before.generation &&
    observed?.processIdentity === before.processIdentity &&
    JSON.stringify(observed?.workspaceEvidence?.target) ===
      JSON.stringify(before.workspaceEvidence?.target);
  let beforeLifecycle;
  let stableBefore;
  let receiptBoundary;
  let activationRequestHmac;
  if (insertsInput) {
    let previousCandidate = null;
    let previousObserved = null;
    let highestReceiptCount = -1;
    let observedRequestHmac = null;
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
        observedRequestHmac = identity.requestHmac;
        const candidate = JSON.stringify({ requestHmac: identity.requestHmac, count });
        if (candidate === previousCandidate) {
          before = previousObserved;
          stableBefore = current;
          beforeLifecycle = identity;
          activationRequestHmac = identity.requestHmac;
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
            (target, { surface, area, exactPane }) => {
              if (
                !(target instanceof globalThis.HTMLElement) ||
                !(surface instanceof globalThis.HTMLElement) ||
                !(area instanceof globalThis.HTMLElement)
              )
                return null;
              const outcome = {
                dispatched: false,
                trusted: false,
                allowed: false,
                mutationCount: 0,
                mutationOverflow: false,
                eventCount: 0,
                eventOverflow: false,
                rejected: false,
              };
              let active = true;
              let mutationInspectionCount = 0;
              const touchesIdentity = (record) => {
                mutationInspectionCount += 1;
                if (mutationInspectionCount > 256) {
                  outcome.mutationOverflow = true;
                  return true;
                }
                const node = record.target;
                if (node === area || node === surface || node === target) return true;
                if (node instanceof globalThis.Node && area.contains(node)) return true;
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
                )
                  return true;
                if (
                  record.type === "attributes" &&
                  node instanceof globalThis.HTMLElement &&
                  node.matches(".pane-tile[data-composed='true']") &&
                  record.attributeName === "data-pane" &&
                  (record.oldValue === exactPane || node.getAttribute("data-pane") === exactPane)
                )
                  return true;
                const changed = [...record.addedNodes, ...record.removedNodes];
                for (const entry of changed) {
                  if (entry === area || entry === surface || entry === target) return true;
                  if (!(entry instanceof globalThis.HTMLElement)) continue;
                  if (
                    area.contains(entry) ||
                    entry.contains(area) ||
                    entry.contains(surface) ||
                    entry.contains(target)
                  )
                    return true;
                  const descendants = [entry];
                  let inspected = 0;
                  while (descendants.length > 0) {
                    const descendant = descendants.pop();
                    inspected += 1;
                    if (inspected > 64) {
                      outcome.mutationOverflow = true;
                      return true;
                    }
                    if (
                      descendant.matches(".terminal-surface") &&
                      descendant.getAttribute("data-semantic-pane-id") === exactPane
                    )
                      return true;
                    for (const child of descendant.children) {
                      if (descendants.length + inspected >= 64) {
                        outcome.mutationOverflow = true;
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
                  else outcome.mutationCount += 1;
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
                  path.includes(target);
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
                finish() {
                  retainMutations(observer.takeRecords());
                  stop();
                  return Object.freeze({ ...outcome });
                },
              };
            },
            { surface: exactSurfaceHandle, area: areaHandle, exactPane: expectedPane },
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
              rejected: false,
            };
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
              event.preventDefault();
              event.stopImmediatePropagation();
            };
            const inspect = (event, kind) => {
              recordMutations(observer.takeRecords());
              outcome.eventCount += 1;
              if (outcome.eventCount > 4) outcome.eventOverflow = true;
              const trusted = event.isTrusted === true;
              const exactTarget = event.composedPath()[0] === textarea && event.target === textarea;
              const exactData = event.data === exactInput;
              outcome.trusted = outcome.trusted && trusted;
              outcome.exactTarget = outcome.exactTarget && exactTarget;
              outcome.exactData = outcome.exactData && exactData;
              if (
                outcome.rejected ||
                outcome.eventOverflow ||
                outcome.mutationCount !== 0 ||
                outcome.mutationOverflow ||
                !trusted ||
                !exactTarget ||
                !exactData ||
                !currentExact() ||
                (kind === "beforeinput" && outcome.beforeInputCount !== 0) ||
                (kind === "input" && outcome.inputCount !== 0)
              ) {
                block(event);
                return;
              }
              if (kind === "beforeinput") outcome.beforeInputCount += 1;
              else outcome.inputCount += 1;
            };
            const onBeforeInput = (event) => inspect(event, "beforeinput");
            const onInput = (event) => inspect(event, "input");
            const onFocusChurn = () => {
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
              finish() {
                recordMutations(observer.takeRecords());
                const exact = currentExact();
                stop();
                return { ...outcome, exact };
              },
            };
          },
          { surface: exactSurfaceHandle, exactPane: expectedPane, exactInput: inputText },
        ),
      "input-guard-unavailable",
      "input-guard-arm",
      disposeHandle,
    );
    retainedHandles.add(inputGuardHandle);
    let inputGuardFinished = false;
    try {
      const inputGuardArmed = await withinDeadline(
        () => inputGuardHandle.evaluate((guard) => typeof guard?.finish === "function"),
        "input-guard-unavailable",
        "input-guard-arm",
      );
      if (!inputGuardArmed) throw fail("input-guard-unavailable");
      if (!(await exactXtermFocused())) throw fail("pre-input-focus-changed");
      await withinDeadline(() => page.keyboard.insertText(inputText), "input-insertion-timeout");
      const inputGuardOutcome = await withinDeadline(
        () => inputGuardHandle.evaluate((guard) => guard?.finish?.() ?? null),
        "input-guard-unavailable",
        "input-guard-finish",
      );
      inputGuardFinished = true;
      if (
        inputGuardOutcome?.inputCount !== 1 ||
        ![0, 1].includes(inputGuardOutcome?.beforeInputCount) ||
        inputGuardOutcome.eventCount !==
          inputGuardOutcome.inputCount + inputGuardOutcome.beforeInputCount ||
        inputGuardOutcome.eventOverflow !== false ||
        inputGuardOutcome.mutationCount !== 0 ||
        inputGuardOutcome.mutationOverflow !== false ||
        inputGuardOutcome.trusted !== true ||
        inputGuardOutcome.exactTarget !== true ||
        inputGuardOutcome.exactData !== true ||
        inputGuardOutcome.rejected !== false ||
        inputGuardOutcome.exact !== true
      )
        throw fail("input-dispatch-rejected");
    } finally {
      if (!inputGuardFinished) {
        await Promise.resolve()
          .then(() => inputGuardHandle.evaluate((guard) => guard?.finish?.() ?? null))
          .catch(() => {});
      }
    }
    let afterInput = null;
    let receipt = null;
    while (performance.now() < deadline) {
      afterInput = await observe();
      if (!sameBinding(afterInput)) throw fail("post-input-binding-changed");
      if (!(await exactXtermFocused())) throw fail("post-input-focus-changed");
      const postInputReceiptCount = afterInput.runtimeReplacement?.inputReceiptCount;
      if (!Number.isSafeInteger(postInputReceiptCount) || postInputReceiptCount < receiptBoundary)
        throw fail("post-input-receipt-count-regressed");
      if (postInputReceiptCount > receiptBoundary + 1)
        throw fail("post-input-receipt-count-advanced");
      const receipts = afterInput.runtimeReplacement?.inputReceipts;
      const candidates = Array.isArray(receipts)
        ? receipts.filter(
            (candidate) =>
              Number.isSafeInteger(candidate?.ordinal) &&
              candidate.ordinal === receiptBoundary &&
              candidate.generation === before.generation &&
              candidate.pane === expectedPane &&
              candidate.inputSha256 === inputSha256 &&
              typeof candidate.authorityClientId === "string" &&
              candidate.authorityClientId.length > 0 &&
              candidate.authorityClientId.length <= 512 &&
              typeof candidate.requestId === "string" &&
              createHmac("sha256", Buffer.from(keyHex, "hex"))
                .update(`request\0${candidate.requestId}`)
                .digest("hex") === activationRequestHmac,
          )
        : [];
      if (candidates.length > 1) throw fail("input-receipt-ambiguous");
      if (candidates.length === 1) {
        if (postInputReceiptCount !== receiptBoundary + 1)
          throw fail("post-input-receipt-count-mismatch");
        receipt = candidates[0];
        break;
      }
      if (postInputReceiptCount === receiptBoundary + 1) throw fail("input-receipt-mismatch");
      await withinDeadline(
        () => new Promise((resolveWait) => setTimeout(resolveWait, 5)),
        "input-receipt-timeout",
      );
    }
    if (receipt === null) throw fail("input-receipt-timeout");
    const completedAt = performance.now();
    if (!Number.isFinite(completedAt) || completedAt >= deadline) throw fail("activation-deadline");
    return Object.freeze({
      before: Object.freeze({
        workspaceName: before.workspaceName,
        semanticPaneId: before.semanticPaneId,
        generation: before.generation,
        target: before.workspaceEvidence.target,
      }),
      after: Object.freeze({
        workspaceName: afterInput.workspaceName,
        semanticPaneId: afterInput.semanticPaneId,
        generation: afterInput.generation,
        target: afterInput.workspaceEvidence.target,
      }),
      receiptBoundary,
      requestHmac: activationRequestHmac,
      authorityClientId: receipt.authorityClientId,
      receiptOrdinal: receipt.ordinal,
    });
  } finally {
    await Promise.allSettled(
      [...retainedHandles].map((handle) => Promise.resolve().then(() => handle.dispose())),
    );
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
