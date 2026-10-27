import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { listTmuxServers } from "../../../packages/daemon-client/src/tmux-server-client.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { parseDiagnosticLine, diagnosticStatus } from "./live-diagnostics.ts";
import { startNativeJourney } from "./native-journey-fixture.mjs";
const fleet = await createScratchFleet({
  sessions: 2,
  slug: "gpui-browser",
  windowsPerSession: 1,
  initialPaneMarker: "RIG_GPUI_BROWSER",
});
let daemon, browser, native, journey, metadata;
const events = [];
let stderr = "";
// Fixed-field, bounded failure evidence: never retain terminal text or credentials.
const traceStarted = performance.now();
const lifecycleTrace = [];
let previousPublication;
let selectedTarget;
const trace = (value) => {
  if (value.event === "publication") {
    const key = JSON.stringify(value);
    if (key === previousPublication) return;
    previousPublication = key;
  }
  lifecycleTrace.push({ ms: Math.round(performance.now() - traceStarted), ...value });
  if (lifecycleTrace.length > 80) lifecycleTrace.shift();
};
const send = (command) => {
  if (command.type === "pane") selectedTarget = command.id;
  trace({
    event: "send",
    type: command.type,
    request: command.request,
    active: command.type === "presence" ? command.active : undefined,
    revision: command.type === "presence" ? (command.revision ?? 0) : undefined,
    resize: command.input?.kind === "resize" ? command.input.data : undefined,
  });
  if (command.type === "presence")
    recordResume({ kind: "presence", active: command.active, revision: command.revision ?? 0 });
  else if (command.type === "input")
    recordResume({
      kind: "input",
      request: command.request,
      inputKind: command.input.kind,
      ...(command.input.kind === "resize" ? command.input.data : {}),
    });
  if (journey && !["theme", "appearance"].includes(command.type)) journey.send(command);
  else browser.stdin.write(JSON.stringify(command) + "\n");
};
let previousGrid;
const observedGrid = (session) => {
  const grid = fleet.windowGrid(session);
  const key = JSON.stringify(grid);
  if (key !== previousGrid) {
    previousGrid = key;
    trace({ event: "grid", cols: grid.cols, rows: grid.rows });
  }
  return grid;
};
// Keep only structural metadata for the foreground geometry-reacquisition boundary.
// No terminal contents, host configuration, credentials, or pane/session names.
let resumeEvidence = null;
const recordResume = (entry) => {
  if (!resumeEvidence || resumeEvidence.complete) return;
  const previous = resumeEvidence.timeline.at(-1);
  const value = JSON.stringify(entry);
  if (previous?.value === value) return;
  if (resumeEvidence.timeline.length === 128) {
    resumeEvidence.dropped++;
    return;
  }
  resumeEvidence.timeline.push({ ms: Date.now() - resumeEvidence.started, value });
};
const resumePublication = (event) => ({
  kind: "publication",
  request: event.request,
  presenceRevision: event.presenceRevision,
  inputReady: event.inputReady === true,
  hasSnapshot: !!event.snapshot,
  cols: event.snapshot?.cols ?? null,
  rows: event.snapshot?.rows ?? null,
  status: [
    "Resize unavailable — reselect pane to retry",
    "Keyboard ready — click terminal to type",
    "Window inactive — activate tmux-ide to type",
    "Waiting for input authority",
  ].includes(event.status)
    ? event.status
    : "other",
});
const until = async (predicate) => {
  const end = Date.now() + (process.env.TMUX_GPUI_TEST_BINARY ? 120000 : 20000);
  while (!predicate()) {
    journey?.assertHealthy();
    if (browser?.exitCode !== null && browser?.exitCode !== undefined)
      throw new Error("Browser exited: " + stderr);
    if (Date.now() > end) throw new Error("Browser deadline: " + stderr);
    await new Promise((r) => setTimeout(r, 20));
  }
};
try {
  for (const name of fleet.sessionNames)
    fleet.typeInPane(name, "export LC_ALL=en_US.UTF-8; exec sh -i");
  daemon = await startDaemon(
    fleet,
    process.env.TMUX_GPUI_TEST_CLI !== undefined
      ? { cliPath: process.env.TMUX_GPUI_TEST_CLI }
      : undefined,
  );
  const options = {
    baseUrl: daemon.baseUrl + "/",
    ownerToken: daemon.record.authToken,
    hostClientId: "gpui-browser-test",
    origin: "tmux-ide://app",
  };
  const { servers } = await listTmuxServers(options);
  const server = servers.find((s) => s.state === "online");
  const host = {
    baseUrl: options.baseUrl,
    ownerToken: options.ownerToken,
    scope: { serverId: server.serverId, generation: server.generation },
  };
  const config = fleet.root + "/host.json";
  await writeFile(config, JSON.stringify(host), { mode: 0o600 });
  browser = spawn(
    process.execPath,
    [
      ...(process.env.TMUX_GPUI_TEST_BUNDLE ? [] : ["--import", "tsx"]),
      process.env.TMUX_GPUI_TEST_BUNDLE
        ? resolve(process.env.TMUX_GPUI_TEST_BUNDLE, "browser.bundle.mjs")
        : resolve("apps/tmux-gpui/bridge/browser.ts"),
      process.env.TMUX_GPUI_TEST_DISCOVERY ? "--local" : config,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...fleet.environment },
      ...(process.env.TMUX_GPUI_TEST_BUNDLE ? { cwd: fleet.root } : {}),
    },
  );
  browser.stderr.on("data", (b) => (stderr += b.toString()));
  let buffer = "";
  browser.stdout.on("data", (b) => {
    buffer += b.toString();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const event = JSON.parse(buffer.slice(0, end));
      if (process.env.TMUX_GPUI_TEST_BINARY) events.push(event);
      else if (event.connection) metadata = event;
      trace({
        event: "publication",
        request: event.request,
        selectedPaneMatches: selectedTarget ? event.selectedPane === selectedTarget : undefined,
        inputReady: event.inputReady,
        presenceRevision: event.presenceRevision,
        snapshot: !!event.snapshot,
        cols: event.snapshot?.cols,
        rows: event.snapshot?.rows,
      });
      recordResume(resumePublication(event));
      buffer = buffer.slice(end + 1);
    }
  });
  if (!process.env.TMUX_GPUI_TEST_BINARY) {
    journey = startNativeJourney(browser, {
      worker: true,
      onState: (state) => {
        const event = { ...metadata, ...state };
        if (state.snapshot)
          event.snapshot = {
            ...state.snapshot,
            grid: state.frameText
              .split("\n")
              .map((line) => ({ cells: [...line].map((grapheme) => ({ grapheme })) })),
          };
        events.push(event);
        recordResume(resumePublication(event));
      },
    });
    send({ type: "presence", active: true, revision: 0 });
  }
  if (process.env.TMUX_GPUI_TEST_BINARY) {
    native = spawn(process.env.TMUX_GPUI_TEST_BINARY, ["--tmux-browser-stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...fleet.environment },
    });
    browser.stdout.pipe(native.stdin);
    native.stdout.pipe(browser.stdin);
    native.stdin.on("error", () => {});
    // Replay the initial catalog if it arrived before the native reader attached.
    if (events.length) native.stdin.write(JSON.stringify(events.at(-1)) + "\n");
    console.log("Native picker ready: choose a pane in each of the two sessions");
    await until(
      () => new Set(events.filter((e) => e.snapshot).map((e) => e.selectedSession)).size === 2,
    );
    if (process.env.TMUX_GPUI_TEST_FOCUS_ONLY) {
      await until(
        () => events.at(-1)?.inputReady && fleet.windowGrid(fleet.sessionNames[1]).cols !== 80,
      );
      const focusedGrid = fleet.windowGrid(fleet.sessionNames[1]);
      const focusedPublication = events.at(-1);
      const focusStart = events.length;
      const backgroundAck = () =>
        events
          .slice(focusStart)
          .find(
            (event) =>
              event.request === focusedPublication.request &&
              event.presenceRevision > focusedPublication.presenceRevision &&
              event.inputReady === false,
          );
      console.log("Native focus test ready: switch away from the preview");
      await until(() => !!backgroundAck());
      const backgroundPublication = backgroundAck();
      assert.deepEqual(
        fleet.windowGrid(fleet.sessionNames[1]),
        focusedGrid,
        "physical focus loss preserves the fitted terminal grid",
      );
      console.log("Native background revoked input and preserved geometry; return to preview");
      await until(() =>
        events
          .slice(focusStart)
          .some(
            (event) =>
              event.request === focusedPublication.request &&
              event.presenceRevision > backgroundPublication.presenceRevision &&
              event.inputReady === true,
          ),
      );
      assert.deepEqual(
        fleet.windowGrid(fleet.sessionNames[1]),
        focusedGrid,
        "physical focus return preserves geometry while reacquiring input",
      );
      console.log("Native foreground reacquired input with the same source window geometry");
    } else {
      console.log(
        "Native selection across both sessions produced verified snapshots; click terminal and type echo gpui then Enter",
      );
      await until(() =>
        events.some((e) =>
          e.snapshot?.grid.some(
            (row) =>
              row.cells
                .map((c) => c.grapheme)
                .join("")
                .trim() === "gpui",
          ),
        ),
      );
      console.log(
        "Native keyboard input produced the exact expected output; paste printf 'nativepaste界🌍\\n' then Enter",
      );
      await until(() =>
        events.some((e) =>
          e.snapshot?.grid.some(
            (row) =>
              row.cells
                .map((c) => c.grapheme)
                .join("")
                .trim() === "nativepaste界🌍",
          ),
        ),
      );
      console.log(
        "Native clipboard paste produced exact Unicode output; type echo then Option-e,e and Enter for composed é",
      );
      await until(() =>
        events.some((e) =>
          e.snapshot?.grid.some(
            (row) =>
              row.cells
                .map((c) => c.grapheme)
                .join("")
                .trim() === "é",
          ),
        ),
      );
      console.log("Native composed text produced exact output; resize the native window now");
      const beforeResize = fleet.windowGrid(fleet.sessionNames[1]);
      await until(() => {
        const after = fleet.windowGrid(fleet.sessionNames[1]);
        return after.cols !== beforeResize.cols && after.rows !== beforeResize.rows;
      });
      console.log("Native window resize changed the source tmux window grid");
      await new Promise((r) => setTimeout(r, 15000));
    }
  } else {
    await until(() => events.some((e) => e.sessions.length === 2));
    const sessions = events.at(-1).sessions;
    send({ type: "session", request: 1, id: sessions[0].id });
    await until(
      () =>
        events.at(-1)?.request === 1 &&
        events.at(-1)?.panes.length &&
        events.at(-1)?.panes.every((p) => p.windowId && p.windowLabel),
    );
    assert.equal(events.at(-1).snapshot, null);
    assert.equal(events.at(-1).inputReady, false);
    assert.equal(events.at(-1).selectedPane, null);
    const first = events.find((e) => e.request === 1 && e.panes.length).panes[0].id;
    send({ type: "pane", request: 2, id: first });
    await until(() => events.some((e) => e.request === 2 && e.snapshot && e.inputReady));
    assert.ok(events.at(-1).panes.some((pane) => pane.windowId && pane.windowLabel));
    send({ type: "theme", id: "dracula" });
    await until(() => events.at(-1)?.appearance?.selected === "dracula");
    assert.equal(events.at(-1).request, 2);
    assert.equal(events.at(-1).selectedPane, first);
    assert.equal(events.at(-1).inputReady, true);
    assert.equal(
      JSON.parse(await readFile(fleet.environment.TMUX_IDE_CONFIG, "utf8")).theme.preset,
      "dracula",
    );
    const themed = events.at(-1).appearance.theme;
    send({ type: "appearance", system: "light" });
    await until(() => events.at(-1)?.appearance?.system === "light");
    assert.deepEqual(events.at(-1).appearance.theme, themed);
    send({ type: "theme", id: "unknown-theme" });
    await until(() => events.at(-1)?.appearance?.error);
    assert.equal(events.at(-1).appearance.selected, "dracula");
    assert.equal(events.at(-1).inputReady, true);
    send({
      type: "input",
      request: 2,
      id: first,
      input: { kind: "text", data: "printf 'GPUI_INPUT_ONE\\n'" },
    });
    send({ type: "input", request: 2, id: first, input: { kind: "key", data: "Enter" } });
    await until(() =>
      events.some(
        (e) =>
          e.request === 2 &&
          e.snapshot?.grid.some(
            (row) =>
              row.cells
                .map((c) => c.grapheme)
                .join("")
                .trim() === "GPUI_INPUT_ONE",
          ),
      ),
    );
    // Rapid switches: a later request cannot be followed by an earlier publication.
    send({ type: "session", request: 3, id: sessions[1].id });
    send({ type: "session", request: 4, id: sessions[0].id });
    send({ type: "session", request: 5, id: sessions[1].id });
    await until(() => events.some((e) => e.request === 5 && e.panes.length));
    const second = events.find((e) => e.request === 5 && e.panes.length).panes[0].id;
    assert.notEqual(first, second);
    send({ type: "pane", request: 6, id: second });
    await until(() => events.some((e) => e.request === 6 && e.snapshot && e.inputReady));
    send({
      type: "input",
      request: 2,
      id: first,
      input: { kind: "text", data: "STALE_INPUT_MUST_NOT_ARRIVE" },
    });
    send({
      type: "input",
      request: 6,
      id: second,
      input: { kind: "text", data: "printf 'GPUI_INPUT_TWO\\n'" },
    });
    send({ type: "input", request: 6, id: second, input: { kind: "key", data: "Enter" } });
    await until(() =>
      events.some(
        (e) =>
          e.request === 6 &&
          e.snapshot?.grid.some(
            (row) =>
              row.cells
                .map((c) => c.grapheme)
                .join("")
                .trim() === "GPUI_INPUT_TWO",
          ),
      ),
    );
    send({
      type: "input",
      request: 6,
      id: second,
      input: { kind: "paste", data: "#" + "x".repeat(1100) + "\nprintf '\\nGPUI_PASTE_界🌍\\n'\n" },
    });
    await until(() =>
      events.some(
        (e) =>
          e.request === 6 &&
          e.snapshot?.grid.some(
            (row) =>
              row.cells
                .map((c) => c.grapheme)
                .join("")
                .trim() === "GPUI_PASTE_界🌍",
          ),
      ),
    ).catch((error) => {
      console.error(JSON.stringify(events.at(-1)));
      throw error;
    });
    const untouched = fleet.windowGrid(fleet.sessionNames[0]);
    send({
      type: "input",
      request: 2,
      id: first,
      input: { kind: "resize", data: { cols: 52, rows: 19 } },
    });
    const resizeStart = events.length;
    send({
      type: "input",
      request: 6,
      id: second,
      input: { kind: "resize", data: { cols: 91, rows: 27 } },
    });
    for (const data of "echo GPUI_RESIZE_INPUT")
      send({ type: "input", request: 6, id: second, input: { kind: "text", data } });
    send({ type: "input", request: 6, id: second, input: { kind: "key", data: "Enter" } });
    await until(() => {
      const grid = observedGrid(fleet.sessionNames[1]);
      return grid.cols === 91 && grid.rows === 27;
    });
    await until(() =>
      events
        .slice(resizeStart)
        .some((e) => e.snapshot?.cols === 91 && e.snapshot?.rows === 27 && e.inputReady),
    );
    assert.ok(
      events
        .slice(resizeStart)
        .every((e) => e.request !== 6 || (e.snapshot && e.selectedPane === second)),
      "Resize retains the selected terminal while Rust buffers input until geometry is coherent",
    );
    await until(() =>
      fleet
        .captureWindowPanes(fleet.sessionNames[1])
        .split("\n")
        .some((line) => line.trim() === "GPUI_RESIZE_INPUT"),
    );
    for (let n = 0; n < 20; n++)
      send({
        type: "input",
        request: 6,
        id: second,
        input: { kind: "resize", data: { cols: 92 + n, rows: 28 + n } },
      });
    await until(() => {
      const grid = observedGrid(fleet.sessionNames[1]);
      return grid.cols === 111 && grid.rows === 47;
    });
    resumeEvidence = { started: Date.now(), dropped: 0, timeline: [] };
    recordResume(resumePublication(events.at(-1)));
    send({ type: "presence", active: false, revision: 1 });
    await until(() => events.at(-1)?.presenceRevision === 1 && events.at(-1)?.inputReady === false);
    const backgroundGrid = fleet.windowGrid(fleet.sessionNames[1]);
    recordResume({ kind: "background-grid", ...backgroundGrid });
    assert.equal(backgroundGrid.cols, 111, "focus loss preserves terminal columns");
    assert.equal(backgroundGrid.rows, 47, "focus loss preserves terminal rows");
    send({
      type: "input",
      request: 6,
      id: second,
      input: { kind: "text", data: "BACKGROUND_INPUT_MUST_NOT_ARRIVE" },
    });
    send({
      type: "input",
      request: 6,
      id: second,
      input: { kind: "resize", data: { cols: 60, rows: 20 } },
    });
    send({ type: "presence", active: true, revision: 2 });
    await until(() => events.at(-1)?.presenceRevision === 2 && events.at(-1)?.inputReady === true);
    const restoredGrid = fleet.windowGrid(fleet.sessionNames[1]);
    recordResume({ kind: "restored-grid", ...restoredGrid });
    assert.deepEqual(restoredGrid, backgroundGrid);
    send({
      type: "input",
      request: 6,
      id: second,
      input: { kind: "resize", data: { cols: 95, rows: 30 } },
    });
    await until(() => {
      const grid = observedGrid(fleet.sessionNames[1]);
      recordResume({ kind: "post-resume-grid", ...grid });
      return grid.cols === 95 && grid.rows === 30;
    });
    resumeEvidence.complete = true;
    assert.ok(
      !fleet.captureWindowPanes(fleet.sessionNames[1]).includes("BACKGROUND_INPUT_MUST_NOT_ARRIVE"),
    );
    assert.deepEqual(fleet.windowGrid(fleet.sessionNames[0]), untouched);
    for (const name of fleet.sessionNames)
      assert.ok(!fleet.captureWindowPanes(name).includes("STALE_INPUT_MUST_NOT_ARRIVE"));
    send({ type: "presence", active: false, revision: 3 });
    send({ type: "pane", request: 7, id: second });
    await until(() => events.at(-1)?.request === 7 && !!events.at(-1)?.snapshot);
    assert.equal(events.at(-1).inputReady, false);
    assert.match(
      events.at(-1).status,
      /^(Window inactive — activate tmux-ide to type|Waiting for input authority)$/,
    );
    send({ type: "presence", active: true, revision: 4 });
    await until(
      () =>
        events.at(-1)?.request === 7 &&
        events.at(-1)?.presenceRevision === 4 &&
        events.at(-1)?.inputReady === true,
    );
    let last = 0;
    for (const event of events) {
      assert.ok(
        event.request >= last,
        `Native request regressed: ${last} -> ${event.request}; status=${event.status}`,
      );
      last = event.request;
      if (event.snapshot && event.request === 6) assert.equal(event.selectedPane, second);
    }
  }
  let lastRequest = 0;
  for (const event of events) {
    assert.ok(
      event.request >= lastRequest,
      `Native request regressed: ${lastRequest} -> ${event.request}; status=${event.status}`,
    );
    lastRequest = event.request;
  }
  assert.equal(stderr, "", "healthy browser must not report a diagnostic before shutdown");
  const stopIndex = events.length;
  const stopRequest = events.at(-1).request;
  await daemon.stop();
  daemon = undefined;
  if (journey) {
    await until(() =>
      events
        .slice(stopIndex)
        .some(
          (event) =>
            event.request === stopRequest &&
            event.snapshot === null &&
            !event.inputReady &&
            /reconnecting|interrupted|unavailable/i.test(event.status),
        ),
    );
  } else {
    const shutdownDiagnostic = () =>
      stderr
        .split("\n")
        .map(parseDiagnosticLine)
        .find(
          (diagnostic) =>
            diagnostic &&
            ["source-closed", "transport-closed", "transport-error"].includes(diagnostic.code),
        );
    await until(() => {
      const diagnostic = shutdownDiagnostic();
      return (
        diagnostic &&
        events
          .slice(stopIndex)
          .some(
            (event) =>
              event.request === stopRequest &&
              event.status === diagnosticStatus(diagnostic) &&
              event.snapshot === null &&
              event.inputReady === false,
          )
      );
    });
    const retiredIndex = events.findIndex(
      (event, index) =>
        index >= stopIndex && event.status === diagnosticStatus(shutdownDiagnostic()),
    );
    for (const event of events.slice(retiredIndex)) {
      assert.equal(event.request, stopRequest);
      assert.equal(event.snapshot, null, "shutdown must clear terminal contents");
      assert.equal(event.inputReady, false, "shutdown must revoke input");
    }
  }
  if (!native) {
    // Keep the same browser process across a real daemon replacement.
    daemon = await startDaemon(
      fleet,
      process.env.TMUX_GPUI_TEST_CLI !== undefined
        ? { cliPath: process.env.TMUX_GPUI_TEST_CLI }
        : undefined,
    );
    const freshOptions = {
      ...options,
      baseUrl: daemon.baseUrl + "/",
      ownerToken: daemon.record.authToken,
    };
    const freshServers = await listTmuxServers(freshOptions);
    const freshServer = freshServers.servers.find((s) => s.state === "online");
    assert.ok(freshServer);
    await writeFile(
      config,
      JSON.stringify({
        baseUrl: freshOptions.baseUrl,
        ownerToken: freshOptions.ownerToken,
        scope: { serverId: freshServer.serverId, generation: freshServer.generation },
      }),
      { mode: 0o600 },
    );
    send({ type: "refresh", request: 8 });
    await until(
      () =>
        events.at(-1)?.request === 8 &&
        events.at(-1)?.sessions.length === 2 &&
        events.at(-1)?.status === "Choose a session",
    );
    send({ type: "session", request: 9, id: events.at(-1).sessions[0].id });
    await until(() => events.at(-1)?.request === 9 && events.at(-1)?.panes.length);
    const freshPane = events.at(-1).panes[0].id;
    send({ type: "pane", request: 10, id: freshPane });
    await until(
      () => events.at(-1)?.request === 10 && events.at(-1)?.snapshot && events.at(-1)?.inputReady,
    );
    send({
      type: "input",
      request: 7,
      id: freshPane,
      input: { kind: "text", data: "STALE_RECONNECT_MUST_NOT_ARRIVE" },
    });
    send({
      type: "input",
      request: 10,
      id: freshPane,
      input: { kind: "text", data: "echo RECONNECTED_GPUI\n" },
    });
    await until(() => fleet.captureWindowPanes(fleet.sessionNames[0]).includes("RECONNECTED_GPUI"));
    assert.ok(
      !fleet.captureWindowPanes(fleet.sessionNames[0]).includes("STALE_RECONNECT_MUST_NOT_ARRIVE"),
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      sessions: 2,
      switched: true,
      requestOrder: true,
      unavailable: true,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      lifecycleFailure: true,
      browserExitCode: browser?.exitCode ?? null,
      trace: lifecycleTrace,
    }),
  );
  throw error;
} finally {
  if (resumeEvidence)
    console.error(
      JSON.stringify({
        diagnostic: "browser-resume-resize",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        dropped: resumeEvidence.dropped,
        completed: resumeEvidence.complete === true,
        timeline: resumeEvidence.timeline.map(({ ms, value }) => ({ ms, ...JSON.parse(value) })),
      }),
    );
  if (journey) await journey.stop();
  if (native && native.exitCode === null) {
    const close = once(native, "close");
    native.kill("SIGTERM");
    await close;
  }
  if (browser && browser.exitCode === null) {
    const close = once(browser, "close");
    browser.kill("SIGTERM");
    const timer = setTimeout(() => browser.kill("SIGKILL"), 2000);
    try {
      await close;
    } finally {
      clearTimeout(timer);
    }
  }
  if (daemon) await daemon.stop();
  await fleet.dispose();
}
