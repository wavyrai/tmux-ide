import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const MAX_BYTES = 32 * 1024 * 1024;
const NATIVE_FORMAT =
  "#{session_name}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_pid}\t#{pane_width}\t#{pane_height}\t#{cursor_x}\t#{cursor_y}\t#{alternate_on}\t#{insert_flag}\t#{origin_flag}\t#{wrap_flag}\t#{scroll_region_upper}\t#{scroll_region_lower}";
const canonicalKeys = [
  "processId",
  "clockId",
  "generation",
  "incarnation",
  "semanticPaneId",
  "revision",
  "stateHash",
];
const stableKeys = [
  "sessionName",
  "sessionId",
  "windowId",
  "paneId",
  "semanticPaneId",
  "pid",
  "cols",
  "rows",
  "alternate",
  "insert",
  "origin",
  "wrap",
  "scrollTop",
  "scrollBottom",
];
const equalKeys = (a, b, keys) => keys.every((key) => a?.[key] === b?.[key]);

export function parseReferenceNativeIdentity(text, sessionName, mode = "append") {
  assert(["append", "causal-cell"].includes(mode), "Unknown output content mode");
  const fields = text.trimEnd().split("\t");
  assert.equal(fields.length, 16, "Native identity field count");
  const [name, sessionId, windowId, paneId, semanticPaneId, ...numeric] = fields;
  assert.equal(name, sessionName, "Foreign producer session");
  assert(/^\$\d+$/u.test(sessionId) && /^@\d+$/u.test(windowId) && /^%\d+$/u.test(paneId));
  assert(semanticPaneId.length > 0 && !semanticPaneId.includes("\n"));
  assert(
    numeric.every((v) => /^\d+$/u.test(v)),
    "Missing/invalid native mode or geometry",
  );
  const [
    pid,
    cols,
    rows,
    cursorX,
    cursorY,
    alternate,
    insert,
    origin,
    wrap,
    scrollTop,
    scrollBottom,
  ] = numeric.map(Number);
  assert([pid, cols, rows, cursorX, cursorY, scrollTop, scrollBottom].every(Number.isSafeInteger));
  assert(pid > 0 && cols > 0 && rows > 0 && cols * rows <= 100_000);
  assert(cursorX < cols && cursorY < rows);
  assert([alternate, insert, origin, wrap].every((v) => v === 0 || v === 1));
  assert(
    alternate === 0 &&
      insert === 0 &&
      origin === 0 &&
      wrap === (mode === "causal-cell" ? 0 : 1) &&
      scrollTop === 0 &&
      scrollBottom === rows - 1,
    "Unsupported producer terminal modes",
  );
  return {
    sessionName: name,
    sessionId,
    windowId,
    paneId,
    semanticPaneId,
    pid,
    cols,
    rows,
    cursorX,
    cursorY,
    alternate,
    insert,
    origin,
    wrap,
    scrollTop,
    scrollBottom,
  };
}

export function expectedReferencePrefix(baseline, payloads, mode = "append") {
  assert(["append", "causal-cell"].includes(mode), "Unknown output content mode");
  assert(
    payloads.every((p) => p === "x" || p === "y"),
    "Unsupported echo payload",
  );
  const { identity, cells } = baseline;
  if (mode === "causal-cell") {
    assert(
      identity.wrap === 0 && identity.cursorX === identity.cols - 1,
      "Causal fixture requires fixed last-column cursor",
    );
    const expected = cells.map((row) => [...row]);
    let previous = expected[identity.cursorY][identity.cursorX];
    for (const payload of payloads) {
      assert(payload !== previous, "Causal fixture must change the declared cell");
      previous = payload;
    }
    expected[identity.cursorY][identity.cursorX] = previous;
    return { cells: expected, cursorX: identity.cursorX, cursorY: identity.cursorY };
  }
  assert(
    identity.cursorX + payloads.length < identity.cols,
    "Echo would wrap or reach pending-wrap boundary",
  );
  const expected = cells.map((row) => [...row]);
  for (let i = 0; i < payloads.length; i++)
    expected[identity.cursorY][identity.cursorX + i] = payloads[i];
  return {
    cells: expected,
    cursorX: identity.cursorX + payloads.length,
    cursorY: identity.cursorY,
  };
}

export function checkReferenceOutputContent({
  baseline,
  native,
  hostCells,
  rect,
  payloads,
  mode = "append",
}) {
  assert(
    equalKeys(baseline.identity, native.identity, stableKeys),
    "Producer identity/geometry/modes changed",
  );
  const expected = expectedReferencePrefix(baseline, payloads, mode);
  assert.deepEqual(
    native.cells,
    expected.cells,
    "Native full viewport differs from expected prefix",
  );
  assert.equal(native.identity.cursorX, expected.cursorX, "Native cursor X differs");
  assert.equal(native.identity.cursorY, expected.cursorY, "Native cursor Y differs");
  // The initial supported lane is a non-scrolling top-left projection. Different
  // grid sizes are allowed, but hidden appended cells never qualify as output.
  assert(rect.width <= baseline.identity.cols && rect.bodyRows <= baseline.identity.rows);
  assert(
    baseline.identity.cursorY < rect.bodyRows && expected.cursorX < rect.width,
    "Echo outside visible host viewport",
  );
  const projected = expected.cells.slice(0, rect.bodyRows).map((r) => r.slice(0, rect.width));
  assert.deepEqual(hostCells, projected, "Host full pane viewport differs from expected prefix");
  return {
    observedPrefix: payloads.length,
    nativeCursor: { x: expected.cursorX, y: expected.cursorY },
    textOnly: true,
  };
}

export function observeReferenceOutputAttempt(witness, attempt, match, save) {
  attempt.outputObservation = "pending";
  const errors = [];
  try {
    witness.observe(attempt.ordinal, match);
    attempt.outputObservation = "observed";
  } catch (error) {
    errors.push(error);
    attempt.outputObservation = "failed";
    attempt.outputError = String(error.message);
  }
  try {
    save();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Output witness and controller persistence failed", {
      cause: errors[0],
    });
}

function latestCanonical(records, expected) {
  const header = records[0];
  assert.equal(header?.type, "performance.trace.header");
  const matching = records.filter(
    (r) =>
      r.processId === header.processId &&
      r.semanticPaneId === expected.semanticPaneId &&
      [
        "performance.terminal-canonical-mode",
        "performance.terminal-canonical-update",
        "performance.terminal-canonical-publication",
      ].includes(r.type),
  );
  const record = matching.at(-1);
  assert(
    record &&
      record.generation === expected.generation &&
      record.clockId === header.clockId &&
      record.clockKind === "performance-now",
    "Missing current canonical authority",
  );
  assert(
    Number.isSafeInteger(record.revision) &&
      record.revision >= 0 &&
      /^[a-f0-9]{16}$/u.test(record.stateHash),
  );
  assert(typeof record.incarnation === "string" && record.incarnation.length > 0);
  return record;
}

// Opt-in correctness observer. All probes run after a matched paint, never inside
// its local clock interval. The 6s probe deadline is shared across child commands.
export async function createReferenceOutputWitness({
  root,
  reference,
  target,
  generation,
  records,
  payloads,
  expectedHost,
  mode = "append",
  command = (binary, args, options) => execFileSync(binary, args, options),
  now = () => performance.now(),
}) {
  assert(
    reference.socketArgs?.length === 2 &&
      reference.socketArgs[0] === "-S" &&
      reference.socketArgs[1].startsWith("/"),
    "Explicit private socket required",
  );
  assert(
    expectedHost?.sessionName === reference.hostSession &&
      /^%\d+$/u.test(expectedHost.paneId) &&
      /^\$\d+$/u.test(expectedHost.sessionId) &&
      Number.isSafeInteger(expectedHost.processId),
    "Exact launched host identity required",
  );
  const { decodeFocusFramebufferCapture, sliceFocusTerminalCells, projectFocusFramebufferRect } =
    await import("./product-focus.mjs");
  const { parseLayout } =
    await import("../../packages/daemon/src/terminal/protocol/layout-parse.ts");
  const path = join(reference.runtimeDir, "output-content.json");
  const evidence = {
    version: 1,
    mode,
    status: "pending",
    scope:
      "Per-input source and host full-viewport text correctness; not styles, terminal-output latency or native parity",
    schedule:
      "Source/host observation after each mapped paint before next offer; instrumented scheduling differs",
    baseline: null,
    attempts: payloads.map((payload, ordinal) => ({ ordinal, payload, status: "not-observed" })),
  };
  const save = () => {
    const text = JSON.stringify(evidence, null, 2);
    assert(Buffer.byteLength(text) <= MAX_BYTES, "Output evidence exceeds 32 MiB");
    writeFileSync(path, text, { mode: 0o600 });
  };
  save();
  let deadline;
  const invoke = (binary, args, maxBuffer = 4 * 1024 * 1024) => {
    const remaining = Math.floor(deadline - now());
    assert(remaining > 0, "Output observation deadline exceeded");
    return command(binary, args, {
      cwd: root,
      env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
      encoding: "utf8",
      timeout: Math.min(1750, remaining),
      maxBuffer,
    });
  };
  const tmux = (args) => invoke("tmux", [...reference.socketArgs, ...args]);
  const nativeIdentity = () => {
    const raw = tmux(["list-panes", "-t", `=${target}`, "-F", NATIVE_FORMAT]);
    assert.equal(
      raw.trimEnd().split("\n").length,
      1,
      "Reference requires exactly one producer pane",
    );
    return parseReferenceNativeIdentity(raw, target, mode);
  };
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const cellsFor = (line, width) => {
    const cells = Array.from(segmenter.segment(line), (part) => part.segment);
    assert(
      cells.length === width && cells.every((cell) => sliceFocusTerminalCells(cell, 0, 1) === cell),
      "Unsupported wide/split cell in observed pane",
    );
    return cells;
  };
  const grid = (envelope) => {
    const decoded = decodeFocusFramebufferCapture(envelope);
    return decoded.plain.split("\n").map((line) => cellsFor(line, decoded.cols));
  };
  const captureNative = () => {
    const identity = nativeIdentity();
    const ansi = tmux(["capture-pane", "-N", "-e", "-p", "-t", identity.paneId, "-S", "0"]).replace(
      /\n$/u,
      "",
    );
    const after = nativeIdentity();
    assert.deepEqual(after, identity, "Producer moved during snapshot");
    return {
      identity,
      ansi,
      cells: grid({ version: 1, cols: identity.cols, rows: identity.rows, ansi }),
    };
  };
  const layout = (identity) => {
    const rows = tmux([
      "list-panes",
      "-t",
      identity.paneId,
      "-F",
      "#{window_visible_layout}\t#{window_id}\t#{?window_zoomed_flag,1,0}\t#{pane-border-status}\t#{pane_id}\t#{@tmux_ide_pane_id}\t#{pane_active}",
    ])
      .trimEnd()
      .split("\n")
      .map((l) => l.split("\t"));
    assert.equal(rows.length, 1);
    const [visible, windowId, zoomed, border, paneId, semantic, active] = rows[0];
    assert(
      windowId === identity.windowId &&
        paneId === identity.paneId &&
        semantic === identity.semanticPaneId &&
        active === "1" &&
        zoomed === "0" &&
        ["off", "top", "bottom"].includes(border),
    );
    const parsed = parseLayout(visible);
    assert(parsed && parsed.leaves.length === 1 && parsed.leaves[0].id === paneId);
    const leaf = parsed.leaves[0];
    return {
      type: "layout",
      semanticWindowId: windowId,
      windowName: null,
      currentWindow: true,
      cols: parsed.width,
      rows: parsed.height,
      zoomed: false,
      paneBorderStatus: border,
      panes: [
        {
          pane: semantic,
          left: leaf.left,
          top: leaf.top,
          width: leaf.width,
          height: leaf.height,
          active: true,
        },
      ],
    };
  };
  const captureHost = () =>
    JSON.parse(
      invoke(process.execPath, ["scripts/tui-testdrive.mjs", "capture", "--ansi", "--json"]),
    );
  let baseline, canonical, hostIdentity, frozenLayout, rect;
  const observe = (ordinal, match) => {
    deadline = now() + 6000;
    const beforeTime = now();
    const entry = ordinal === null ? {} : evidence.attempts[ordinal];
    const errors = [];
    try {
      const native = captureNative();
      entry.native = native;
      const beforeCanonical = latestCanonical(records(), {
        semanticPaneId: native.identity.semanticPaneId,
        generation,
      });
      const currentLayout = layout(native.identity);
      const host = captureHost();
      entry.host = host;
      const afterNative = nativeIdentity();
      assert.deepEqual(
        afterNative,
        native.identity,
        "Producer identity/cursor changed around host capture",
      );
      assert.deepEqual(layout(native.identity), currentLayout, "Layout changed around capture");
      const afterCanonical = latestCanonical(records(), {
        semanticPaneId: native.identity.semanticPaneId,
        generation,
      });
      assert(
        equalKeys(beforeCanonical, afterCanonical, canonicalKeys),
        "Canonical revision changed around observation",
      );
      assert.equal(
        host.hostIdentity?.processId,
        Number(beforeCanonical.processId.split(":")[1]),
        "Foreign host process",
      );
      assert.deepEqual(
        host.hostIdentity,
        expectedHost,
        "Capture differs from launched host identity",
      );
      assert(host.hostIdentity?.cols === host.cols && host.hostIdentity?.rows === host.rows);
      if (ordinal === null) {
        baseline = native;
        canonical = beforeCanonical;
        hostIdentity = host.hostIdentity;
        frozenLayout = currentLayout;
        rect = projectFocusFramebufferRect({
          hostCols: host.cols,
          hostRows: host.rows,
          canonicalLayout: currentLayout,
          canonicalPaneId: native.identity.semanticPaneId,
        });
        assert(rect && rect.width > 0 && rect.bodyRows > 0, "Unsupported viewport projection");
        expectedReferencePrefix(baseline, payloads, mode);
        assert(
          baseline.identity.cursorY < rect.bodyRows &&
            (mode === "causal-cell"
              ? baseline.identity.cursorX
              : baseline.identity.cursorX + payloads.length) < rect.width,
          "Predicted echo not wholly visible",
        );
      } else {
        entry.previousRevision = canonical.revision;
        assert(beforeCanonical.revision > canonical.revision, "Canonical revision did not advance");
        assert(
          equalKeys(beforeCanonical, canonical, [
            "processId",
            "clockId",
            "generation",
            "incarnation",
            "semanticPaneId",
          ]),
          "Canonical authority changed",
        );
        assert.deepEqual(host.hostIdentity, hostIdentity, "Host identity/geometry changed");
        assert.deepEqual(currentLayout, frozenLayout, "Canonical layout changed");
        const paints = records().filter((r) => r.traceId === match.traceId && r.stage === "paint");
        assert.equal(paints.length, 1, "Ambiguous matched paint");
        assert(
          equalKeys(paints[0], beforeCanonical, canonicalKeys),
          "Capture is not the matched paint revision",
        );
        assert.equal(match.semanticPaneId, canonical.semanticPaneId);
        assert.equal(match.generation, canonical.generation);
        assert.equal(match.incarnation, canonical.incarnation);
      }
      const presentations = records().filter(
        (r) =>
          r.type === "performance.terminal-cursor-presentation" &&
          equalKeys(r, beforeCanonical, canonicalKeys) &&
          (ordinal === null || r.traceId === match.traceId),
      );
      const presentation = presentations.at(-1);
      assert(
        presentation?.visible === true &&
          presentation.cursorX === native.identity.cursorX &&
          presentation.cursorY === native.identity.cursorY,
        "Missing unclamped live presentation",
      );
      assert(
        presentation.cols === native.identity.cols &&
          presentation.rows === native.identity.rows &&
          presentation.viewportCols === rect.width &&
          presentation.viewportRows === rect.bodyRows,
        "Presentation dimensions differ",
      );
      assert(
        presentation.screenX - 1 - presentation.cursorX === rect.left &&
          presentation.screenY - 1 - presentation.cursorY === rect.firstBodyRow,
        "Projected host crop disagrees with presentation",
      );
      if (ordinal === null) {
        evidence.sourceEpoch = presentation.sourceEpoch;
        evidence.rendererEpoch = presentation.rendererEpoch;
      }
      assert(
        Number.isSafeInteger(presentation.sourceEpoch) &&
          Number.isSafeInteger(presentation.rendererEpoch) &&
          presentation.sourceEpoch === evidence.sourceEpoch &&
          presentation.rendererEpoch === evidence.rendererEpoch,
        "Presentation epoch changed",
      );
      entry.presentation = presentation;
      const hostDecoded = decodeFocusFramebufferCapture(host);
      assert(
        rect.left >= 0 &&
          rect.firstBodyRow >= 0 &&
          rect.left + rect.width <= host.cols &&
          rect.firstBodyRow + rect.bodyRows <= host.rows,
      );
      const hostCells = hostDecoded.plain
        .split("\n")
        .slice(rect.firstBodyRow, rect.firstBodyRow + rect.bodyRows)
        .map((line) => {
          const slice = sliceFocusTerminalCells(line, rect.left, rect.width);
          assert(slice !== null, "Host crop cuts a terminal cell");
          return cellsFor(slice, rect.width);
        });
      entry.proof = checkReferenceOutputContent({
        baseline,
        native,
        hostCells,
        rect,
        payloads: ordinal === null ? [] : payloads.slice(0, ordinal + 1),
        mode,
      });
      assert(now() <= deadline, "Output observation exceeded deadline after comparison");
      entry.canonical = beforeCanonical;
      entry.status = "observed";
      canonical = beforeCanonical;
      if (ordinal === null) {
        Object.assign(entry, { rect, layout: frozenLayout, hostIdentity });
        evidence.baseline = entry;
      }
    } catch (error) {
      errors.push(error);
      entry.status = "failed";
      entry.error = String(error.message);
      evidence.status = "failed";
      if (ordinal === null) evidence.baseline = entry;
    }
    entry.observerMs = now() - beforeTime;
    try {
      save();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Output observation and persistence failed", {
        cause: errors[0],
      });
  };
  observe(null, null);
  return {
    path,
    causalBaseline: () => {
      assert.equal(mode, "causal-cell");
      return {
        ...canonical,
        initialCell: {
          row: baseline.identity.cursorY,
          column: baseline.identity.cursorX,
          cols: baseline.identity.cols,
          rows: baseline.identity.rows,
          grapheme: baseline.cells[baseline.identity.cursorY][baseline.identity.cursorX],
        },
      };
    },
    observe(ordinal, match) {
      assert(
        ordinal >= 0 &&
          ordinal < payloads.length &&
          evidence.attempts[ordinal].status === "not-observed",
      );
      assert(
        evidence.attempts.slice(0, ordinal).every((entry) => entry.status === "observed"),
        "Missing intermediate observation",
      );
      observe(ordinal, match);
    },
    finish() {
      assert(
        evidence.attempts.every((entry) => entry.status === "observed"),
        "Incomplete output observations",
      );
      evidence.status = "complete";
      save();
      return {
        path,
        status: "complete",
        observed: evidence.attempts.length,
        scope: evidence.scope,
        schedule: evidence.schedule,
        terminalOutputTiming: "not-measured",
      };
    },
  };
}
