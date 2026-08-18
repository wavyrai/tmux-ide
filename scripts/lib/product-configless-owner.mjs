import { join } from "node:path";

export const CONFIGLESS_TMUX_SESSION_FIELD_SEPARATOR = "|tmux-ide-configless-session-field-v1|";
export const CONFIGLESS_TMUX_SESSION_ROW_SENTINEL = "tmux-ide-configless-session-row-v1";
export const CONFIGLESS_TMUX_SESSION_FORMAT = [
  "#{session_name}",
  "#{session_id}",
  "#{@tmux_ide_adopted}",
  "#{@tmux_ide_workspace_promoted_v1}",
  "#{@tmux_ide_workspace_name}",
  "#{@tmux_ide_workspace_promote_operation}",
  "#{@tmux_ide_workspace_open_v1}",
  "#{@tmux_ide_workspace_open_operation}",
  CONFIGLESS_TMUX_SESSION_ROW_SENTINEL,
].join(CONFIGLESS_TMUX_SESSION_FIELD_SEPARATOR);

const CONFIGLESS_TMUX_SESSION_OUTPUT_MAX_BYTES = 64 * 1024;

function containsControlCharacter(value, { allowLineFeed = false } = {}) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === 0x7f || (codePoint < 0x20 && !(allowLineFeed && codePoint === 0x0a));
  });
}

export function parseConfiglessTmuxSessionInventory(raw, expectedSessionName) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > CONFIGLESS_TMUX_SESSION_OUTPUT_MAX_BYTES ||
    typeof expectedSessionName !== "string" ||
    expectedSessionName.length === 0 ||
    expectedSessionName.length > 128 ||
    containsControlCharacter(expectedSessionName)
  )
    throw new Error("configless tmux session inventory input is malformed");
  const lines = raw.trimEnd() === "" ? [] : raw.trimEnd().split("\n");
  const rows = lines.map((line) => {
    const fields = line.split(CONFIGLESS_TMUX_SESSION_FIELD_SEPARATOR);
    if (
      fields.length !== 9 ||
      fields[8] !== CONFIGLESS_TMUX_SESSION_ROW_SENTINEL ||
      fields[0].length === 0 ||
      fields[0].length > 128 ||
      containsControlCharacter(fields[0]) ||
      !/^\$[0-9]+$/u.test(fields[1]) ||
      fields.slice(2, 8).some((field) => field.length > 512)
    )
      throw new Error("configless tmux session inventory row is malformed");
    return Object.freeze({
      sessionName: fields[0],
      sessionId: fields[1],
      adoptionStamp: fields[2] || null,
      promotedStamp: fields[3] || null,
      workspaceNameStamp: fields[4] || null,
      promotionOperationStamp: fields[5] || null,
      workspaceOpenStamp: fields[6] || null,
      workspaceOpenOperationStamp: fields[7] || null,
    });
  });
  const exact = rows.filter(({ sessionName }) => sessionName === expectedSessionName);
  if (exact.length !== 1)
    throw new Error(
      `configless tmux session inventory expected one exact session row, received ${exact.length}`,
    );
  return Object.freeze({
    sessionNames: Object.freeze(rows.map(({ sessionName }) => sessionName)),
    exact: exact[0],
  });
}

export function createFreshFleetCatalogReader(read) {
  let readOrdinal = 0;
  return async () => {
    readOrdinal = readOrdinal === Number.MAX_SAFE_INTEGER ? 1 : readOrdinal + 1;
    return read(`/api/resources/fleet-catalog?productRigRead=${readOrdinal}`, {
      cache: "no-store",
    });
  };
}

export function configlessPublicEnvironment(namespace) {
  return Object.freeze({
    HOME: namespace.home,
    XDG_CONFIG_HOME: join(namespace.home, ".config"),
    TMUX: "",
    TMUX_IDE_HOME: namespace.stateDir,
    TMUX_IDE_CONFIG: join(namespace.stateDir, "config.json"),
    TMUX_IDE_DAEMON_INFO_DIR: namespace.daemonInfoDir,
    TMUX_IDE_REGISTRY_DIR: namespace.registryDir,
    TMUX_IDE_SETTINGS_DIR: namespace.settingsDir,
    TMUX_IDE_TMUX_SOCKET_PATH: namespace.tmuxSocketPath,
  });
}

export function buildProductDiagnosticCorrelation({
  state,
  tuiAvailable,
  webAvailable,
  web,
  expected = null,
}) {
  const committed = state?.convergence?.workspaceClient?.committed ?? null;
  const pending = state?.convergence?.workspaceClient?.pending ?? null;
  const derived = state?.convergence?.workspaceClient?.derived ?? null;
  const daemonRevision = state?.daemon?.revision ?? state?.workspace?.revision ?? null;
  const daemonRevisionKind = state?.daemon?.revisionKind ?? null;
  const resourceIdentity = (resources) =>
    Array.isArray(resources)
      ? [...resources]
          .map(({ resourceId, windowResourceId, active, semanticPaneId }) =>
            JSON.stringify([resourceId, windowResourceId, active, semanticPaneId ?? null]),
          )
          .sort()
          .join("\n")
      : null;
  const strictExpected = expected !== null;
  const exactExpected = Boolean(
    expected &&
    typeof expected.daemonGeneration === "string" &&
    typeof expected.workspaceName === "string" &&
    typeof expected.sessionName === "string" &&
    typeof expected.fleetSessionId === "string" &&
    typeof expected.catalogRevision === "string" &&
    typeof expected.semanticPaneId === "string",
  );
  let workspaceClientExact = !strictExpected;
  if (exactExpected) {
    try {
      qualifyWorkspaceClientState(
        [
          {
            phase: "generation-workspace-client-state",
            processId: state?.convergence?.workspaceClient?.record?.processId,
            daemonGeneration: expected.daemonGeneration,
            workspaceClient: { committed, pending, derived },
          },
        ],
        {
          ...expected,
          processId: state?.convergence?.workspaceClient?.record?.processId,
          canonicalGeneration: expected.daemonGeneration,
        },
      );
      workspaceClientExact = true;
    } catch {
      workspaceClientExact = false;
    }
  }
  const host = web?.hostCorrelation ?? null;
  const expectedResources = committed?.terminalResources ?? null;
  const webResources = host?.terminalResources ?? null;
  const selectedWindowExact = exactExpected
    ? qualifySelectedWindowWebSemantic({
        web,
        derivedResources: derived?.terminalInventory?.resources,
        expectedWorkspaceName: expected.workspaceName,
        expectedSemanticPaneId: expected.semanticPaneId,
      })
    : false;
  const webSemanticComplete = strictExpected
    ? Boolean(
        exactExpected &&
        webAvailable &&
        web?.shellSource === "runtime" &&
        host?.bootstrapDaemon === expected.daemonGeneration &&
        host?.listDaemon === expected.daemonGeneration &&
        host?.shellDaemon === expected.daemonGeneration &&
        host?.domDaemonGeneration === expected.daemonGeneration &&
        host?.workspaceRow?.workspaceName === expected.workspaceName &&
        host?.workspaceRow?.sessionName === expected.sessionName &&
        host?.workspaceRow?.availability === "live" &&
        host?.shellWorkspaceId === derived?.workspace?.id &&
        host?.shellWorkspaceName === derived?.workspace?.name &&
        host?.shellFleetSessionId === expected.fleetSessionId &&
        resourceIdentity(webResources) !== null &&
        resourceIdentity(webResources) === resourceIdentity(expectedResources) &&
        selectedWindowExact,
      )
    : Boolean(webAvailable && web?.shellSource && web?.terminalPhases?.length > 0);
  const webSemantic =
    webAvailable && web
      ? {
          shellSource: web.shellSource ?? null,
          terminalPhases: web.terminalPhases ?? [],
          terminals: web.terminals ?? [],
          hostCorrelation: host,
        }
      : null;
  const daemonRevisionComplete = strictExpected
    ? exactExpected &&
      /^[0-9a-f]{20}$/u.test(daemonRevision ?? "") &&
      daemonRevision === expected.catalogRevision &&
      daemonRevisionKind === "fleet-catalog"
    : daemonRevision !== null;
  const missing = [
    ...(!daemonRevisionComplete ? ["daemon.revision"] : []),
    ...(committed === null ? ["workspaceClient.committed"] : []),
    ...(pending === null ? ["workspaceClient.pending"] : []),
    ...(derived === null ? ["workspaceClient.derived"] : []),
    ...(!workspaceClientExact ? ["workspaceClient.correlation"] : []),
    ...(!tuiAvailable ? ["tui.frame"] : []),
    ...(!webAvailable ? ["web.png"] : []),
    ...(!webSemanticComplete ? ["web.semantic"] : []),
  ];
  return Object.freeze({
    complete: missing.length === 0,
    missing: Object.freeze(missing),
    daemonState: {
      instanceId: state?.daemon?.instanceId ?? null,
      revision: daemonRevision,
      revisionKind: daemonRevisionKind,
      pid: state?.daemon?.pid ?? null,
      port: state?.daemon?.port ?? null,
      status: state?.status ?? "unavailable",
      correlationComplete: daemonRevisionComplete,
    },
    clientState: {
      committed,
      pending,
      derived,
      webSemantic,
      correlationComplete: missing.length === 0,
      missing,
    },
    availability: { tui: tuiAvailable, web: webAvailable },
  });
}

export function qualifySelectedWindowWebSemantic({
  web,
  derivedResources,
  expectedWorkspaceName,
  expectedSemanticPaneId,
}) {
  try {
    if (
      web?.windowContainerCount !== 1 ||
      !Array.isArray(web.windows) ||
      !Array.isArray(web.terminals) ||
      !Array.isArray(derivedResources) ||
      web.windows.length === 0 ||
      web.windows.length > 512 ||
      web.terminals.length !== 1
    )
      return false;
    const groups = new Map();
    for (const resource of derivedResources) {
      if (resource?.attachability?.status !== "available") continue;
      const windowResourceId = resource.windowResourceId ?? resource.id;
      const pane = resource.attachability.semanticPaneId;
      if (
        typeof windowResourceId !== "string" ||
        typeof pane !== "string" ||
        windowResourceId.length === 0 ||
        pane.length === 0
      )
        return false;
      const group = groups.get(windowResourceId) ?? { panes: [], activePanes: [] };
      if (group.panes.includes(pane)) return false;
      group.panes.push(pane);
      if (resource.active === true) group.activePanes.push(pane);
      groups.set(windowResourceId, group);
    }
    if (groups.size !== web.windows.length || groups.size === 0) return false;
    const derivedActiveGroups = [...groups.entries()].filter(
      ([, group]) => group.activePanes.length > 0,
    );
    if (
      derivedActiveGroups.length !== 1 ||
      derivedActiveGroups[0][1].activePanes.length !== 1 ||
      derivedActiveGroups[0][1].activePanes[0] !== expectedSemanticPaneId
    )
      return false;
    const seenWindows = new Set();
    const seenPanes = new Set();
    let activeGroup = null;
    for (const window of web.windows) {
      if (
        typeof window?.windowResourceId !== "string" ||
        window.windowResourceId.length === 0 ||
        seenWindows.has(window.windowResourceId) ||
        !groups.has(window.windowResourceId)
      )
        return false;
      seenWindows.add(window.windowResourceId);
      let panes;
      try {
        panes = JSON.parse(window.semanticPaneIds);
      } catch {
        return false;
      }
      if (
        !Array.isArray(panes) ||
        panes.length === 0 ||
        panes.length > 512 ||
        panes.some((pane) => typeof pane !== "string" || pane.length === 0 || seenPanes.has(pane))
      )
        return false;
      for (const pane of panes) seenPanes.add(pane);
      const sorted = [...panes].sort();
      if (JSON.stringify(panes) !== JSON.stringify(sorted)) return false;
      const expectedPanes = [...groups.get(window.windowResourceId).panes].sort();
      if (
        JSON.stringify(sorted) !== JSON.stringify(expectedPanes) ||
        window.paneCount !== String(panes.length) ||
        !["true", "false"].includes(window.active)
      )
        return false;
      if (window.active === "true") {
        if (activeGroup !== null) return false;
        if (window.windowResourceId !== derivedActiveGroups[0][0]) return false;
        activeGroup = new Set(panes);
      }
    }
    const terminal = web.terminals[0];
    return Boolean(
      activeGroup &&
      activeGroup.has(expectedSemanticPaneId) &&
      terminal.phase === "connected" &&
      terminal.workspaceName === expectedWorkspaceName &&
      terminal.semanticPaneId === expectedSemanticPaneId,
    );
  } catch {
    return false;
  }
}

export function qualifyCanonicalSeedPaint(records, expected) {
  const matchesExpectedSource = (record) =>
    record?.semanticPaneId === expected.semanticPaneId &&
    record.generation === expected.generation &&
    record.processId === expected.processId &&
    record.clockId === expected.clockId &&
    record.clockKind === "performance-now" &&
    record.sourceEpoch === expected.sourceEpoch;
  const publications = records.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-publication" &&
      matchesExpectedSource(record) &&
      record.cols === expected.canonicalCols &&
      record.rows === expected.canonicalRows,
  );
  const paints = records.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-paint" &&
      matchesExpectedSource(record) &&
      record.cols === expected.canonicalCols &&
      record.rows === expected.canonicalRows &&
      record.viewportCols === expected.viewportCols &&
      record.viewportRows === expected.viewportRows,
  );
  try {
    if (publications.length !== 1 || paints.length !== 1)
      throw new Error(
        `canonical seed proof requires one stable-geometry publication and one paint, received ${publications.length}/${paints.length}`,
      );
    const publication = publications[0];
    const paint = paints[0];
    if (publication.updateType !== "terminal.seed")
      throw new Error("canonical publication was not an exact terminal.seed");
    if (
      typeof publication.incarnation !== "string" ||
      publication.incarnation.length === 0 ||
      publication.incarnation.length > 256
    )
      throw new Error("canonical seed incarnation is missing or malformed");
    if (!Number.isSafeInteger(publication.revision) || publication.revision < 0)
      throw new Error("canonical seed revision is missing or malformed");
    if (typeof publication.stateHash !== "string" || !/^[0-9a-f]{16}$/u.test(publication.stateHash))
      throw new Error("canonical seed stateHash is missing or malformed");
    for (const key of [
      "processId",
      "clockId",
      "clockKind",
      "semanticPaneId",
      "generation",
      "incarnation",
      "revision",
      "stateHash",
      "cols",
      "rows",
      "sourceEpoch",
    ])
      if (publication[key] !== paint[key])
        throw new Error(`canonical seed paint identity diverged at ${key}`);
    const publicationIndex = records.indexOf(publication);
    const paintIndex = records.indexOf(paint);
    if (
      publicationIndex < 0 ||
      paintIndex <= publicationIndex ||
      !Number.isFinite(publication.atMicros) ||
      !Number.isFinite(paint.atMicros) ||
      paint.atMicros < publication.atMicros
    )
      throw new Error("canonical seed paint order is invalid");
    const interveningCanonicalUpdate = records
      .slice(publicationIndex + 1, paintIndex)
      .some(
        (record) =>
          record?.type === "performance.terminal-canonical-publication" &&
          matchesExpectedSource(record),
      );
    if (interveningCanonicalUpdate)
      throw new Error("canonical seed paint followed an intervening canonical update");
    if (
      !Array.isArray(paint.writtenRows) ||
      paint.writtenRows.length !== expected.viewportRows ||
      paint.writtenRows.some((row, index) => row !== index)
    )
      throw new Error("canonical seed paint did not write every visible terminal row exactly once");
    return Object.freeze({ publication, paint });
  } catch (error) {
    if (error instanceof Error) {
      error.boundary = "canonical-seed-paint-correlation";
      error.observation = Object.freeze({
        semanticPaneId: expected.semanticPaneId,
        generation: expected.generation,
        processId: expected.processId,
        clockId: expected.clockId,
        sourceEpoch: expected.sourceEpoch,
        canonicalGeometry: Object.freeze({
          cols: expected.canonicalCols,
          rows: expected.canonicalRows,
        }),
        viewportGeometry: Object.freeze({
          cols: expected.viewportCols,
          rows: expected.viewportRows,
        }),
        matchingPublications: publications.length,
        matchingPaints: paints.length,
      });
    }
    throw error;
  }
}

export function qualifyPreseededPaneEvidence(sample, { throwOnFailure = false } = {}) {
  const passed = Boolean(
    sample?.geometryStable &&
    sample?.bodyRect?.valid &&
    sample.bodyRect.bodyRows === sample?.geometry?.height &&
    sample.nativeTargetOccurrences === 1 &&
    sample.nativeOtherOccurrences === 0 &&
    sample.renderedTargetOccurrences === 1 &&
    sample.renderedOutsideOccurrences === 0,
  );
  if (!passed && throwOnFailure) {
    const error = new Error(`preseeded coherent pane proof failed: ${JSON.stringify(sample)}`);
    error.boundary = "coherent-terminal-publication";
    error.observation = Object.freeze({
      paneId: sample?.paneId ?? null,
      semanticPaneId: sample?.semanticPaneId ?? null,
      geometryStable: sample?.geometryStable === true,
      bodyRectValid: sample?.bodyRect?.valid === true,
      nativeTargetOccurrences: sample?.nativeTargetOccurrences ?? null,
      nativeOtherOccurrences: sample?.nativeOtherOccurrences ?? null,
      renderedTargetOccurrences: sample?.renderedTargetOccurrences ?? null,
      renderedOutsideOccurrences: sample?.renderedOutsideOccurrences ?? null,
    });
    throw error;
  }
  return passed;
}

export async function waitForCanonicalFrameFence(
  readRecords,
  expected,
  {
    timeoutMs = 5_000,
    now = () => performance.now(),
    sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  } = {},
) {
  let samples = 0;
  let matchingFences = 0;
  let reason = "timeout";
  try {
    let deadline;
    try {
      deadline = now() + timeoutMs;
    } catch (error) {
      reason = "clock-failed";
      throw error;
    }
    let waiting = true;
    while (waiting) {
      let records;
      try {
        records = readRecords();
      } catch (error) {
        reason = "read-failed";
        throw error;
      }
      samples += 1;
      if (!Array.isArray(records)) {
        reason = "malformed-records";
        throw new Error("trace reader returned malformed records");
      }
      const fences = records.filter(
        (record) =>
          record?.type === "performance.terminal-frame-fence" &&
          record.processId === expected.processId &&
          record.clockId === expected.clockId &&
          record.clockKind === "performance-now" &&
          record.daemonGeneration === expected.daemonGeneration &&
          record.rendererEpoch === expected.rendererEpoch &&
          (expected.semanticPaneId === undefined ||
            record.semanticPaneId === expected.semanticPaneId) &&
          (expected.sourceEpoch === undefined || record.sourceEpoch === expected.sourceEpoch) &&
          (expected.canonicalCols === undefined || record.cols === expected.canonicalCols) &&
          (expected.canonicalRows === undefined || record.rows === expected.canonicalRows) &&
          (expected.viewportCols === undefined || record.viewportCols === expected.viewportCols) &&
          (expected.viewportRows === undefined || record.viewportRows === expected.viewportRows),
      );
      matchingFences = fences.length;
      if (fences.length > 1) {
        reason = "duplicate";
        throw new Error("duplicate exact fences");
      }
      if (fences.length === 1) {
        const health = fences[0].writerHealth;
        if (
          health?.droppedRecords !== 0 ||
          health?.oversizedRecords !== 0 ||
          health?.failed !== false
        ) {
          reason = "unhealthy";
          throw new Error("unhealthy writer state");
        }
        return Object.freeze({ records, fence: fences[0] });
      }
      try {
        await sleep(10);
      } catch (error) {
        reason = "wait-failed";
        throw error;
      }
      let observedAt;
      try {
        observedAt = now();
      } catch (error) {
        reason = "clock-failed";
        throw error;
      }
      if (observedAt >= deadline) waiting = false;
    }
    throw new Error("fence deadline elapsed");
  } catch (cause) {
    const error = new Error(`coherent frame trace fence failed: ${reason}`, { cause });
    error.boundary = "coherent-terminal-publication";
    error.observation = Object.freeze({
      reason,
      samples,
      matchingFences,
      processId: typeof expected.processId === "string" ? expected.processId.slice(0, 128) : null,
      clockId: typeof expected.clockId === "string" ? expected.clockId.slice(0, 128) : null,
      daemonGeneration:
        typeof expected.daemonGeneration === "string"
          ? expected.daemonGeneration.slice(0, 128)
          : null,
      rendererEpoch:
        Number.isSafeInteger(expected.rendererEpoch) && expected.rendererEpoch >= 0
          ? expected.rendererEpoch
          : null,
    });
    throw error;
  }
}

export function qualifyCoherentFrameCausality(
  lifecycle,
  canonicalSeedPaint,
  generation,
  canonicalRecords = [],
) {
  const starts = lifecycle.filter(
    (record) =>
      record?.phase === "generation-connection-start" && record.daemonGeneration === generation,
  );
  const connections = lifecycle.filter(
    (record) =>
      record?.phase === "generation-connection-resolved" && record.daemonGeneration === generation,
  );
  const publications = lifecycle.filter(
    (record) =>
      record?.phase === "generation-host-internal-snapshot-publication" &&
      record.publicationPhase === "internal-snapshot-published" &&
      record.daemonGeneration === generation,
  );
  const frames = lifecycle.filter(
    (record) => record?.phase === "first-terminal-frame" && record.daemonGeneration === generation,
  );
  const paint = canonicalSeedPaint?.paint;
  const exactPaintIdentity = (record) =>
    Boolean(paint) &&
    record?.processId === paint.processId &&
    record.clockId === paint.clockId &&
    record.clockKind === "performance-now" &&
    record.semanticPaneId === paint.semanticPaneId &&
    record.generation === paint.generation &&
    record.incarnation === paint.incarnation &&
    record.revision === paint.revision &&
    record.stateHash === paint.stateHash &&
    record.cols === paint.cols &&
    record.rows === paint.rows &&
    record.sourceEpoch === paint.sourceEpoch &&
    record.viewportCols === paint.viewportCols &&
    record.viewportRows === paint.viewportRows;
  const canonicalHostFrames = canonicalRecords.filter(
    (record) =>
      record?.type === "performance.terminal-canonical-host-frame" && exactPaintIdentity(record),
  );
  const fences = canonicalRecords.filter(
    (record) =>
      record?.type === "performance.terminal-frame-fence" &&
      record.daemonGeneration === generation &&
      exactPaintIdentity(record),
  );
  let failureReason = "unknown";
  let predicates = Object.freeze({});
  try {
    if (
      starts.length !== 1 ||
      connections.length !== 1 ||
      publications.length !== 1 ||
      frames.length !== 1
    ) {
      failureReason = "lifecycle-cardinality";
      throw new Error(
        "coherent frame causality requires one exact connection start/resolution/publication/frame",
      );
    }
    const start = starts[0];
    const connection = connections[0];
    const internalPublication = publications[0];
    const firstTerminalFrame = frames[0];
    if (canonicalHostFrames.length !== 1 || fences.length !== 1) {
      failureReason = "keyed-frame-or-fence-cardinality";
      throw new Error("coherent frame requires one exact keyed host frame and fence");
    }
    const hostFrame = canonicalHostFrames[0];
    const fence = fences[0];
    const sameClock = [start, connection, internalPublication, hostFrame].every(
      (record) =>
        record.processId === paint?.processId &&
        record.clockId === paint?.clockId &&
        (record === hostFrame
          ? Number.isFinite(record.atMicros)
          : Number.isFinite(record.monotonicMicros) && Number.isFinite(record.elapsedMs)),
    );
    const sameEpoch =
      Number.isSafeInteger(internalPublication.rendererEpoch) &&
      internalPublication.rendererEpoch >= 0 &&
      internalPublication.rendererEpoch === firstTerminalFrame.rendererEpoch &&
      internalPublication.rendererEpoch === hostFrame.rendererEpoch &&
      internalPublication.rendererEpoch === fence.rendererEpoch;
    predicates = Object.freeze({
      sameClock,
      sameEpoch,
      paintIdentity: paint?.generation === generation && exactPaintIdentity(hostFrame),
      startBeforeConnection: start.monotonicMicros <= connection.monotonicMicros,
      connectionBeforePublication:
        connection.monotonicMicros <= internalPublication.monotonicMicros,
      publicationBeforeFirstFrame:
        internalPublication.monotonicMicros <= firstTerminalFrame.monotonicMicros,
      publicationBeforePaint: internalPublication.monotonicMicros <= paint?.atMicros,
      paintBeforeHostFrame: paint?.atMicros <= hostFrame.atMicros,
      hostFrameBeforeFence: hostFrame.atMicros <= fence.atMicros,
    });
    if (Object.values(predicates).some((passed) => passed !== true)) {
      failureReason = "identity-or-order";
      throw new Error("coherent frame causality identity or ordering mismatch");
    }
    const paintIndex = canonicalRecords.indexOf(paint);
    if (paintIndex < 0) {
      failureReason = "paint-absent";
      throw new Error("coherent target paint is absent from the exact trace");
    }
    const hostFrameIndex = canonicalRecords.indexOf(hostFrame);
    const fenceIndex = canonicalRecords.indexOf(fence);
    predicates = Object.freeze({
      ...predicates,
      hostFrameAfterPaintRecord: hostFrameIndex > paintIndex,
      fenceAfterHostFrameRecord: fenceIndex > hostFrameIndex,
      fenceClock: fence.clockKind === "performance-now" && Number.isFinite(fence.atMicros),
      fenceWriterHealthy:
        fence.writerHealth?.droppedRecords === 0 &&
        fence.writerHealth?.oversizedRecords === 0 &&
        fence.writerHealth?.failed === false,
      identityDropsZero: fence.identityDrops === 0,
    });
    if (Object.values(predicates).some((passed) => passed !== true)) {
      failureReason = "fence-unhealthy-or-out-of-order";
      throw new Error("coherent frame trace fence is missing, unhealthy, or out of order");
    }
    const progressedBeforeFrame = canonicalRecords
      .slice(paintIndex + 1, fenceIndex)
      .some(
        (record) =>
          record?.type === "performance.terminal-canonical-update" &&
          record.updateType === "terminal.patch" &&
          record.processId === paint.processId &&
          record.clockId === paint.clockId &&
          record.generation === generation &&
          record.semanticPaneId === paint.semanticPaneId &&
          record.sourceEpoch === paint.sourceEpoch &&
          Number.isFinite(record.atMicros) &&
          record.atMicros >= paint.atMicros,
      );
    predicates = Object.freeze({
      ...predicates,
      noCanonicalUpdateBeforeHostFrame: !progressedBeforeFrame,
    });
    if (progressedBeforeFrame) {
      failureReason = "canonical-update-before-host-frame";
      throw new Error("coherent frame followed a later canonical update before host publication");
    }
    const connectToCoherentMs = (hostFrame.atMicros - start.monotonicMicros) / 1_000;
    predicates = Object.freeze({
      ...predicates,
      connectDurationValid: Number.isFinite(connectToCoherentMs) && connectToCoherentMs >= 0,
    });
    if (!Number.isFinite(connectToCoherentMs) || connectToCoherentMs < 0) {
      failureReason = "duration-invalid";
      throw new Error("coherent frame duration is invalid");
    }
    return Object.freeze({
      start,
      connection,
      internalPublication,
      firstTerminalFrame,
      hostFrame,
      connectToCoherentMs,
    });
  } catch (error) {
    if (error instanceof Error) {
      error.boundary = "coherent-terminal-publication";
      error.observation = Object.freeze({
        daemonGeneration: generation,
        reason: failureReason,
        starts: starts.length,
        connections: connections.length,
        internalPublications: publications.length,
        hostFrames: frames.length,
        canonicalHostFrames: canonicalHostFrames.length,
        fences: fences.length,
        predicates,
        timestamps: Object.freeze({
          start: starts[0]?.monotonicMicros ?? null,
          connection: connections[0]?.monotonicMicros ?? null,
          internalPublication: publications[0]?.monotonicMicros ?? null,
          firstTerminalFrame: frames[0]?.monotonicMicros ?? null,
          paint: paint?.atMicros ?? null,
          hostFrame: canonicalHostFrames[0]?.atMicros ?? null,
          fence: fences[0]?.atMicros ?? null,
        }),
        identity: Object.freeze({
          processId: typeof paint?.processId === "string" ? paint.processId.slice(0, 128) : null,
          clockId: typeof paint?.clockId === "string" ? paint.clockId.slice(0, 128) : null,
          semanticPaneId:
            typeof paint?.semanticPaneId === "string" ? paint.semanticPaneId.slice(0, 128) : null,
          generation: typeof paint?.generation === "string" ? paint.generation.slice(0, 128) : null,
          revision: Number.isSafeInteger(paint?.revision) ? paint.revision : null,
          incarnation:
            typeof paint?.incarnation === "string" ? paint.incarnation.slice(0, 128) : null,
          stateHash: typeof paint?.stateHash === "string" ? paint.stateHash.slice(0, 32) : null,
          sourceEpoch: Number.isSafeInteger(paint?.sourceEpoch) ? paint.sourceEpoch : null,
          canonicalGeometry: Object.freeze({
            cols: Number.isSafeInteger(paint?.cols) ? paint.cols : null,
            rows: Number.isSafeInteger(paint?.rows) ? paint.rows : null,
            viewportCols: Number.isSafeInteger(paint?.viewportCols) ? paint.viewportCols : null,
            viewportRows: Number.isSafeInteger(paint?.viewportRows) ? paint.viewportRows : null,
          }),
        }),
      });
    }
    throw error;
  }
}

export function qualifyAutomaticConfiglessSelection(records, sessionName) {
  const phases = ["session-discovery-start", "session-discovery-end", "config-load-end"];
  let previous = -1;
  const selected = phases.map((phase) => {
    const index = records.findIndex(
      (record, candidate) => candidate > previous && record?.phase === phase,
    );
    if (index <= previous) throw new Error(`missing ordered public TUI ${phase} diagnostic`);
    previous = index;
    return records[index];
  });
  const [start, end, configured] = selected;
  if (end.sessions !== 1 || configured.sessions !== 1 || configured.target !== sessionName)
    throw new Error("public TUI did not automatically select the sole discovered session");
  for (const record of selected)
    if (record.processId !== start.processId || record.clockId !== start.clockId)
      throw new Error("public TUI discovery diagnostics crossed a process or clock boundary");
  return Object.freeze({ start, end, configured });
}

const boundedPromotionValue = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return value ?? null;
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  const text = String(value);
  return text.length <= 160 ? text : `${text.slice(0, 157)}...`;
};

export function qualifyCanonicalPromotionAdoption({
  observed,
  catalog,
  fleet,
  daemonInstanceId,
  sessionName,
  discoveredFleetSessionId,
}) {
  const intents = Array.isArray(catalog?.intents)
    ? catalog.intents.filter(
        (intent) => intent?.sessionName === sessionName && intent?.availability === "live",
      )
    : [];
  const intent = intents.length === 1 ? intents[0] : null;
  const liveRows = Array.isArray(catalog?.liveSessions)
    ? catalog.liveSessions.filter((session) => session?.sessionName === sessionName)
    : [];
  const live = liveRows.length === 1 ? liveRows[0] : null;
  const fleetRows = Array.isArray(fleet?.sessions)
    ? fleet.sessions.filter((session) => session?.label === sessionName)
    : [];
  const fleetRow = fleetRows.length === 1 ? fleetRows[0] : null;
  const checks = [
    ["adoption-stamp", observed?.adoptionStamp === "1", observed?.adoptionStamp],
    ["promotion-stamp", observed?.promotedStamp === "1", observed?.promotedStamp],
    [
      "workspace-name-stamp",
      intent !== null && observed?.workspaceNameStamp === intent.workspaceName,
      observed?.workspaceNameStamp,
    ],
    [
      "promotion-operation-stamp",
      typeof observed?.promotionOperationStamp === "string" &&
        observed.promotionOperationStamp.length > 0 &&
        observed.promotionOperationStamp.length <= 128,
      observed?.promotionOperationStamp,
    ],
    [
      "workspace-open-stamp-absent",
      observed?.workspaceOpenStamp === null,
      observed?.workspaceOpenStamp,
    ],
    [
      "workspace-open-operation-stamp-absent",
      observed?.workspaceOpenOperationStamp === null,
      observed?.workspaceOpenOperationStamp,
    ],
    ["workspace-intent-unique", intent !== null, intents.length],
    ["workspace-live-row-unique", live !== null, liveRows.length],
    ["fleet-row-unique", fleetRow !== null, fleetRows.length],
    [
      "workspace-catalog-daemon",
      catalog?.daemon?.instanceId === daemonInstanceId,
      catalog?.daemon?.instanceId,
    ],
    [
      "fleet-catalog-daemon",
      fleet?.daemon?.instanceId === daemonInstanceId,
      fleet?.daemon?.instanceId,
    ],
    [
      "fleet-catalog-revision",
      typeof fleet?.catalogRevision === "string" && /^[0-9a-f]{20}$/u.test(fleet.catalogRevision),
      fleet?.catalogRevision,
    ],
    [
      "workspace-live-fleet-session",
      live?.fleetSessionId === discoveredFleetSessionId,
      live?.fleetSessionId,
    ],
    ["fleet-row-session", fleetRow?.sessionId === discoveredFleetSessionId, fleetRow?.sessionId],
  ].map(([id, passed, actual]) =>
    Object.freeze({
      id,
      status: passed ? "passed" : "failed",
      actual: boundedPromotionValue(actual),
    }),
  );
  const passed = checks.every(({ status }) => status === "passed");
  return Object.freeze({
    passed,
    predicates: Object.freeze(checks),
    evidence: passed
      ? Object.freeze({
          fleetSessionId: discoveredFleetSessionId,
          session: sessionName,
          workspaceName: intent.workspaceName,
          promotionOperationId: observed.promotionOperationStamp,
          catalogRevision: fleet.catalogRevision,
          stamp: "1",
        })
      : null,
  });
}

export function canonicalPromotionPredicateSignature(predicates) {
  return JSON.stringify(predicates.map(({ id, status, actual }) => [id, status, actual]));
}

export function assessWorkspaceClientState(records, expected) {
  const matches = records.filter(
    (record) =>
      record?.phase === "generation-workspace-client-state" &&
      record.processId === expected.processId &&
      record.daemonGeneration === expected.daemonGeneration,
  );
  const record = matches.at(-1);
  const committed = record?.workspaceClient?.committed;
  const pending = record?.workspaceClient?.pending;
  const derived = record?.workspaceClient?.derived;
  const matchingIntents = committed?.catalog?.intents?.filter(
    (intent) => intent.workspaceName === expected.workspaceName && intent.availability === "live",
  );
  const intent = matchingIntents?.length === 1 ? matchingIntents[0] : null;
  const matchingLive = intent
    ? committed?.catalog?.liveSessions?.filter(
        (session) => session.sessionName === intent.sessionName,
      )
    : null;
  const authority = committed?.authority;
  const authorityResources = committed?.terminalResources;
  const derivedResources = derived?.terminalInventory?.resources?.map((resource) => ({
    resourceId: resource.id,
    semanticPaneId:
      resource.attachability?.status === "available" ? resource.attachability.semanticPaneId : null,
  }));
  const resourceIdentity = (resources) =>
    Array.isArray(resources)
      ? [...resources]
          .map(({ resourceId, semanticPaneId }) => `${resourceId}\u0000${semanticPaneId ?? ""}`)
          .sort()
          .join("\n")
      : null;
  const ownersShape =
    authority?.owners &&
    Object.keys(authority.owners).sort().join(",") === "focus,geometry,input" &&
    ["input", "focus", "geometry"].every(
      (kind) => authority.owners[kind] === null || typeof authority.owners[kind] === "string",
    );
  const checks = [
    ["record-exact-process-generation", Boolean(record), matches.length],
    ["committed-live", committed?.phase === "live", committed?.phase],
    [
      "target-daemon",
      committed?.target?.daemon?.instanceId === expected.daemonGeneration,
      committed?.target?.daemon?.instanceId,
    ],
    [
      "target-workspace",
      committed?.target?.workspaceName === expected.workspaceName,
      committed?.target?.workspaceName,
    ],
    [
      "catalog-daemon",
      committed?.catalog?.daemonInstanceId === expected.daemonGeneration,
      committed?.catalog?.daemonInstanceId,
    ],
    ["catalog-intent-unique", intent !== null, matchingIntents?.length ?? null],
    ["catalog-live-unique", matchingLive?.length === 1, matchingLive?.length ?? null],
    [
      "catalog-session",
      matchingLive?.[0]?.sessionName === expected.sessionName,
      matchingLive?.[0]?.sessionName,
    ],
    [
      "catalog-fleet-session",
      matchingLive?.[0]?.fleetSessionId === expected.fleetSessionId,
      matchingLive?.[0]?.fleetSessionId,
    ],
    [
      "authority-generation",
      authority?.generation === expected.daemonGeneration,
      authority?.generation,
    ],
    ["authority-session", authority?.session === expected.sessionName, authority?.session],
    [
      "authority-revision",
      Number.isSafeInteger(authority?.revision) && authority.revision >= 0,
      authority?.revision,
    ],
    ["authority-owners-shape", Boolean(ownersShape), ownersShape ? "exact" : "malformed"],
    [
      "authority-owner-process",
      Boolean(ownersShape) &&
        authority.owners.geometry === record?.processId &&
        ["input", "focus"].every(
          (kind) => authority.owners[kind] === null || authority.owners[kind] === record?.processId,
        ),
      record?.processId,
    ],
    [
      "terminal-resources",
      Array.isArray(authorityResources) && authorityResources.length > 0,
      authorityResources?.length ?? null,
    ],
    [
      "terminal-resource-identity",
      resourceIdentity(authorityResources) !== null &&
        resourceIdentity(authorityResources) === resourceIdentity(derivedResources),
      resourceIdentity(authorityResources) === resourceIdentity(derivedResources),
    ],
    [
      "semantic-pane-unique",
      Array.isArray(authorityResources) &&
        authorityResources.filter(
          ({ semanticPaneId }) => semanticPaneId === expected.semanticPaneId,
        ).length === 1,
      expected.semanticPaneId,
    ],
    ["pending-empty", Array.isArray(pending) && pending.length === 0, pending?.length ?? null],
    [
      "derived-workspace",
      typeof derived?.workspace?.id === "string" &&
        derived.workspace.id.length > 0 &&
        typeof derived.workspace?.name === "string" &&
        derived.workspace.name.length > 0,
      derived?.workspace?.id ?? null,
    ],
    [
      "derived-authority-identity",
      committed?.authorityWorkspaceId === derived?.workspace?.id &&
        committed?.authorityWorkspaceName === derived?.workspace?.name,
      committed?.authorityWorkspaceId ?? null,
    ],
    [
      "canonical-generation",
      expected.canonicalGeneration === expected.daemonGeneration,
      expected.canonicalGeneration,
    ],
  ].map(([id, passed, actual]) =>
    Object.freeze({
      id,
      status: passed ? "passed" : "failed",
      actual: boundedPromotionValue(actual),
    }),
  );
  const passed = checks.every(({ status }) => status === "passed");
  return Object.freeze({
    passed,
    predicates: Object.freeze(checks),
    evidence: passed ? Object.freeze({ committed, pending, derived, record }) : null,
  });
}

export function qualifyWorkspaceClientState(records, expected) {
  const assessment = assessWorkspaceClientState(records, expected);
  if (assessment.evidence) return assessment.evidence;
  const error = new Error(
    "exact live WorkspaceClient committed/pending/derived state is unavailable",
  );
  error.boundary = "diagnostic-correlation";
  error.observation = Object.freeze({
    scope: "workspace-client",
    predicates: assessment.predicates,
  });
  throw error;
}

export async function waitForQualifiedWorkspaceClientState(
  readRecords,
  expected,
  { attempts = 200, pause = () => new Promise((resolve) => setTimeout(resolve, 25)) } = {},
) {
  let assessment = assessWorkspaceClientState([], expected);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    assessment = assessWorkspaceClientState(await readRecords(), expected);
    if (assessment.evidence) return assessment.evidence;
    if (attempt + 1 < attempts) await pause();
  }
  const error = new Error("exact live WorkspaceClient state did not settle before deadline");
  error.boundary = "diagnostic-correlation";
  error.observation = Object.freeze({
    scope: "workspace-client",
    attempts,
    predicates: assessment.predicates,
  });
  throw error;
}

export function assessConfiglessJourneyBoundaries({
  timeline,
  correlationComplete,
  correlationMissing,
  canonicalSeedPaintComplete,
  automaticPromotionCausalityComplete,
}) {
  const requiredPhases = [
    "namespace-clean",
    "public-cli-spawn",
    "daemon-election",
    "ordinary-session-discovery",
    "canonical-promotion-adoption",
    "coherent-terminal-publication",
    "web-started-after-cold-boundary",
  ];
  let previous = -1;
  const boundaries = requiredPhases.map((id) => {
    const index = timeline.findIndex(
      ({ phase }, candidate) => candidate > previous && phase === id,
    );
    const passed = index > previous;
    if (passed) previous = index;
    return Object.freeze({
      id,
      status: passed ? "passed" : "failed",
      detail: passed ? `timeline event ${index}` : "missing or out of order",
    });
  });
  boundaries.push(
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete ? "passed" : "unmeasured",
      detail: correlationComplete
        ? "daemon, WorkspaceClient, tmux, TUI and Web state correlated"
        : `missing ${correlationMissing.join(", ")}`,
    }),
    Object.freeze({
      id: "automatic-promotion-causality",
      status: automaticPromotionCausalityComplete ? "passed" : "unmeasured",
      detail: automaticPromotionCausalityComplete
        ? "sole-session discovery/selection precedes exact promoted catalog, fleet and stamps"
        : "ordered sole-session discovery/selection or exact promotion result is unavailable",
    }),
    Object.freeze({
      id: "canonical-seed-paint-correlation",
      status: canonicalSeedPaintComplete ? "passed" : "unmeasured",
      detail: canonicalSeedPaintComplete
        ? "exact retained seed publication and first canonical paint correlated"
        : "exact retained seed publication and first canonical paint were unavailable",
    }),
  );
  const firstBrokenBoundary = boundaries.find(({ status }) => status === "failed")?.id ?? null;
  const firstUnmeasuredBoundary =
    boundaries.find(({ status }) => status === "unmeasured")?.id ?? null;
  return Object.freeze({
    boundaries: Object.freeze(boundaries),
    firstBrokenBoundary,
    firstUnmeasuredBoundary,
    status: firstBrokenBoundary ? "failed" : firstUnmeasuredBoundary ? "incomplete" : "passed",
  });
}

export function assessCoherentFirstPaneBoundaries({ timeline, correlationComplete }) {
  const required = [
    "targeted-namespace-preseeded",
    "targeted-daemon-ready",
    "targeted-tui-cwd-ready",
    "targeted-tui-connect",
    "canonical-seed-paint-correlation",
    "coherent-terminal-publication",
    "web-started-after-coherent-boundary",
  ];
  let previousIndex = -1;
  const boundaries = required.map((id) => {
    const indices = timeline.flatMap((entry, index) => (entry.phase === id ? [index] : []));
    const passed = indices.length === 1 && indices[0] > previousIndex;
    if (passed) previousIndex = indices[0];
    return Object.freeze({
      id,
      status: passed ? "passed" : "failed",
      detail: passed
        ? `observed ${id} in order`
        : indices.length === 0
          ? `missing ${id}`
          : indices.length > 1
            ? `duplicate ${id}`
            : `out-of-order ${id}`,
    });
  });
  boundaries.push(
    Object.freeze({
      id: "diagnostic-correlation",
      status: correlationComplete ? "passed" : "unmeasured",
      detail: correlationComplete
        ? "daemon, WorkspaceClient, tmux, TUI and Web state correlated"
        : "required cross-client correlation unavailable",
    }),
  );
  const firstBrokenBoundary = boundaries.find(({ status }) => status === "failed")?.id ?? null;
  const firstUnmeasuredBoundary =
    boundaries.find(({ status }) => status === "unmeasured")?.id ?? null;
  return Object.freeze({
    boundaries: Object.freeze(boundaries),
    firstBrokenBoundary,
    firstUnmeasuredBoundary,
    status: firstBrokenBoundary ? "failed" : firstUnmeasuredBoundary ? "incomplete" : "passed",
  });
}

export function createConfiglessProductJourneyOwnerOperations(ports) {
  return Object.freeze({
    async createOrdinaryNamespace() {
      const namespace = await ports.createNamespace({ adoptSessions: false });
      return Object.freeze({
        ...namespace,
        publicEnvironment: configlessPublicEnvironment(namespace.runtimeNamespace),
      });
    },
    async assertNamespaceClean(namespace) {
      const observed = await ports.inspectNamespace(namespace);
      if (
        observed.workspaceConfigExists ||
        observed.legacyConfigExists ||
        observed.daemonEntries.length > 0 ||
        observed.registryEntries.length > 0 ||
        observed.sessionNames.length !== 1 ||
        observed.sessionNames[0] !== namespace.session ||
        observed.adoptionStamp !== null ||
        observed.promotedStamp !== null ||
        observed.workspaceNameStamp !== null ||
        observed.promotionOperationStamp !== null ||
        observed.workspaceOpenStamp !== null ||
        observed.workspaceOpenOperationStamp !== null
      )
        throw new Error(`configless namespace was contaminated: ${JSON.stringify(observed)}`);
      return ports.recordBoundary("namespace-clean", observed);
    },
    buildBeforeMeasurement: (namespace) => ports.buildBeforeMeasurement(namespace),
    launchPublicNoArgumentEntry(namespace) {
      return ports.launchPublicEntry({
        argv: Object.freeze([]),
        cwd: namespace.runtimeNamespace.projectDir,
        environment: namespace.publicEnvironment,
        entry: "public-no-argument-cli",
      });
    },
    observeElectedDaemon(namespace, publicProcess) {
      return ports.observeElectedDaemon(namespace, publicProcess);
    },
    async observeOrdinarySessionDiscovery(namespace, daemon) {
      const publicLifecycle = qualifyAutomaticConfiglessSelection(
        await ports.readPublicLifecycle(namespace),
        namespace.session,
      );
      const discovered = await ports.poll("ordinary-session-discovery", async () => {
        const catalog = await ports.readWorkspaceCatalog(daemon);
        if (catalog.daemon?.instanceId !== daemon.record.instanceId) return null;
        const sessions = catalog.liveSessions?.filter(
          ({ sessionName }) => sessionName === namespace.session,
        );
        const session = sessions?.length === 1 ? sessions[0] : null;
        return session?.fleetSessionId ? { ...session, publicLifecycle } : null;
      });
      await ports.recordBoundary("ordinary-session-discovery", discovered);
      return discovered;
    },
    async adoptThroughPublicApp(namespace, daemon, discovered) {
      let lastQualification = null;
      let lastSignature = null;
      let adopted;
      try {
        adopted = await ports.poll("canonical-promotion-adoption", async () => {
          const [observed, catalog, fleet] = await Promise.all([
            ports.inspectNamespace(namespace),
            ports.readWorkspaceCatalog(daemon),
            ports.readFleetCatalog(daemon),
          ]);
          lastQualification = qualifyCanonicalPromotionAdoption({
            observed,
            catalog,
            fleet,
            daemonInstanceId: daemon.record.instanceId,
            sessionName: namespace.session,
            discoveredFleetSessionId: discovered.fleetSessionId,
          });
          const signature = canonicalPromotionPredicateSignature(lastQualification.predicates);
          if (signature !== lastSignature) {
            lastSignature = signature;
            await ports.recordObservation?.(
              "canonical-promotion-adoption-observation",
              lastQualification,
            );
          }
          return lastQualification.evidence;
        });
      } catch (error) {
        const boundaryError = new Error(
          `canonical-promotion-adoption did not settle; final predicates: ${JSON.stringify(lastQualification?.predicates ?? [])}`,
          { cause: error },
        );
        boundaryError.boundary = "canonical-promotion-adoption";
        boundaryError.observation = lastQualification;
        throw boundaryError;
      }
      await ports.recordBoundary("canonical-promotion-adoption", adopted);
      return adopted;
    },
    proveCoherentPublication(namespace, daemon, adopted) {
      return ports.proveCoherentPublication(namespace, daemon, adopted);
    },
    startWebAfterColdBoundary(namespace, daemon, coherent) {
      return ports.startWebAfterColdBoundary(namespace, daemon, coherent);
    },
  });
}
