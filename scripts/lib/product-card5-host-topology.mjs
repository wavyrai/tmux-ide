import { createHmac } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const READ_ONLY_TMUX = new Set([
  "capture-pane",
  "display-message",
  "list-clients",
  "list-panes",
  "list-windows",
]);

const CARD5_LIFECYCLE_REASONS = new Set([
  "descriptor-missing",
  "activated-request-missing",
  "activated-request-ambiguous",
  "activated-request-overflow",
  "activated-request-invalid",
  "generation-mismatch",
  "request-no-active-open",
  "process-missing",
  "socket-missing",
  "request-missing",
  "lane-missing",
  "client-missing",
  "ordinal-invalid",
  "duplicate-request",
  "duplicate-lane",
  "duplicate-client",
  "extra-active",
  "closed",
]);

function lifecycleHmac(domain, value, key) {
  return createHmac("sha256", Buffer.from(key, "hex")).update(`${domain}\0${value}`).digest("hex");
}

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function assessCard5ObservedHostLifecycle({
  stage,
  generation,
  pane,
  tuiProcessId,
  web,
  daemonRecords,
  evidenceKey,
}) {
  if (
    !boundedIdentity(generation) ||
    !boundedIdentity(pane) ||
    !new Set(["initial-host-lifecycle", "replacement-host-lifecycle"]).has(stage) ||
    !/^[0-9a-f]{64}$/u.test(evidenceKey ?? "") ||
    !Array.isArray(web) ||
    web.length !== 2 ||
    !Array.isArray(daemonRecords)
  ) {
    throw new TypeError("Card5 lifecycle assessment identity is malformed");
  }
  const opens = daemonRecords.filter(
    (record) =>
      record?.operation === "terminal-delivery-subscriber-lifecycle" &&
      record.terminalDelivery?.deliveryLifecycleEvent === "open" &&
      record.terminalDelivery?.deliveryPurpose === "terminal-surface" &&
      record.terminalDelivery?.canonicalGeneration === generation &&
      record.terminalDelivery?.semanticPaneId === pane,
  );
  const closeRecords = daemonRecords.filter(
    (record) =>
      record?.operation === "terminal-delivery-subscriber-lifecycle" &&
      record.terminalDelivery?.deliveryLifecycleEvent === "close" &&
      record.terminalDelivery?.canonicalGeneration === generation &&
      record.terminalDelivery?.semanticPaneId === pane,
  );
  const closes = new Set(
    closeRecords.map(({ terminalDelivery }) => terminalDelivery.deliveryRequestId),
  );
  const active = opens.filter(
    ({ terminalDelivery }) => !closes.has(terminalDelivery.deliveryRequestId),
  );
  const currentRequest = (entry) => entry?.runtimeReplacement?.currentLifecycleRequest ?? null;
  const validCurrentRequest = (request) => {
    if (!request || !new Set(["exact", "missing", "ambiguous", "overflow"]).has(request.status))
      return false;
    const emptyAuthority =
      request.requestHmac === null &&
      request.socketHmac === null &&
      request.descriptorCount === 0 &&
      request.firstSeedOrdinal === null;
    if (request.status === "missing")
      return request.activeCount === 0 && request.overflow === false && emptyAuthority;
    if (request.status === "ambiguous")
      return (
        Number.isSafeInteger(request.activeCount) &&
        request.activeCount >= 2 &&
        request.activeCount <= 8 &&
        request.overflow === false &&
        emptyAuthority
      );
    if (request.status === "overflow")
      return request.activeCount === 8 && request.overflow === true && emptyAuthority;
    return (
      request.activeCount === 1 &&
      request.overflow === false &&
      request.descriptorCount === 1 &&
      Number.isSafeInteger(request.firstSeedOrdinal) &&
      request.firstSeedOrdinal >= 0
    );
  };
  const webRequests = web.map(currentRequest);
  const exact = [
    {
      client: "opentui",
      processIdentity: tuiProcessId,
      socketIdentity: null,
      descriptor: null,
      record: active.find(({ terminalDelivery }) => terminalDelivery.deliverySurface === "opentui"),
    },
    ...webRequests.map((request, index) => ({
      client: index === 0 ? "web-a" : "web-b",
      processIdentity: web[index]?.processIdentity,
      socketIdentity: request?.socketHmac,
      descriptor: request,
      record: active.find(
        ({ terminalDelivery }) =>
          terminalDelivery.deliverySurface === "web" &&
          boundedIdentity(terminalDelivery.deliveryRequestId) &&
          lifecycleHmac("request", terminalDelivery.deliveryRequestId, evidenceKey) ===
            request?.requestHmac,
      ),
    })),
  ];
  const duplicate = (field) => {
    const values = exact.map(({ record }) => record?.terminalDelivery?.[field]).filter(Boolean);
    return values.length === 3 && new Set(values).size !== 3;
  };
  const duplicateRequest = duplicate("deliveryRequestId");
  const duplicateLane = duplicate("deliveryLaneId");
  const duplicateClient = duplicate("deliveryClientId");
  const clients = exact.map(({ client, processIdentity, socketIdentity, descriptor, record }) => {
    const delivery = record?.terminalDelivery;
    let reason = null;
    if (client !== "opentui" && !descriptor) reason = "descriptor-missing";
    else if (client !== "opentui" && web[client === "web-a" ? 0 : 1]?.generation !== generation)
      reason = "generation-mismatch";
    else if (client !== "opentui" && !validCurrentRequest(descriptor))
      reason = "activated-request-invalid";
    else if (client !== "opentui" && descriptor.status === "missing")
      reason = "activated-request-missing";
    else if (client !== "opentui" && descriptor.status === "ambiguous")
      reason = "activated-request-ambiguous";
    else if (client !== "opentui" && descriptor.status === "overflow")
      reason = "activated-request-overflow";
    else if (!boundedIdentity(processIdentity)) reason = "process-missing";
    else if (client !== "opentui" && !/^[0-9a-f]{64}$/u.test(socketIdentity ?? ""))
      reason = "socket-missing";
    else if (client !== "opentui" && !/^[0-9a-f]{64}$/u.test(descriptor?.requestHmac ?? ""))
      reason = "request-missing";
    else if (
      client !== "opentui" &&
      closeRecords.some(
        ({ terminalDelivery }) =>
          boundedIdentity(terminalDelivery.deliveryRequestId) &&
          lifecycleHmac("request", terminalDelivery.deliveryRequestId, evidenceKey) ===
            descriptor.requestHmac,
      )
    )
      reason = "closed";
    else if (
      client === "opentui" &&
      closeRecords.some(({ terminalDelivery }) => terminalDelivery.deliverySurface === "opentui")
    )
      reason = "closed";
    else if (!record) reason = "request-no-active-open";
    else if (!boundedIdentity(delivery?.deliveryRequestId)) reason = "request-missing";
    else if (!boundedIdentity(delivery?.deliveryLaneId)) reason = "lane-missing";
    else if (!boundedIdentity(delivery?.deliveryClientId)) reason = "client-missing";
    else if (
      !Number.isSafeInteger(delivery?.deliveryLifecycleOrdinal) ||
      delivery.deliveryLifecycleOrdinal < 0
    )
      reason = "ordinal-invalid";
    else if (duplicateRequest) reason = "duplicate-request";
    else if (duplicateLane) reason = "duplicate-lane";
    else if (duplicateClient) reason = "duplicate-client";
    else if (active.length > 3) reason = "extra-active";
    else if (closeRecords.length > 0) reason = "closed";
    if (reason !== null && !CARD5_LIFECYCLE_REASONS.has(reason)) reason = "request-no-active-open";
    return Object.freeze({
      client,
      reason,
      assessed: true,
      descriptorObserved: descriptor?.descriptorCount === 1 || client === "opentui",
      activeOpenObserved: record !== undefined,
      candidateRequestHmac:
        client !== "opentui" && /^[0-9a-f]{64}$/u.test(descriptor?.requestHmac ?? "")
          ? descriptor.requestHmac
          : null,
      requestHmac: boundedIdentity(delivery?.deliveryRequestId)
        ? lifecycleHmac("request", delivery.deliveryRequestId, evidenceKey)
        : null,
      laneHmac: boundedIdentity(delivery?.deliveryLaneId)
        ? lifecycleHmac("lane", delivery.deliveryLaneId, evidenceKey)
        : null,
      clientHmac: boundedIdentity(delivery?.deliveryClientId)
        ? lifecycleHmac("client", delivery.deliveryClientId, evidenceKey)
        : null,
    });
  });
  const matchedRequests = new Set(
    exact
      .map(({ record }) => record?.terminalDelivery?.deliveryRequestId)
      .filter((requestId) => boundedIdentity(requestId)),
  );
  const unmatchedActive = active.filter(
    ({ terminalDelivery }) => !matchedRequests.has(terminalDelivery?.deliveryRequestId),
  );
  const passed = active.length === 3 && clients.every(({ reason }) => reason === null);
  const observation = Object.freeze({
    operation: "card5-host-lifecycle",
    stage,
    reason: passed ? null : "lifecycle-join-incomplete",
    generationHmac: lifecycleHmac("generation", generation, evidenceKey),
    paneHmac: lifecycleHmac("pane", pane, evidenceKey),
    openCount: Math.min(opens.length, 64),
    openOverflow: opens.length > 64,
    closeCount: Math.min(closeRecords.length, 64),
    closeOverflow: closeRecords.length > 64,
    activeCount: Math.min(active.length, 64),
    activeOverflow: active.length > 64,
    unmatchedActiveRequestHmacs: Object.freeze(
      unmatchedActive
        .slice(0, 8)
        .map(({ terminalDelivery }) =>
          lifecycleHmac("request", terminalDelivery.deliveryRequestId, evidenceKey),
        ),
    ),
    unmatchedActiveOverflow: unmatchedActive.length > 8,
    clients: Object.freeze(clients),
  });
  if (!passed) return Object.freeze({ passed: false, proof: null, observation });
  const proof = Object.freeze(
    exact.map(({ client, processIdentity, socketIdentity, descriptor, record }) => {
      const delivery = record.terminalDelivery;
      return Object.freeze({
        client,
        opened: client === "opentui" || descriptor.status === "exact",
        processHmac: lifecycleHmac("process", processIdentity, evidenceKey),
        requestHmac: lifecycleHmac("request", delivery.deliveryRequestId, evidenceKey),
        socketObserved: client !== "opentui",
        socketHmac: client === "opentui" ? null : socketIdentity,
        laneHmac: lifecycleHmac("lane", delivery.deliveryLaneId, evidenceKey),
        clientHmac: lifecycleHmac("client", delivery.deliveryClientId, evidenceKey),
        openOrdinal: delivery.deliveryLifecycleOrdinal,
      });
    }),
  );
  return Object.freeze({ passed: true, proof, observation });
}

export async function waitForCard5ObservedHostLifecycle({
  reader,
  observeWeb,
  assess,
  failureIdentity,
  timeoutMs = 5_000,
  now = Date.now,
  yieldTurn = (delayMs) => new Promise((resolveWait) => setTimeout(resolveWait, delayMs)),
  scheduleDeadline = (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
  onStableWeb = () => undefined,
}) {
  if (
    !reader ||
    typeof reader.read !== "function" ||
    typeof reader.snapshot !== "function" ||
    typeof reader.confirmCaughtUp !== "function" ||
    typeof observeWeb !== "function" ||
    typeof assess !== "function" ||
    typeof scheduleDeadline !== "function" ||
    typeof onStableWeb !== "function" ||
    !failureIdentity ||
    !new Set(["initial-host-lifecycle", "replacement-host-lifecycle"]).has(failureIdentity.stage) ||
    !boundedIdentity(failureIdentity.generation) ||
    !boundedIdentity(failureIdentity.pane) ||
    !/^[0-9a-f]{64}$/u.test(failureIdentity.evidenceKey ?? "") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5_000
  ) {
    throw new TypeError("Card5 lifecycle wait options are malformed");
  }
  const unavailableObservation = (reason) =>
    Object.freeze({
      operation: "card5-host-lifecycle",
      stage: failureIdentity.stage,
      reason,
      generationHmac: lifecycleHmac(
        "generation",
        failureIdentity.generation,
        failureIdentity.evidenceKey,
      ),
      paneHmac: lifecycleHmac("pane", failureIdentity.pane, failureIdentity.evidenceKey),
      openCount: null,
      openOverflow: null,
      closeCount: null,
      closeOverflow: null,
      activeCount: null,
      activeOverflow: null,
      unmatchedActiveRequestHmacs: Object.freeze([]),
      unmatchedActiveOverflow: null,
      clients: Object.freeze(
        ["opentui", "web-a", "web-b"].map((client) =>
          Object.freeze({
            client,
            reason: null,
            assessed: false,
            descriptorObserved: false,
            activeOpenObserved: false,
            candidateRequestHmac: null,
            requestHmac: null,
            laneHmac: null,
            clientHmac: null,
          }),
        ),
      ),
    });
  let lastClock = null;
  const readClock = () => {
    let value;
    try {
      value = now();
    } catch {
      return null;
    }
    if (!Number.isFinite(value) || (lastClock !== null && value < lastClock)) return null;
    lastClock = value;
    return value;
  };
  const startedAt = readClock();
  const deadline = startedAt === null ? null : startedAt + timeoutMs;
  let last =
    startedAt === null ? { observation: unavailableObservation("lifecycle-clock-invalid") } : null;
  let stableCandidate = null;
  let stableSamples = 0;
  const observeWithinDeadline = async () => {
    const before = readClock();
    if (before === null) return { status: "clock-invalid" };
    const remaining = deadline - before;
    if (remaining <= 0) return { status: "deadline" };
    const controller = new AbortController();
    let cancelDeadline = () => undefined;
    const operation = Promise.resolve().then(() =>
      observeWeb(Object.freeze({ signal: controller.signal, deadline })),
    );
    const settled = operation.then(
      (value) => ({ status: "ok", value }),
      () => ({ status: "source-unavailable" }),
    );
    const timeout = new Promise((resolveTimeout) => {
      cancelDeadline = scheduleDeadline(() => {
        controller.abort("lifecycle-deadline");
        resolveTimeout({ status: "deadline" });
      }, remaining);
    });
    const result = await Promise.race([settled, timeout]);
    cancelDeadline();
    if (result.status === "deadline") void settled;
    return result;
  };
  for (let turn = 0; turn < 256 && deadline !== null; turn += 1) {
    const beforeRead = readClock();
    if (beforeRead === null) {
      last = { observation: unavailableObservation("lifecycle-clock-invalid") };
      break;
    }
    if (beforeRead >= deadline) break;
    let records;
    let snapshot;
    let webBefore;
    try {
      const observedBefore = await observeWithinDeadline();
      if (observedBefore.status !== "ok") {
        last = {
          observation: unavailableObservation(
            observedBefore.status === "clock-invalid"
              ? "lifecycle-clock-invalid"
              : observedBefore.status === "deadline"
                ? "lifecycle-deadline"
                : "lifecycle-source-unavailable",
          ),
        };
        break;
      }
      webBefore = observedBefore.value;
      const afterWebBefore = readClock();
      if (afterWebBefore === null) {
        last = { observation: unavailableObservation("lifecycle-clock-invalid") };
        break;
      }
      if (afterWebBefore >= deadline) break;
      records = reader.read();
      const afterRead = readClock();
      if (afterRead === null) {
        last = { observation: unavailableObservation("lifecycle-clock-invalid") };
        break;
      }
      if (afterRead >= deadline) break;
      snapshot = reader.snapshot();
      last = assess(records, webBefore);
      const beforeConfirm = readClock();
      if (beforeConfirm === null) {
        last = { observation: unavailableObservation("lifecycle-clock-invalid") };
        break;
      }
      if (beforeConfirm >= deadline) break;
    } catch {
      last = { observation: unavailableObservation("lifecycle-source-unavailable") };
      break;
    }
    let confirmed;
    try {
      confirmed = snapshot.caughtUp && reader.confirmCaughtUp();
    } catch {
      last = { observation: unavailableObservation("lifecycle-source-unavailable") };
      break;
    }
    const afterConfirm = readClock();
    if (afterConfirm === null) {
      last = { observation: unavailableObservation("lifecycle-clock-invalid") };
      break;
    }
    if (afterConfirm >= deadline) break;
    let webAfter;
    let afterSnapshot;
    let afterConfirmed;
    try {
      const observedAfter = await observeWithinDeadline();
      if (observedAfter.status !== "ok") {
        last = {
          observation: unavailableObservation(
            observedAfter.status === "clock-invalid"
              ? "lifecycle-clock-invalid"
              : observedAfter.status === "deadline"
                ? "lifecycle-deadline"
                : "lifecycle-source-unavailable",
          ),
        };
        break;
      }
      webAfter = observedAfter.value;
      const afterWebAfter = readClock();
      if (afterWebAfter === null) {
        last = { observation: unavailableObservation("lifecycle-clock-invalid") };
        break;
      }
      if (afterWebAfter >= deadline) break;
      afterSnapshot = reader.snapshot();
      afterConfirmed = afterSnapshot.caughtUp && reader.confirmCaughtUp();
      const afterSecondConfirm = readClock();
      if (afterSecondConfirm === null) {
        last = { observation: unavailableObservation("lifecycle-clock-invalid") };
        break;
      }
      if (afterSecondConfirm >= deadline) break;
      last = assess(records, webAfter);
    } catch {
      last = { observation: unavailableObservation("lifecycle-source-unavailable") };
      break;
    }
    const daemonCandidate = `${snapshot.offset}\0${snapshot.recordCount}\0${snapshot.retainedRecordBytes}`;
    const daemonStable =
      confirmed &&
      afterConfirmed &&
      afterSnapshot.offset === snapshot.offset &&
      afterSnapshot.recordCount === snapshot.recordCount &&
      afterSnapshot.retainedRecordBytes === snapshot.retainedRecordBytes;
    const webCandidate = (web) =>
      JSON.stringify(
        web.map((entry) => ({
          generation: entry?.generation ?? null,
          workspaceName: entry?.workspaceName ?? null,
          semanticPaneId: entry?.semanticPaneId ?? null,
          processIdentity: entry?.processIdentity ?? null,
          currentLifecycleRequest: entry?.runtimeReplacement?.currentLifecycleRequest ?? null,
        })),
      );
    const beforeWebCandidate = webCandidate(webBefore);
    const afterWebCandidate = webCandidate(webAfter);
    const candidate =
      daemonStable && beforeWebCandidate === afterWebCandidate && last?.passed === true
        ? `${daemonCandidate}\0${afterWebCandidate}\0${JSON.stringify(last.proof)}`
        : null;
    const afterCandidate = readClock();
    if (afterCandidate === null) {
      last = { observation: unavailableObservation("lifecycle-clock-invalid") };
      break;
    }
    if (afterCandidate >= deadline) {
      last = { observation: unavailableObservation("lifecycle-deadline") };
      break;
    }
    if (candidate !== null) {
      if (candidate === stableCandidate) stableSamples += 1;
      else {
        stableCandidate = candidate;
        stableSamples = 1;
      }
      if (stableSamples >= 2) {
        const beforeAcceptance = readClock();
        if (beforeAcceptance === null) {
          last = { observation: unavailableObservation("lifecycle-clock-invalid") };
          break;
        }
        if (beforeAcceptance >= deadline) {
          last = { observation: unavailableObservation("lifecycle-deadline") };
          break;
        }
        onStableWeb(webAfter);
        return last.proof;
      }
    } else {
      stableCandidate = null;
      stableSamples = 0;
    }
    const beforeYield = readClock();
    if (beforeYield === null) {
      last = { observation: unavailableObservation("lifecycle-clock-invalid") };
      break;
    }
    const remaining = deadline - beforeYield;
    if (remaining <= 0) break;
    try {
      await yieldTurn(Math.min(25, remaining));
    } catch {
      last = { observation: unavailableObservation("lifecycle-source-unavailable") };
      break;
    }
  }
  const error = new Error("Card5 production host lifecycle is incomplete or ambiguous");
  const finalObservation =
    last?.passed === true
      ? Object.freeze({ ...last.observation, reason: "lifecycle-tail-unstable" })
      : (last?.observation ?? unavailableObservation("lifecycle-deadline"));
  error.observation = Object.freeze({
    ...finalObservation,
    stableTail: false,
  });
  throw error;
}

function exactLoopbackUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !LOOPBACK.has(url.hostname) ||
    url.username ||
    url.password ||
    !url.port
  ) {
    throw new TypeError("Card5 host URL must be credential-free explicit-port loopback HTTP");
  }
  return url.toString();
}

function exactOwnedPath(path, root) {
  if (!isAbsolute(path) || !isAbsolute(root))
    throw new TypeError("Card5 host paths must be absolute");
  const exactRoot = resolve(root);
  const exactPath = resolve(path);
  if (exactPath !== exactRoot && !exactPath.startsWith(`${exactRoot}/`)) {
    throw new TypeError("Card5 host path is outside the ProductRig namespace");
  }
  return exactPath;
}

/** Static launch authority for the three real adapters; contains no bearer capability. */
export function card5ProductionHostTopology(input) {
  const pageUrl = exactLoopbackUrl(input.pageUrl);
  const runtimeRoot = exactOwnedPath(input.runtimeRoot, input.runtimeRoot);
  const electronUserData = exactOwnedPath(input.electronUserData, runtimeRoot);
  const daemonInfoPath = exactOwnedPath(input.daemonInfoPath, runtimeRoot);
  if (!/^[a-z0-9][a-z0-9:-]{0,127}$/u.test(input.cleanupToken ?? "")) {
    throw new TypeError("Card5 cleanup token is malformed");
  }
  return Object.freeze({
    clients: Object.freeze([
      Object.freeze({ id: "opentui", host: "opentui", productionAdapter: true }),
      Object.freeze({ id: "web-a", host: "chromium", issuedDescriptorOnly: true }),
      Object.freeze({ id: "web-b", host: "electron", preloadBrokerOnly: true }),
    ]),
    chromium: Object.freeze({ pageUrl, contextCount: 1, pageCount: 1 }),
    electron: Object.freeze({
      rendererUrl: pageUrl,
      userData: electronUserData,
      daemonInfoPath,
      browserWindowCount: 1,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    }),
    nativeObserver: Object.freeze({ readOnly: true, attachClient: false }),
    ownership: Object.freeze({ runtimeRoot, cleanupToken: input.cleanupToken }),
  });
}

export function validateCard5NativeObserverCommand(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 16) {
    throw new TypeError("Card5 native observer command is malformed");
  }
  const command = argv[0];
  if (!READ_ONLY_TMUX.has(command)) {
    throw new TypeError("Card5 native observer cannot mutate or attach tmux");
  }
  if (
    argv.some((value) => typeof value !== "string" || value.length > 512 || /[\0\r\n]/u.test(value))
  ) {
    throw new TypeError("Card5 native observer argument is malformed");
  }
  if (command === "display-message" && !argv.includes("-p")) {
    throw new TypeError("Card5 display-message observer must print without mutation");
  }
  return Object.freeze([...argv]);
}

export function card5HostCleanupStatus(input) {
  const exact = ["chromium", "electron", "opentui", "daemon", "namespace"];
  const entries = input?.entries;
  const passed =
    entries &&
    Object.keys(entries).sort().join("\0") === [...exact].sort().join("\0") &&
    exact.every(
      (name) =>
        typeof entries[name]?.owned === "boolean" &&
        entries[name]?.retired === true &&
        (entries[name].owned === true || entries[name]?.reason === "not-acquired"),
    ) &&
    input.chromiumProcessCount === 0 &&
    input.chromiumDescendantCount === 0 &&
    input.chromiumPageCount === 0 &&
    input.chromiumContextCount === 0 &&
    input.chromiumListenerCount === 0 &&
    input.electronProcessCount === 0 &&
    input.electronDescendantCount === 0 &&
    input.electronWindowCount === 0 &&
    input.electronListenerCount === 0 &&
    input.electronOpenHandleCount === 0 &&
    input.socketResidueCount === 0 &&
    input.nativeObserverProcessCount === 0 &&
    input.pathResidueCount === 0;
  const boundedCount = (value, cap) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, cap) : null;
  return Object.freeze({
    passed: passed === true,
    retiredOwners: exact.filter((name) => entries?.[name]?.retired === true).length,
    launchStage:
      typeof input?.launchStage === "string" ? input.launchStage.slice(0, 64) : "unknown",
    owners: Object.freeze(
      Object.fromEntries(
        exact.map((name) => [
          name,
          Object.freeze({
            owned: entries?.[name]?.owned === true,
            retired: entries?.[name]?.retired === true,
            reason:
              typeof entries?.[name]?.reason === "string"
                ? entries[name].reason.slice(0, 64)
                : "unknown",
          }),
        ]),
      ),
    ),
    chromiumProcessCount: boundedCount(input?.chromiumProcessCount, 32),
    chromiumDescendantCount: boundedCount(input?.chromiumDescendantCount, 256),
    chromiumPageCount: boundedCount(input?.chromiumPageCount, 32),
    chromiumContextCount: boundedCount(input?.chromiumContextCount, 32),
    chromiumListenerCount: boundedCount(input?.chromiumListenerCount, 64),
    electronProcessCount: boundedCount(input?.electronProcessCount, 32),
    electronDescendantCount: boundedCount(input?.electronDescendantCount, 256),
    electronWindowCount: boundedCount(input?.electronWindowCount, 32),
    electronListenerCount: boundedCount(input?.electronListenerCount, 64),
    electronOpenHandleCount: boundedCount(input?.electronOpenHandleCount, 256),
    socketResidueCount: boundedCount(input?.socketResidueCount, 32),
    nativeObserverProcessCount: boundedCount(input?.nativeObserverProcessCount, 32),
    pathResidueCount: boundedCount(input?.pathResidueCount, 32),
  });
}
