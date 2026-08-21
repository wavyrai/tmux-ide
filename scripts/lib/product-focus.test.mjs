import assert from "node:assert/strict";
import test from "node:test";

import { assessFocusWebSemantic } from "./product-configless-owner.mjs";
import {
  assessFocusJourneyBoundaries,
  assessFocusFramebufferAttempt,
  advanceFocusFramebufferStability,
  captureFocusWebSemanticDocument,
  decodeFocusFramebufferCapture,
  inspectFocusFramebufferCapture,
  normalizeFocusAnsiFrame,
  projectFocusFramebufferRect,
  qualifyFocusWorkspaceState,
  qualifyProductFocusEvidence,
  selectFocusCursorPresentationRow,
  sliceFocusTerminalCells,
  waitForFocusWebSemantic,
} from "./product-focus.mjs";

function focusWebDom({ windows, terminals }) {
  const node = (attributes) => ({
    getAttribute: (name) => attributes[name] ?? null,
  });
  const app = node({
    "data-shell-source": "runtime",
    "data-daemon-generation": "daemon.generation",
  });
  const selectors = new Map([
    [".window-tabs__tab", windows.map(node)],
    [".terminal-surface", terminals.map(node)],
    [".tiled-workspace", [{}]],
  ]);
  return {
    requestAnimationFrame: (callback) => callback(),
    document: {
      visibilityState: "visible",
      hasFocus: () => true,
      querySelector: (selector) => (selector === ".app" ? app : null),
      querySelectorAll: (selector) => selectors.get(selector) ?? [],
    },
  };
}

const focusWebResources = Object.freeze([
  Object.freeze({
    id: "resource.active",
    windowResourceId: "window.active",
    active: true,
    attachability: Object.freeze({ status: "available", semanticPaneId: "pane.active" }),
  }),
  Object.freeze({
    id: "resource.inactive",
    windowResourceId: "window.inactive",
    active: false,
    attachability: Object.freeze({ status: "available", semanticPaneId: "pane.inactive" }),
  }),
]);

function focusWebSnapshot({ windows = 2, phase = "connected", pane = "pane.active" } = {}) {
  return {
    shellSource: "runtime",
    daemonGeneration: "daemon.generation",
    visibilityState: "visible",
    hasFocus: true,
    windowContainerCount: windows === 0 ? 0 : 1,
    windows: [
      {
        windowResourceId: "window.active",
        semanticPaneIds: '["pane.active"]',
        paneCount: "1",
        active: "true",
      },
      {
        windowResourceId: "window.inactive",
        semanticPaneIds: '["pane.inactive"]',
        paneCount: "1",
        active: "false",
      },
    ].slice(0, windows),
    terminals: windows === 0 ? [] : [{ phase, workspaceName: "workspace", semanticPaneId: pane }],
    connectedPaneIds: phase === "connected" ? [pane] : [],
  };
}

async function runFocusWebSequence(sequence, overrides = {}) {
  let clock = 0;
  let index = 0;
  let turns = 0;
  const result = await waitForFocusWebSemantic({
    sample: async () => {
      const ordinal = index;
      const candidate = sequence[Math.min(index++, sequence.length - 1)];
      await overrides.onSample?.(ordinal);
      return candidate;
    },
    health: overrides.health ?? (() => null),
    derivedResources: focusWebResources,
    expectedWorkspaceName: "workspace",
    expectedSemanticPaneId: "pane.active",
    expectedDaemonGeneration: "daemon.generation",
    deadlineMs: overrides.deadlineMs ?? 250,
    pollMs: 25,
    now: () => clock,
    waitTurn: async () => {
      turns += 1;
      clock += 25;
      await overrides.onTurn?.(turns);
    },
    signal: overrides.signal,
  });
  return { result, turns };
}

test("focus Web DOM capture preserves qualifier-valid multipane membership above 512 bytes", async () => {
  const panes = Array.from(
    { length: 24 },
    (_, index) => `pane.${String(index).padStart(3, "0")}.${"x".repeat(20)}`,
  );
  const semanticPaneIds = JSON.stringify(panes);
  assert.ok(semanticPaneIds.length > 512);
  const semantic = await captureFocusWebSemanticDocument(
    focusWebDom({
      windows: [
        {
          "data-window-resource-id": "window.many",
          "data-semantic-pane-ids": semanticPaneIds,
          "data-pane-count": String(panes.length),
          "data-active": "true",
        },
      ],
      terminals: [
        {
          "data-phase": "connected",
          "data-workspace-name": "workspace",
          "data-semantic-pane-id": panes[0],
        },
      ],
    }),
  );
  const assessment = assessFocusWebSemantic({
    web: semantic,
    derivedResources: panes.map((pane, index) => ({
      id: `resource.${index}`,
      windowResourceId: "window.many",
      active: index === 0,
      attachability: { status: "available", semanticPaneId: pane },
    })),
    expectedWorkspaceName: "workspace",
    expectedSemanticPaneId: panes[0],
    expectedDaemonGeneration: "daemon.generation",
  });
  assert.equal(semantic.windows[0].semanticPaneIds, semanticPaneIds);
  assert.equal(assessment.qualified, true);
});

test("focus Web DOM capture fails closed when aggregate semantic membership exceeds its budget", async () => {
  const panes = Array.from({ length: 512 }, (_, index) => {
    const prefix = `pane.${String(index).padStart(3, "0")}.`;
    return `${prefix}${"x".repeat(128 - prefix.length)}`;
  });
  const groups = Array.from({ length: 9 }, (_, group) =>
    panes.slice(group * 57, group === 8 ? panes.length : (group + 1) * 57),
  );
  const semantic = await captureFocusWebSemanticDocument(
    focusWebDom({
      windows: groups.map((members, index) => ({
        "data-window-resource-id": `window.${index}`,
        "data-semantic-pane-ids": JSON.stringify(members),
        "data-pane-count": String(members.length),
        "data-active": index === 0 ? "true" : "false",
      })),
      terminals: [
        {
          "data-phase": "connected",
          "data-workspace-name": "workspace",
          "data-semantic-pane-id": panes[0],
        },
      ],
    }),
  );
  assert.equal(semantic.windows.at(-1).semanticPaneIds, null);
  const assessment = assessFocusWebSemantic({
    web: semantic,
    derivedResources: groups.flatMap((members, group) =>
      members.map((pane, index) => ({
        id: `resource.${group}.${index}`,
        windowResourceId: `window.${group}`,
        active: group === 0 && index === 0,
        attachability: { status: "available", semanticPaneId: pane },
      })),
    ),
    expectedWorkspaceName: "workspace",
    expectedSemanticPaneId: panes[0],
    expectedDaemonGeneration: "daemon.generation",
  });
  assert.equal(assessment.qualified, false);
  assert.equal(assessment.firstFailedPredicate, "web-window-panes");
});

test("focus Web waiter treats first connected as progress and requires two stable full projections", async () => {
  const zero = focusWebSnapshot({ windows: 0 });
  const one = focusWebSnapshot({ windows: 1 });
  const exact = focusWebSnapshot();
  const { result, turns } = await runFocusWebSequence([zero, one, exact, structuredClone(exact)]);
  assert.equal(result.attempts, 4);
  assert.equal(result.stableExactSamples, 2);
  assert.equal(turns, 3);

  const groupsBeforeConnected = await runFocusWebSequence([
    focusWebSnapshot({ phase: "connecting" }),
    exact,
    structuredClone(exact),
  ]);
  assert.equal(groupsBeforeConnected.result.attempts, 3);

  const wrongFirstPane = await runFocusWebSequence([
    focusWebSnapshot({ pane: "pane.inactive" }),
    exact,
    structuredClone(exact),
  ]);
  assert.equal(wrongFirstPane.result.attempts, 3);
});

test("focus Web waiter resets stability after transient drift", async () => {
  const exact = focusWebSnapshot();
  const drift = { ...exact, hasFocus: false };
  const { result, turns } = await runFocusWebSequence([
    exact,
    drift,
    structuredClone(exact),
    structuredClone(exact),
  ]);
  assert.equal(result.attempts, 4);
  assert.equal(result.stableExactSamples, 2);
  assert.equal(turns, 3);
});

test("focus Web waiter reports bounded structural timeout evidence", async () => {
  const duplicate = focusWebSnapshot();
  duplicate.terminals.push({ ...duplicate.terminals[0] });
  const extra = focusWebSnapshot();
  extra.windows.push({
    windowResourceId: "window.extra",
    semanticPaneIds: '["pane.extra"]',
    paneCount: "1",
    active: "false",
  });
  const malformed = focusWebSnapshot();
  malformed.windows[0].semanticPaneIds = "not-json";
  const excess = { ...focusWebSnapshot(), windowNodeCount: 513 };
  for (const [candidate, predicate] of [
    [duplicate, "web-terminal-count"],
    [extra, "web-window-group-count"],
    [malformed, "web-window-panes"],
    [excess, "web-window-count-bounded"],
  ])
    await assert.rejects(runFocusWebSequence([candidate], { deadlineMs: 50 }), (error) => {
      assert.equal(error.boundary, "focus-web-correlation");
      assert.equal(error.observation.reason, "deadline");
      assert.equal(error.observation.firstFailedPredicate, predicate);
      assert.equal(error.observation.stableExactSamples, 0);
      assert.match(error.observation.latest.digest, /^[0-9a-f]{64}$/u);
      assert.ok(JSON.stringify(error.observation).length < 2_048);
      assert.doesNotMatch(
        JSON.stringify(error.observation),
        /"pane\.active"|"window\.active"|"workspace"/u,
      );
      return true;
    });
});

test("focus Web waiter fails immediately on page, browser, dev-server, and abort lifecycle fences", async () => {
  for (const reason of ["page-closed", "browser-disconnected", "dev-server-dead"]) {
    await assert.rejects(
      runFocusWebSequence([focusWebSnapshot()], {
        health: () => reason,
      }),
      (error) => {
        assert.equal(error.observation.reason, reason);
        assert.equal(error.observation.attempts, 0);
        return true;
      },
    );
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runFocusWebSequence([focusWebSnapshot()], { signal: controller.signal }),
    (error) => error.observation.reason === "aborted" && error.observation.attempts === 0,
  );

  const delayedAbort = new AbortController();
  await assert.rejects(
    runFocusWebSequence([focusWebSnapshot()], {
      signal: delayedAbort.signal,
      onTurn: () => delayedAbort.abort(),
    }),
    (error) => error.observation.reason === "aborted" && error.observation.attempts === 1,
  );

  let postSampleHealth = null;
  const pendingListeners = new Set();
  const trackedSignal = {
    aborted: false,
    addEventListener: (_type, listener) => pendingListeners.add(listener),
    removeEventListener: (_type, listener) => pendingListeners.delete(listener),
  };
  await assert.rejects(
    runFocusWebSequence([focusWebSnapshot(), focusWebSnapshot()], {
      signal: trackedSignal,
      health: () => postSampleHealth,
      onSample: (ordinal) => {
        if (ordinal === 1) postSampleHealth = "dev-server-dead";
      },
    }),
    (error) => error.observation.reason === "dev-server-dead" && error.observation.attempts === 1,
  );
  assert.equal(pendingListeners.size, 0);
  const postSampleAbort = new AbortController();
  await assert.rejects(
    runFocusWebSequence([focusWebSnapshot(), focusWebSnapshot()], {
      signal: postSampleAbort.signal,
      onSample: (ordinal) => {
        if (ordinal === 1) postSampleAbort.abort();
      },
    }),
    (error) => error.observation.reason === "aborted" && error.observation.attempts === 1,
  );
});

function canonicalLayout({
  cols = 132,
  rows = 41,
  paneBorderStatus = "top",
  panes = [
    {
      pane: "pane.promoted.4d2e6ef021a27f2ffc19",
      left: 0,
      top: 0,
      width: 132,
      height: 41,
      active: true,
    },
  ],
} = {}) {
  return {
    type: "layout",
    semanticWindowId: "window.main",
    windowName: "main",
    currentWindow: true,
    cols,
    rows,
    zoomed: false,
    paneBorderStatus,
    panes,
  };
}

test("projects and resolves the production 160x44 sidebar/window-strip focus frame", () => {
  const semanticPaneId = "pane.promoted.4d2e6ef021a27f2ffc19";
  const rect = projectFocusFramebufferRect({
    hostCols: 160,
    hostRows: 44,
    canonicalLayout: canonicalLayout(),
    canonicalPaneId: semanticPaneId,
  });
  assert.deepEqual(rect, {
    left: 28,
    chromeRow: 2,
    firstBodyRow: 3,
    width: 132,
    bodyRows: 40,
    contentHeight: 40,
    sidebarWidth: 28,
  });
  const rows = Array.from({ length: 44 }, () => "".padEnd(160));
  rows[2] = `${"".padEnd(28)}\u001b[38;5;75m● ${semanticPaneId}\u001b[0m`.padEnd(178);
  rows[4] = `${"".padEnd(28)}cursor body`.padEnd(160);
  const ansiFrame = rows.join("\n");
  const inspected = inspectFocusFramebufferCapture({
    ansiFrame,
    semanticPaneId,
    expectedMarker: "●",
    projectedRect: rect,
    cursorRow: 1,
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.observation.matchCount, 1);
  assert.equal(normalizeFocusAnsiFrame(ansiFrame).includes(String.fromCharCode(27)), false);
});

test("canonical projection is independent of physical tmux border geometry and handles multipane offsets", () => {
  const topBorderNativePane = { left: 0, top: 1, width: 132, height: 40, windowActive: true };
  const full = projectFocusFramebufferRect({
    hostCols: 160,
    hostRows: 44,
    canonicalLayout: canonicalLayout({ paneBorderStatus: "top" }),
    canonicalPaneId: "pane.promoted.4d2e6ef021a27f2ffc19",
  });
  assert.deepEqual(full, {
    left: 28,
    chromeRow: 2,
    firstBodyRow: 3,
    width: 132,
    bodyRows: 40,
    contentHeight: 40,
    sidebarWidth: 28,
  });
  assert.deepEqual(topBorderNativePane, {
    left: 0,
    top: 1,
    width: 132,
    height: 40,
    windowActive: true,
  });
  assert.deepEqual(
    projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: canonicalLayout({ paneBorderStatus: "off" }),
      canonicalPaneId: "pane.promoted.4d2e6ef021a27f2ffc19",
    }),
    full,
  );

  const multipane = canonicalLayout({
    cols: 132,
    rows: 41,
    paneBorderStatus: "bottom",
    panes: [
      { pane: "pane.left", left: 0, top: 0, width: 66, height: 41, active: false },
      { pane: "pane.right", left: 66, top: 0, width: 66, height: 41, active: true },
    ],
  });
  assert.deepEqual(
    projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: multipane,
      canonicalPaneId: "pane.right",
    }),
    {
      left: 94,
      chromeRow: 2,
      firstBodyRow: 3,
      width: 66,
      bodyRows: 40,
      contentHeight: 40,
      sidebarWidth: 28,
    },
  );
  assert.deepEqual(
    projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: canonicalLayout({
        panes: [
          { pane: "pane.top", left: 0, top: 0, width: 132, height: 20, active: false },
          { pane: "pane.bottom", left: 0, top: 20, width: 132, height: 21, active: true },
        ],
      }),
      canonicalPaneId: "pane.bottom",
    }),
    {
      left: 28,
      chromeRow: 22,
      firstBodyRow: 23,
      width: 132,
      bodyRows: 20,
      contentHeight: 20,
      sidebarWidth: 28,
    },
  );
  assert.equal(
    projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: multipane,
      canonicalPaneId: "pane.missing",
    }),
    null,
  );
  assert.equal(
    projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: canonicalLayout({
        panes: [
          { pane: "pane.duplicate", left: 0, top: 0, width: 66, height: 41, active: true },
          { pane: "pane.duplicate", left: 66, top: 0, width: 66, height: 41, active: false },
        ],
      }),
      canonicalPaneId: "pane.duplicate",
    }),
    null,
  );
  assert.equal(
    projectFocusFramebufferRect({
      hostCols: 160,
      hostRows: 44,
      canonicalLayout: canonicalLayout({
        panes: [{ pane: "pane.bad", left: 120, top: 0, width: 20, height: 41, active: true }],
      }),
      canonicalPaneId: "pane.bad",
    }),
    null,
  );
});

test("structured focus capture normalizes declared terminal cells and rejects framing drift", () => {
  const decoded = decodeFocusFramebufferCapture({
    version: 1,
    cols: 8,
    rows: 3,
    ansi: "plain   \n界é    \n\u001b[31mred\u001b[0m",
  });
  assert.equal(decoded.plain.split("\n").length, 3);
  assert.equal(
    decoded.plain.split("\n").every((line) => line.length >= 3),
    true,
  );
  assert.equal(sliceFocusTerminalCells(decoded.plain.split("\n")[1], 0, 8), "界é     ");
  assert.throws(
    () => decodeFocusFramebufferCapture({ version: 1, cols: 8, rows: 2, ansi: "one\ntwo\n" }),
    /row count/u,
  );
  assert.throws(
    () => decodeFocusFramebufferCapture({ version: 1, cols: 2, rows: 1, ansi: "界x" }),
    /overflowed/u,
  );
  assert.throws(
    () => decodeFocusFramebufferCapture({ version: 1, cols: 8, rows: 1, ansi: "bad\trow" }),
    /invalid terminal control/u,
  );
  assert.equal(sliceFocusTerminalCells("界abcdef", 1, 2), null);
});

test("focus framebuffer resolver rejects missing duplicate wrong-marker clipping and cursor drift", () => {
  const semanticPaneId = "pane.promoted.exact";
  const rect = { left: 28, chromeRow: 2, firstBodyRow: 3, width: 20, bodyRows: 3 };
  const inspect = (rows, overrides = {}) =>
    inspectFocusFramebufferCapture({
      ansiFrame: rows.join("\n"),
      semanticPaneId,
      expectedMarker: "○",
      projectedRect: rect,
      cursorRow: 1,
      ...overrides,
    });
  const empty = Array.from({ length: 6 }, () => "".padEnd(60));
  assert.equal(inspect(empty).reason, "semantic-chrome-missing");
  const duplicate = [...empty];
  duplicate[2] = `${"".padEnd(28)}○ ${semanticPaneId}`.padEnd(60);
  duplicate[3] = `${"".padEnd(28)}○ ${semanticPaneId}`.padEnd(60);
  assert.equal(inspect(duplicate).reason, "semantic-chrome-ambiguous");
  const stale = [...empty];
  stale[2] = `${"".padEnd(28)}● ${semanticPaneId}`.padEnd(60);
  assert.equal(inspect(stale).reason, "marker-mismatch");
  const shifted = [...empty];
  shifted[2] = `${"".padEnd(27)}○ ${semanticPaneId}`.padEnd(60);
  assert.equal(inspect(shifted).reason, "projected-chrome-mismatch");
  const clipped = [...empty];
  clipped[2] = `${"".padEnd(28)}○ ${semanticPaneId}`.padEnd(60);
  clipped[4] = "short";
  assert.equal(inspect(clipped).reason, "projected-body-clipped");
  const extraSpace = [...empty];
  extraSpace[2] = `${"".padEnd(28)}○  ${semanticPaneId}`.padEnd(60);
  assert.equal(inspect(extraSpace).reason, "projected-chrome-mismatch");
  assert.equal(inspect(stale, { expectedMarker: "●", cursorRow: 3 }).reason, "cursor-offscreen");
  assert.equal(
    inspect(empty, { semanticPaneId: "", expectedMarker: "●" }).reason,
    "invalid-identity",
  );
  assert.equal(
    inspect(empty, { semanticPaneId: "p".repeat(129), expectedMarker: "●" }).reason,
    "invalid-identity",
  );
  assert.equal(
    inspect(empty, { ansiFrame: "x".repeat(4 * 1024 * 1024 + 1) }).reason,
    "capture-invalid",
  );
  const widePrefix = [...empty];
  widePrefix[2] = `界${"".padEnd(26)}○ ${semanticPaneId}`.padEnd(59);
  assert.equal(inspect(widePrefix).valid, true);
});

test("focus framebuffer stability ignores a transient incomplete frame and requires two exact samples", () => {
  const digest = "a".repeat(64);
  let state = advanceFocusFramebufferStability(null, { valid: false, digest });
  assert.deepEqual(state, { stable: false, nextDigest: null });
  state = advanceFocusFramebufferStability(state.nextDigest, { valid: true, digest });
  assert.deepEqual(state, { stable: false, nextDigest: digest });
  state = advanceFocusFramebufferStability(state.nextDigest, { valid: true, digest });
  assert.deepEqual(state, { stable: true, nextDigest: digest });
  assert.deepEqual(
    advanceFocusFramebufferStability(state.nextDigest, {
      valid: true,
      digest: "b".repeat(64),
    }),
    { stable: false, nextDigest: "b".repeat(64) },
  );
});

test("focus framebuffer attempt rejects native, canonical, and inactive-window geometry", () => {
  const expectedPane = {
    semanticPaneId: "pane.exact",
    viewportCols: 132,
    viewportRows: 40,
    canonicalCols: 132,
    canonicalRows: 41,
  };
  const pane = {
    semanticPaneId: "pane.exact",
    width: 132,
    height: 40,
    windowActive: true,
  };
  const assess = (overrides = {}) =>
    assessFocusFramebufferAttempt({
      inspected: { valid: true, reason: null },
      geometryBeforeDigest: "before",
      geometryAfterDigest: "before",
      pane,
      canonicalLayout: canonicalLayout({
        panes: [{ pane: "pane.exact", left: 0, top: 0, width: 132, height: 41, active: true }],
      }),
      expected: expectedPane,
      ...overrides,
    });
  assert.deepEqual(assess(), {
    valid: true,
    geometryStable: true,
    nativeGeometryExact: true,
    canonicalGeometryExact: true,
    reason: null,
  });
  assert.equal(assess({ geometryAfterDigest: "after" }).reason, "geometry-drift");
  assert.equal(
    assess({ pane: { ...pane, windowActive: false } }).reason,
    "native-geometry-mismatch",
  );
  assert.equal(assess({ pane: { ...pane, width: 131 } }).reason, "native-geometry-mismatch");
  assert.equal(
    assess({
      canonicalLayout: canonicalLayout({
        panes: [{ pane: "pane.exact", left: 0, top: 0, width: 131, height: 41, active: true }],
      }),
    }).reason,
    "canonical-geometry-mismatch",
  );
  assert.equal(
    assess({ canonicalLayout: canonicalLayout({ cols: 131 }) }).reason,
    "canonical-geometry-mismatch",
  );
});

const expected = Object.freeze({
  processId: "opentui:42",
  clockId: "opentui-performance-now",
  daemonGeneration: "daemon-generation-1",
  workspaceName: "workspace-1",
  sessionName: "session-1",
  clientId: "opentui:42",
  clientGeneration: 7,
  rendererEpoch: 3,
  sourceEpoch: 4,
  semanticPaneId: "pane-1",
  hostPaneId: "%host",
  hostSessionId: "$host",
  hostCols: 160,
  hostRows: 44,
  baselineAuthorityRevision: 10,
  blurAuthorityRevision: 30,
  focusAuthorityRevision: 60,
  canonicalGeneration: "daemon-generation-1",
  incarnation: "incarnation-1",
  revision: 9,
  stateHash: "sha256:" + "a".repeat(64),
  canonicalCols: 132,
  canonicalRows: 41,
  viewportCols: 132,
  viewportRows: 40,
});

const owned = { input: expected.clientId, focus: expected.clientId, geometry: expected.clientId };
const released = { input: null, focus: null, geometry: null };

function lifecycle(phase, epoch, at, overrides = {}) {
  const before = epoch === 1;
  const settled = phase.endsWith("authority-settled");
  const owners = before ? owned : released;
  const presence = before ? "foreground" : "background";
  return {
    phase: `terminal-host-${phase}`,
    diagnosticEpoch: epoch,
    monotonicMicros: at,
    processId: expected.processId,
    clockId: expected.clockId,
    daemonInstanceId: expected.daemonGeneration,
    workspaceName: expected.workspaceName,
    clientGeneration: expected.clientGeneration,
    clientPhase: "live",
    authorityGeneration: expected.daemonGeneration,
    authorityRevision: before ? expected.baselineAuthorityRevision : expected.blurAuthorityRevision,
    authorityOwners: owners,
    rendererEpoch: expected.rendererEpoch,
    opentuiPresence: {
      clientId: expected.clientId,
      state: presence,
      connectedRevision: 1,
      activityRevision: 2,
    },
    ...(settled
      ? {
          bindingCurrent: true,
          settledIdentity: {
            clientGeneration: expected.clientGeneration,
            clientPhase: "live",
            authorityGeneration: expected.daemonGeneration,
            authorityRevision: before
              ? expected.blurAuthorityRevision
              : expected.focusAuthorityRevision,
            authorityOwners: before ? released : owned,
            daemonInstanceId: expected.daemonGeneration,
            workspaceName: expected.workspaceName,
            opentuiPresence: {
              clientId: expected.clientId,
              state: before ? "background" : "foreground",
              connectedRevision: 1,
              activityRevision: 3,
            },
          },
        }
      : {}),
    ...overrides,
  };
}

function receipts(focused) {
  return ["input", "focus", "geometry"].map((authority, index) => ({
    authority,
    status: "fulfilled",
    generation: expected.daemonGeneration,
    session: expected.sessionName,
    revision: (focused ? 40 : 20) + index,
    ...(focused ? { granted: true, clientId: expected.clientId } : { owners: { ...released } }),
  }));
}

function records() {
  return [
    lifecycle("renderer-blur-event", 1, 1_000, { state: "background" }),
    lifecycle("blur-presence", 1, 2_000, { state: "background" }),
    lifecycle("blur-authority-settled", 1, 3_000, {
      status: "fulfilled",
      receipts: receipts(false),
    }),
    {
      phase: "terminal-host-focus-fence",
      diagnosticEpoch: 1,
      rendererEpoch: 3,
      processId: expected.processId,
      clockId: expected.clockId,
      daemonGeneration: expected.daemonGeneration,
      workspaceName: expected.workspaceName,
      clientGeneration: expected.clientGeneration,
      monotonicMicros: 4_000,
      writerHealth: {
        failed: false,
        droppedRecords: 0,
        pendingCriticalRecords: 0,
      },
    },
    lifecycle("renderer-focus-event", 2, 5_000, { state: "foreground" }),
    lifecycle("focus-presence", 2, 6_000, { state: "foreground" }),
    lifecycle("focus-activity", 2, 7_000, { activity: "focus" }),
    lifecycle("focus-authority-settled", 2, 8_000, {
      status: "fulfilled",
      receipts: receipts(true),
    }),
    {
      phase: "terminal-host-focus-fence",
      diagnosticEpoch: 2,
      rendererEpoch: 3,
      processId: expected.processId,
      clockId: expected.clockId,
      daemonGeneration: expected.daemonGeneration,
      workspaceName: expected.workspaceName,
      clientGeneration: expected.clientGeneration,
      monotonicMicros: 9_000,
      writerHealth: {
        failed: false,
        droppedRecords: 0,
        pendingCriticalRecords: 0,
      },
    },
  ];
}

function paint(focused, atMicros, type = "performance.terminal-focus-paint") {
  return {
    version: 1,
    type,
    processId: expected.processId,
    clockId: expected.clockId,
    clockKind: "performance-now",
    atMicros,
    semanticPaneId: expected.semanticPaneId,
    generation: expected.canonicalGeneration,
    incarnation: expected.incarnation,
    revision: expected.revision,
    stateHash: expected.stateHash,
    cols: expected.canonicalCols,
    rows: expected.canonicalRows,
    sourceEpoch: expected.sourceEpoch,
    rendererEpoch: expected.rendererEpoch,
    viewportCols: expected.viewportCols,
    viewportRows: expected.viewportRows,
    focused,
    diagnosticEpoch: focused ? 2 : 1,
    full: false,
    writtenRows: [12],
    ...(type.endsWith("fence")
      ? {
          writerHealth: {
            failed: false,
            droppedRecords: 0,
            oversizedRecords: 0,
          },
        }
      : {}),
  };
}

const snapshots = Object.freeze({
  before: {
    cursorRow: 12,
    nativeBodyHash: "native",
    renderedBodyWithoutCursorHash: "quiet",
    cursorTextRowHash: "cursor-text",
    cursorPresentationRowHash: "focused",
    geometryHash: "geometry",
    canonicalGeometryHash: "canonical-geometry",
  },
  blur: {
    nativeBodyHash: "native",
    renderedBodyWithoutCursorHash: "quiet",
    cursorTextRowHash: "cursor-text",
    cursorPresentationRowHash: "blurred",
    geometryHash: "geometry",
    canonicalGeometryHash: "canonical-geometry",
  },
  focus: {
    nativeBodyHash: "native",
    renderedBodyWithoutCursorHash: "quiet",
    cursorTextRowHash: "cursor-text",
    cursorPresentationRowHash: "focused",
    geometryHash: "geometry",
    canonicalGeometryHash: "canonical-geometry",
  },
});

function trace() {
  return [
    paint(false, 2_500),
    paint(false, 2_501, "performance.terminal-focus-fence"),
    paint(true, 7_500),
    paint(true, 7_501, "performance.terminal-focus-fence"),
  ];
}

const inputs = Object.freeze({
  blur: {
    kind: "focus",
    target: "%host",
    paneId: "%host",
    sessionId: "$host",
    delivery: "exact-bytes-to-immutable-host-pane-pty",
    requestedState: "blur",
    bytesInjected: 3,
    phases: 1,
    geometry: { cols: 160, rows: 44 },
  },
  focus: {
    kind: "focus",
    target: "%host",
    paneId: "%host",
    sessionId: "$host",
    delivery: "exact-bytes-to-immutable-host-pane-pty",
    requestedState: "focus",
    bytesInjected: 3,
    phases: 1,
    geometry: { cols: 160, rows: 44 },
  },
});

const qualify = (overrides = {}) =>
  qualifyProductFocusEvidence({
    lifecycleRecords: records(),
    traceRecords: trace(),
    expected,
    snapshots,
    inputs,
    ...overrides,
  });

test("qualifies exact blur yield and focus reclaim without a body walk", () => {
  const result = qualify();
  assert.equal(result.firstFailedPredicate, null);
  assert.equal(result.qualified?.cursorRow, 12);
});

test("selects the exact ANSI cursor presentation row from semantic body geometry", () => {
  const focused = ["chrome", "body-0", "body-1\u001b[0m", "body-2"];
  const blurred = ["chrome", "body-0", "bo\u001b[48;2;20;30;40mdy-1\u001b[0m", "body-2"];
  const rect = { valid: true, firstBodyRow: 1, bodyRows: 3 };
  assert.equal(selectFocusCursorPresentationRow(focused.join("\n"), rect, 1), focused[2]);
  assert.notEqual(
    selectFocusCursorPresentationRow(focused.join("\n"), rect, 1),
    selectFocusCursorPresentationRow(blurred.join("\n"), rect, 1),
  );
  assert.throws(
    () => selectFocusCursorPresentationRow(focused.join("\n"), { ...rect, valid: false }, 1),
    /unavailable/u,
  );
});

test("rejects a non-PTY, partial, or cross-host focus receipt", () => {
  for (const changed of [
    { ...inputs, blur: { ...inputs.blur, delivery: "synthetic" } },
    { ...inputs, focus: { ...inputs.focus, bytesInjected: 2 } },
    { ...inputs, focus: { ...inputs.focus, target: "%other", paneId: "%other" } },
    { ...inputs, blur: { ...inputs.blur, requestedState: "focus" } },
  ])
    assert.equal(qualify({ inputs: changed }).firstFailedPredicate, "focus-input-receipts");
});

for (const [name, mutate, predicate] of [
  ["duplicate phase", (life) => life.push({ ...life[0] }), "focus-lifecycle-record-set"],
  [
    "reordered phase",
    (life) => {
      life[5].monotonicMicros = 1;
    },
    "focus-phase-order",
  ],
  [
    "stale generation",
    (life) => {
      life[6].daemonInstanceId = "stale";
    },
    "focus-phase-identity",
  ],
  [
    "wrong renderer epoch",
    (life) => {
      life[0].rendererEpoch = 99;
    },
    "focus-phase-identity",
  ],
  [
    "partial claim",
    (life) => {
      life[7].receipts.pop();
    },
    "focus-receipts",
  ],
  [
    "wrong lease client",
    (life) => {
      life[7].receipts[0].clientId = "web:1";
    },
    "focus-receipts",
  ],
  [
    "dropped lifecycle",
    (life) => {
      life[3].writerHealth.droppedRecords = 1;
    },
    "focus-lifecycle-fences",
  ],
  [
    "pending critical lifecycle record",
    (life) => {
      life[3].writerHealth.pendingCriticalRecords = 1;
    },
    "focus-lifecycle-fences",
  ],
  [
    "failed lifecycle writer",
    (life) => {
      life[3].writerHealth.failed = true;
    },
    "focus-lifecycle-fences",
  ],
]) {
  test(`rejects ${name}`, () => {
    const life = structuredClone(records());
    mutate(life);
    assert.equal(qualify({ lifecycleRecords: life }).firstFailedPredicate, predicate);
  });
}

test("reports bounded lifecycle fence health and canonical progress types", () => {
  const healthy = qualify();
  assert.deepEqual(
    healthy.predicates.find((entry) => entry.id === "focus-lifecycle-fences")?.actual,
    {
      count: 2,
      health: [
        { diagnosticEpoch: 1, failed: false, droppedRecords: 0, pendingCriticalRecords: 0 },
        { diagnosticEpoch: 2, failed: false, droppedRecords: 0, pendingCriticalRecords: 0 },
      ],
    },
  );
  const rows = structuredClone(trace());
  rows.push(
    {
      type: "performance.terminal-canonical-publication",
      semanticPaneId: expected.semanticPaneId,
      atMicros: 4_000,
    },
    {
      type: "performance.terminal-canonical-update",
      semanticPaneId: expected.semanticPaneId,
      atMicros: 4_001,
    },
  );
  const failed = qualify({ traceRecords: rows });
  assert.deepEqual(
    failed.predicates.find((entry) => entry.id === "focus-canonical-stable")?.actual,
    { count: 2, updates: 1, publications: 1 },
  );
});

test("rejects full body paint, wrong row, unhealthy fence, and canonical progress", () => {
  for (const [mutate, predicate] of [
    [
      (rows) => {
        rows[0].full = true;
      },
      "focus-paint-rows",
    ],
    [
      (rows) => {
        rows[0].writtenRows = [11];
      },
      "focus-paint-rows",
    ],
    [
      (rows) => {
        rows[1].writerHealth.failed = true;
      },
      "focus-paint-fences",
    ],
    [
      (rows) =>
        rows.push({
          type: "performance.terminal-canonical-update",
          semanticPaneId: expected.semanticPaneId,
          atMicros: 4_000,
        }),
      "focus-canonical-stable",
    ],
  ]) {
    const rows = structuredClone(trace());
    mutate(rows);
    assert.equal(qualify({ traceRecords: rows }).firstFailedPredicate, predicate);
  }
});

test("rejects body, cursor restoration, and geometry drift", () => {
  for (const field of [
    "nativeBodyHash",
    "renderedBodyWithoutCursorHash",
    "geometryHash",
    "canonicalGeometryHash",
  ]) {
    const changed = structuredClone(snapshots);
    changed.blur[field] = "changed";
    assert.equal(qualify({ snapshots: changed }).firstFailedPredicate, "focus-body-stable");
  }
  const cursor = structuredClone(snapshots);
  cursor.focus.cursorPresentationRowHash = "not-restored";
  assert.equal(qualify({ snapshots: cursor }).firstFailedPredicate, "focus-body-stable");
});

test("qualifies blur independently before focus and rejects later reentrant records", () => {
  const blur = qualifyProductFocusEvidence({
    lifecycleRecords: records().slice(0, 4),
    traceRecords: trace().slice(0, 2),
    expected: { ...expected, focusAuthorityRevision: undefined },
    snapshots: { before: snapshots.before, blur: snapshots.blur },
    inputs: { blur: inputs.blur },
    stage: "blur",
  });
  assert.ok(blur.qualified);
  const extraLifecycle = [...records(), { ...records()[0], diagnosticEpoch: 3 }];
  assert.equal(
    qualify({ lifecycleRecords: extraLifecycle }).firstFailedPredicate,
    "focus-lifecycle-record-set",
  );
  const extraTrace = [...trace(), { ...trace()[0], diagnosticEpoch: 3 }];
  assert.equal(
    qualify({ traceRecords: extraTrace }).firstFailedPredicate,
    "focus-trace-record-set",
  );
});

test("rejects a stale or non-monotonic authority revision chain", () => {
  const life = structuredClone(records());
  life[2].receipts[0].revision = expected.baselineAuthorityRevision;
  assert.equal(
    qualify({ lifecycleRecords: life }).firstFailedPredicate,
    "focus-authority-revision-chain",
  );
});

test("uses the later WorkspaceClient snapshot for blur presence after release settlement", () => {
  const life = structuredClone(records());
  life[2].settledIdentity.opentuiPresence.state = "foreground";
  assert.ok(qualify({ lifecycleRecords: life }).qualified);
});

test("accepts the live idempotent nondecreasing release revisions", () => {
  const life = structuredClone(records());
  for (const index of [0, 1, 2]) life[index].authorityRevision = 11;
  life[2].receipts = [15, 17, 17].map((revision, index) => ({
    ...life[2].receipts[index],
    revision,
  }));
  life[2].settledIdentity.authorityRevision = 17;
  for (const index of [4, 5, 6, 7]) life[index].authorityRevision = 17;
  assert.ok(
    qualify({
      lifecycleRecords: life,
      expected: { ...expected, baselineAuthorityRevision: 11, blurAuthorityRevision: 17 },
    }).qualified,
  );
});

test("assesses exact ordered journey boundaries", () => {
  const events = [
    "focus-namespace-ready",
    "focus-daemon-ready",
    "focus-tui-build",
    "focus-tui-started",
    "focus-host-ready",
    "focus-tui-coherent",
    "focus-blur-proved",
    "focus-reclaim-proved",
    "focus-web-correlation",
  ].map((phase) => ({ phase }));
  assert.equal(
    assessFocusJourneyBoundaries({
      timeline: events,
      evidence: { qualified: {} },
      correlationComplete: true,
    }).status,
    "passed",
  );
  const shuffled = [...events];
  [shuffled[6], shuffled[7]] = [shuffled[7], shuffled[6]];
  assert.equal(
    assessFocusJourneyBoundaries({
      timeline: shuffled,
      evidence: { qualified: {} },
      correlationComplete: true,
    }).firstBrokenBoundary,
    "focus-reclaim-proved",
  );
});

function focusWorkspaceRecord() {
  return {
    phase: "generation-workspace-client-state",
    processId: expected.processId,
    daemonGeneration: expected.daemonGeneration,
    monotonicMicros: 10,
    workspaceClient: {
      committed: {
        generation: expected.clientGeneration,
        phase: "live",
        authorityWorkspaceId: "workspace.id",
        authorityWorkspaceName: "Workspace",
        authorityShell: { workspace: { name: expected.workspaceName } },
        target: {
          daemon: { instanceId: expected.daemonGeneration },
          workspaceName: expected.workspaceName,
        },
        authority: {
          generation: expected.daemonGeneration,
          session: expected.sessionName,
          revision: 20,
          owners: released,
          clients: [{ clientId: expected.clientId, surface: "opentui", state: "background" }],
        },
        terminalResources: [
          {
            resourceId: "resource.one",
            windowResourceId: "window.one",
            active: true,
            semanticPaneId: expected.semanticPaneId,
          },
          {
            resourceId: "resource.two",
            windowResourceId: "window.two",
            active: false,
            semanticPaneId: "pane-2",
          },
        ],
      },
      pending: [],
      derived: {
        workspace: { id: "workspace.id", name: "Workspace" },
        terminalInventory: {
          activeResourceId: "resource.one",
          resources: [
            {
              id: "resource.one",
              windowResourceId: "window.one",
              active: true,
              attachability: { status: "available", semanticPaneId: expected.semanticPaneId },
            },
            {
              id: "resource.two",
              windowResourceId: "window.two",
              active: false,
              attachability: { status: "available", semanticPaneId: "pane-2" },
            },
          ],
        },
      },
    },
  };
}

test("qualifies one exact same-record focus WorkspaceClient handoff", () => {
  const record = focusWorkspaceRecord();
  const exact = {
    ...expected,
    afterMicros: 9,
    boundary: "focus-blur-proved",
    owners: released,
    presence: "background",
  };
  const qualified = qualifyFocusWorkspaceState([record], exact);
  assert.equal(qualified.committed.authority.revision, 20);
  assert.equal(qualified.record, record);
  assert.equal(qualified.committed, record.workspaceClient.committed);
  assert.equal(qualified.pending, record.workspaceClient.pending);
  assert.equal(qualified.derived, record.workspaceClient.derived);
  assert.equal(qualified.derived.terminalInventory.resources.length, 2);
  const webAssessment = assessFocusWebSemantic({
    web: {
      shellSource: "runtime",
      daemonGeneration: expected.daemonGeneration,
      visibilityState: "visible",
      hasFocus: true,
      windowContainerCount: 1,
      windows: [
        {
          windowResourceId: "window.one",
          semanticPaneIds: JSON.stringify([expected.semanticPaneId]),
          paneCount: "1",
          active: "true",
        },
        {
          windowResourceId: "window.two",
          semanticPaneIds: JSON.stringify(["pane-2"]),
          paneCount: "1",
          active: "false",
        },
      ],
      terminals: [
        {
          phase: "connected",
          workspaceName: expected.workspaceName,
          semanticPaneId: expected.semanticPaneId,
        },
      ],
    },
    derivedResources: qualified.derived.terminalInventory.resources,
    expectedWorkspaceName: expected.workspaceName,
    expectedSemanticPaneId: expected.semanticPaneId,
    expectedDaemonGeneration: expected.daemonGeneration,
  });
  assert.equal(webAssessment.qualified, true);
  assert.throws(
    () =>
      qualifyFocusWorkspaceState(
        [
          {
            ...record,
            workspaceClient: {
              ...record.workspaceClient,
              committed: {
                ...record.workspaceClient.committed,
                authority: { ...record.workspaceClient.committed.authority, owners: owned },
              },
            },
          },
        ],
        exact,
      ),
    /unavailable/u,
  );
});

test("focus WorkspaceClient handoff rejects every malformed or divergent same-record inventory", () => {
  const exact = {
    ...expected,
    afterMicros: 9,
    boundary: "focus-blur-proved",
    owners: released,
    presence: "background",
  };
  const mutations = [
    (record) => delete record.workspaceClient.derived,
    (record) => (record.workspaceClient.pending = [{}]),
    (record) => (record.workspaceClient.committed.terminalResources = []),
    (record) => (record.workspaceClient.derived.terminalInventory.resources = []),
    (record) =>
      record.workspaceClient.derived.terminalInventory.resources.push({
        id: "resource.extra",
        windowResourceId: "window.extra",
        active: false,
        attachability: { status: "available", semanticPaneId: "pane-extra" },
      }),
    (record) => record.workspaceClient.committed.terminalResources.pop(),
    (record) => delete record.workspaceClient.committed.terminalResources[0].windowResourceId,
    (record) => delete record.workspaceClient.committed.terminalResources[0].semanticPaneId,
    (record) =>
      (record.workspaceClient.derived.terminalInventory.resources[0].windowResourceId =
        "window.wrong"),
    (record) => (record.workspaceClient.derived.terminalInventory.resources[0].active = false),
    (record) =>
      (record.workspaceClient.derived.terminalInventory.resources[0].attachability.semanticPaneId =
        "pane-wrong"),
    (record) =>
      (record.workspaceClient.derived.terminalInventory.activeResourceId = "resource.two"),
    (record) => (record.workspaceClient.derived.workspace.id = "workspace.wrong"),
    (record) => (record.workspaceClient.derived.workspace.name = "Wrong"),
    (record) =>
      record.workspaceClient.derived.terminalInventory.resources.push(
        structuredClone(record.workspaceClient.derived.terminalInventory.resources[0]),
      ),
    (record) => {
      const duplicatePane = structuredClone(
        record.workspaceClient.derived.terminalInventory.resources[0],
      );
      duplicatePane.id = "resource.duplicate-pane";
      duplicatePane.active = false;
      record.workspaceClient.derived.terminalInventory.resources.push(duplicatePane);
    },
    (record) => {
      record.workspaceClient.committed.terminalResources = Array.from(
        { length: 513 },
        (_, index) => ({
          resourceId: `resource.${index}`,
          windowResourceId: `window.${index}`,
          active: index === 0,
          semanticPaneId: `pane.${index}`,
        }),
      );
      record.workspaceClient.derived.terminalInventory.resources = Array.from(
        { length: 513 },
        (_, index) => ({
          id: `resource.${index}`,
          windowResourceId: `window.${index}`,
          active: index === 0,
          attachability: { status: "available", semanticPaneId: `pane.${index}` },
        }),
      );
      record.workspaceClient.derived.terminalInventory.activeResourceId = "resource.0";
    },
  ];
  for (const mutate of mutations) {
    const record = focusWorkspaceRecord();
    mutate(record);
    assert.throws(() => qualifyFocusWorkspaceState([record], exact), /unavailable/u);
  }
});

test("focus WorkspaceClient handoff never falls back or splices derived state across records", () => {
  const exact = {
    ...expected,
    afterMicros: 9,
    boundary: "focus-blur-proved",
    owners: released,
    presence: "background",
  };
  const valid = focusWorkspaceRecord();
  const latest = structuredClone(valid);
  latest.monotonicMicros = 11;
  delete latest.workspaceClient.derived;
  assert.throws(() => qualifyFocusWorkspaceState([valid, latest], exact), /unavailable/u);
  latest.workspaceClient.derived = structuredClone(valid.workspaceClient.derived);
  latest.workspaceClient.derived.workspace.id = "workspace.from-other-record";
  assert.throws(() => qualifyFocusWorkspaceState([valid, latest], exact), /unavailable/u);
});

test("focus WorkspaceClient failures retain each explicit lifecycle boundary", () => {
  for (const boundary of [
    "focus-baseline",
    "focus-blur-proved",
    "focus-reclaim-proved",
    "focus-web-correlation",
  ]) {
    assert.throws(
      () =>
        qualifyFocusWorkspaceState([], {
          ...expected,
          afterMicros: 9,
          boundary,
          owners: released,
          presence: "background",
        }),
      (error) => error?.boundary === boundary && error?.observation?.boundaryExact === true,
    );
  }
  assert.throws(
    () =>
      qualifyFocusWorkspaceState([], {
        ...expected,
        afterMicros: 9,
        boundary: "not-a-focus-boundary",
        owners: released,
        presence: "background",
      }),
    (error) => error?.boundary === "focus-baseline" && error?.observation?.boundaryExact === false,
  );
});

test("post-Web focus qualification requires a fresh exact Web client convergence record", () => {
  const record = focusWorkspaceRecord();
  record.workspaceClient.committed.authority.owners = owned;
  record.workspaceClient.committed.authority.clients = [
    { clientId: expected.clientId, surface: "opentui", state: "foreground" },
    {
      clientId: "dev-web:12345678-1234-4123-8123-123456789abc",
      surface: "web",
      state: "foreground",
      connectedRevision: 21,
      activityRevision: 22,
    },
  ];
  const exact = {
    ...expected,
    afterMicros: 10,
    boundary: "focus-web-correlation",
    owners: owned,
    presence: "foreground",
  };
  const qualified = qualifyFocusWorkspaceState([record], exact);
  assert.equal(qualified.record, record);

  assert.throws(
    () => qualifyFocusWorkspaceState([record], { ...exact, afterMicros: 11 }),
    (error) => error?.boundary === "focus-web-correlation",
  );
  for (const mutate of [
    (candidate) => candidate.workspaceClient.committed.authority.clients.pop(),
    (candidate) => (candidate.workspaceClient.committed.authority.clients[1].state = "background"),
    (candidate) => (candidate.workspaceClient.committed.authority.clients[1].surface = "unknown"),
    (candidate) => (candidate.workspaceClient.committed.authority.clients[1].activityRevision = 20),
    (candidate) =>
      candidate.workspaceClient.committed.authority.clients.push({
        clientId: "dev-web:87654321-4321-4321-8321-cba987654321",
        surface: "web",
        state: "foreground",
        connectedRevision: 23,
        activityRevision: 24,
      }),
    (candidate) =>
      candidate.workspaceClient.committed.authority.clients.push({
        clientId: "sdk:extra-client",
        surface: "sdk",
        state: "background",
        connectedRevision: 23,
        activityRevision: 23,
      }),
  ]) {
    const candidate = structuredClone(record);
    mutate(candidate);
    assert.throws(
      () => qualifyFocusWorkspaceState([candidate], exact),
      (error) =>
        error?.boundary === "focus-web-correlation" &&
        error?.observation?.postWebClientExact === false,
    );
  }
  assert.throws(
    () => qualifyFocusWorkspaceState([record], { ...exact, semanticPaneId: "pane-wrong" }),
    (error) =>
      error?.observation?.activeResourceExact === false &&
      error?.observation?.clientGenerationExact === true,
  );
  assert.throws(
    () => qualifyFocusWorkspaceState([record], { ...exact, clientGeneration: 2 }),
    (error) => error?.observation?.clientGenerationExact === false,
  );
});
