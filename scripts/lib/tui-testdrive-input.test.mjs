import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_PASTE_BYTES,
  TESTDRIVE_INPUT_REPORTING_GRACE_MS,
  assessClipboardAutoBufferDelta,
  buildClipboardPaneHookCommand,
  clipboardCallbackStageOutcomeExact,
  enforceClipboardCallbackCap,
  deliverExactHostBytes,
  exactPtyPasteBufferArgs,
  executeTestdriveInputOperation,
  fullTerminalCapabilities,
  parseTestdriveInputDocument,
  parseTestdriveInputFailureObservation,
  parseClipboardAutoBufferInventory,
  parseClipboardCallbackState,
  readClipboardAutoBufferInventoryTransaction,
  readClipboardAutoBufferInventoryTransactionAsync,
  reapOwnedClipboardCallback,
  proveRendererSelectionStyleDelta,
  settleClipboardObservationAfterRetirement,
  translateTestdriveInput,
  testdriveInputSupervisorTimeout,
  validateClipboardObservationEvents,
  watchClipboardCallbackAbort,
  waitForClipboardObservation,
} from "./tui-testdrive-input.mjs";
import {
  acquireClipboardPaneHook,
  retireClipboardPaneHook,
} from "./tui-testdrive-clipboard-hook.mjs";

const context = {
  capabilities: fullTerminalCapabilities(),
  geometry: { cols: 80, rows: 24 },
};

test("outer input supervision adds only fixed reporting grace", () => {
  assert.equal(TESTDRIVE_INPUT_REPORTING_GRACE_MS, 500);
  assert.equal(testdriveInputSupervisorTimeout(3_000), 3_500);
  for (const malformed of [null, 0, 49, 5_001, 3_000.5]) {
    assert.throws(() => testdriveInputSupervisorTimeout(malformed));
  }
});

test("translates one key through the exact host PTY without paste framing", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "key", key: "x" }),
  );
  assert.deepEqual(translateTestdriveInput(command, context), {
    phases: [{ bytes: "x", delayMs: 0 }],
  });
  assert.throws(
    () => parseTestdriveInputDocument(JSON.stringify({ version: 1, kind: "key", key: "xx" })),
    /one printable ASCII/u,
  );
});

test("translates one strict control key through the exact host PTY", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "control-key", key: "t" }),
  );
  assert.deepEqual(translateTestdriveInput(command, context), {
    phases: [{ bytes: "\x14", delayMs: 0 }],
  });
  for (const key of ["T", "tt", "1"]) {
    assert.throws(
      () => parseTestdriveInputDocument(JSON.stringify({ version: 1, kind: "control-key", key })),
      /lowercase ASCII letter/u,
    );
  }
});

test("translates bracketed paste through one exact OpenTUI input sequence", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "paste", text: "alpha\nbeta" }),
  );
  assert.deepEqual(translateTestdriveInput(command, context), {
    phases: [{ bytes: "\x1b[200~alpha\nbeta\x1b[201~", delayMs: 0 }],
  });
});

test("exact PTY delivery disables tmux byte rewriting and pins the host pane", () => {
  assert.deepEqual(exactPtyPasteBufferArgs("testdrive-input-12-acde", "%7"), [
    "paste-buffer",
    "-d",
    "-r",
    "-S",
    "-b",
    "testdrive-input-12-acde",
    "-t",
    "%7",
  ]);
  assert.throws(() => exactPtyPasteBufferArgs("other-buffer", "%7"), /buffer name/);
  assert.throws(
    () => exactPtyPasteBufferArgs("testdrive-input-12-acde", "=_tmux-ide-testdrive:0.0"),
    /host pane target/,
  );
});

test("exact delivery cleans the buffer once when paste fails after a successful load", () => {
  let now = 0;
  const calls = [];
  assert.throws(
    () =>
      deliverExactHostBytes({
        identity: { paneId: "%7" },
        bytes: "\x1b[I",
        timeoutMs: 100,
        bufferName: "testdrive-input-12-acde",
        clock: { now: () => now },
        runTmux: (args, options) => {
          calls.push([args, options]);
          now += 10;
          if (args[0] === "delete-buffer") return "";
          const error = new Error("paste failed");
          error.stdout = "TMUX_IDE_TESTDRIVE_BUFFER_LOADED\n";
          throw error;
        },
      }),
    /paste failed/,
  );
  assert.deepEqual(
    calls.map(([args]) => args[0]),
    ["load-buffer", "delete-buffer"],
  );
  assert.ok(calls[0][0].includes("paste-buffer"));
  assert.ok(calls[1][1].timeout <= 100);
});

test("successful paste self-deletes atomically and does not depend on fallback cleanup", () => {
  const calls = [];
  assert.doesNotThrow(() =>
    deliverExactHostBytes({
      identity: { paneId: "%7" },
      bytes: "ok",
      timeoutMs: 100,
      bufferName: "testdrive-input-12-acde",
      clock: { now: () => 0 },
      runTmux: (args) => {
        calls.push(args);
        return "TMUX_IDE_TESTDRIVE_BUFFER_LOADED\n";
      },
    }),
  );
  assert.ok(calls[0].includes("-d"));
  assert.deepEqual(calls[0].slice(0, 10), [
    "load-buffer",
    "-b",
    "testdrive-input-12-acde",
    "-",
    ";",
    "display-message",
    "-p",
    "TMUX_IDE_TESTDRIVE_BUFFER_LOADED",
    ";",
    "paste-buffer",
  ]);
  assert.deepEqual(
    calls.map(([command]) => command),
    ["load-buffer"],
  );
});

test("timed out marked delivery performs one owned cleanup while an unmarked timeout performs none", () => {
  for (const [stdout, expected] of [
    ["TMUX_IDE_TESTDRIVE_BUFFER_LOADED\n", ["load-buffer", "delete-buffer"]],
    ["", ["load-buffer"]],
  ]) {
    const calls = [];
    assert.throws(
      () =>
        deliverExactHostBytes({
          identity: { paneId: "%7" },
          bytes: "timeout",
          timeoutMs: 100,
          bufferName: "testdrive-input-12-acde",
          clock: { now: () => 0 },
          runTmux: (args) => {
            calls.push(args);
            if (args[0] === "delete-buffer") return "";
            const error = new Error("transaction timed out");
            error.code = "ETIMEDOUT";
            error.stdout = stdout;
            throw error;
          },
        }),
      (error) => {
        assert.match(error.message, /timed out/u);
        assert.equal(error.deliveryEvidence.effectOccurred, stdout === "" ? false : null);
        return true;
      },
    );
    assert.deepEqual(
      calls.map(([command]) => command),
      expected,
    );
  }
});

test("failed load never attempts cleanup for a buffer it did not acquire", () => {
  const calls = [];
  assert.throws(
    () =>
      deliverExactHostBytes({
        identity: { paneId: "%7" },
        bytes: "no-load",
        timeoutMs: 100,
        bufferName: "testdrive-input-12-acde",
        clock: { now: () => 0 },
        runTmux: (args) => {
          calls.push(args);
          throw new Error("load failed");
        },
      }),
    /load failed/u,
  );
  assert.deepEqual(
    calls.map(([command]) => command),
    ["load-buffer"],
  );
});

test("five successful selection transports avoid the former redundant cleanup margin", () => {
  let now = 0;
  let calls = 0;
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    deliverExactHostBytes({
      identity: { paneId: "%7" },
      bytes: `phase-${ordinal}`,
      timeoutMs: 3_000,
      bufferName: `testdrive-input-12-acde-${ordinal}`,
      clock: { now: () => now },
      runTmux: () => {
        calls += 1;
        now += 100;
        return "TMUX_IDE_TESTDRIVE_BUFFER_LOADED\n";
      },
    });
  }
  assert.equal(calls, 5);
  assert.equal(now, 500);
  assert.equal(3_000 - now >= 650, true);
});

test("clipboard callback retirement uses only its authenticated cooperative channel", async () => {
  let now = 0;
  let active = true;
  let acknowledged = false;
  let abortRequests = 0;
  const result = await reapOwnedClipboardCallback({
    isActive: () => active,
    requestAbort: async () => {
      abortRequests += 1;
    },
    isAcknowledged: () => acknowledged,
    sleep: async (milliseconds) => {
      now += milliseconds;
      acknowledged = true;
      active = false;
    },
    clock: { now: () => now },
    timeoutMs: 100,
  });
  assert.equal(abortRequests, 1);
  assert.deepEqual(result, {
    callbackRetirementStage: "abort-ack",
    callbackRetirementElapsedMs: 10,
    callbackWorkSettled: true,
    callbackLeaseInactive: true,
  });
});

test("clipboard callback retirement records natural exit without issuing an abort", async () => {
  let requested = false;
  const osProcessStillRunning = true;
  const alreadyExited = await reapOwnedClipboardCallback({
    isActive: () => false,
    requestAbort: async () => {
      requested = true;
    },
    isAcknowledged: () => false,
    sleep: async () => {},
    clock: { now: () => 0 },
    timeoutMs: 100,
  });
  assert.deepEqual(alreadyExited, {
    callbackRetirementStage: "already-exited",
    callbackRetirementElapsedMs: 0,
    callbackWorkSettled: true,
    callbackLeaseInactive: true,
  });
  assert.equal(requested, false);
  assert.equal(osProcessStillRunning, true);
  assert.equal("callbackProcessAbsent" in alreadyExited, false);
});

test("clipboard callback retirement fails closed without signaling a stale or reused pid", async () => {
  let now = 0;
  let abortRequests = 0;
  let processSignals = 0;
  await assert.rejects(
    reapOwnedClipboardCallback({
      isActive: () => true,
      requestAbort: async () => {
        abortRequests += 1;
      },
      isAcknowledged: () => false,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      clock: { now: () => now },
      timeoutMs: 100,
    }),
    (error) =>
      error.clipboardCallbackRetirement?.callbackRetirementStage === "failed" &&
      error.clipboardCallbackRetirement.callbackWorkSettled === false &&
      error.clipboardCallbackRetirement.callbackLeaseInactive === false,
  );
  assert.equal(abortRequests, 1);
  assert.equal(processSignals, 0);
});

test("clipboard callback retirement rejects a wrong control token without process signaling", async () => {
  let processSignals = 0;
  await assert.rejects(
    reapOwnedClipboardCallback({
      isActive: () => {
        throw new Error("control token mismatch");
      },
      requestAbort: async () => assert.fail("wrong identity must not receive an abort request"),
      isAcknowledged: () => false,
      sleep: async () => {},
      clock: { now: () => 0 },
      timeoutMs: 100,
    }),
    (error) =>
      error.clipboardCallbackRetirement?.callbackWorkSettled === false &&
      error.clipboardCallbackRetirement?.callbackLeaseInactive === false,
  );
  assert.equal(processSignals, 0);
});

test("authenticated callback abort reaches hung work while wrong tokens cannot abort it", async () => {
  const token = "12345678-1234-4234-8234-123456789abc";
  let request = null;
  let aborted = 0;
  let settled = false;
  const watcher = watchClipboardCallbackAbort({
    controlToken: token,
    readRequest: () => request,
    abort: () => {
      aborted += 1;
      settled = true;
    },
    isSettled: () => settled,
    sleep: async () => {
      request = { version: 1, kind: "abort", controlToken: token };
    },
  });
  assert.equal(await watcher, true);
  assert.equal(aborted, 1);

  await assert.rejects(
    watchClipboardCallbackAbort({
      controlToken: token,
      readRequest: () => ({
        version: 1,
        kind: "abort",
        controlToken: "87654321-1234-4234-8234-123456789abc",
      }),
      abort: () => {
        aborted += 1;
      },
      isSettled: () => false,
      sleep: async () => {},
    }),
    /identity is malformed/u,
  );
  assert.equal(aborted, 1);
});

test("translates host focus and blur reports", () => {
  for (const [state, bytes] of [
    ["focus", "\x1b[I"],
    ["blur", "\x1b[O"],
  ]) {
    const command = parseTestdriveInputDocument(
      JSON.stringify({ version: 1, kind: "focus", state }),
    );
    assert.equal(translateTestdriveInput(command, context).phases[0].bytes, bytes);
  }
});

test("application mouse is a distinct exact SGR click with modifiers", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "application-mouse",
      action: "click",
      x: 4,
      y: 2,
      button: "right",
      modifiers: ["shift", "ctrl"],
    }),
  );
  assert.deepEqual(
    translateTestdriveInput(command, context).phases.map((phase) => phase.bytes),
    ["\x1b[<22;5;3M", "\x1b[<22;5;3m"],
  );
});

test("selection drag includes press, bounded interpolation, and exact release geometry", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 7, y: 5 },
      contentRect: { x: 0, y: 0, width: 80, height: 24 },
    }),
  );
  const phases = translateTestdriveInput(command, context).phases;
  assert.equal(phases[0].bytes, "\x1b[<0;3;4M");
  assert.equal(phases.at(-1).bytes, "\x1b[<0;8;6m");
  assert.ok(phases.slice(1, -1).every((phase) => phase.bytes.startsWith("\x1b[<32;")));
  assert.ok(phases.length <= 26);
});

test("copy capture translates to Ctrl-C and requires real clipboard evidence", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 400 }),
  );
  assert.deepEqual(translateTestdriveInput(command, context), {
    phases: [{ bytes: "\x03", delayMs: 0 }],
    captureClipboard: true,
  });
  assert.equal(command.timeoutMs, 400);
});

test("strict parsing rejects unknown fields, bad timeouts, and oversized paste", () => {
  assert.throws(
    () =>
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "focus", state: "focus", extra: true }),
      ),
    /unknown field/,
  );
  assert.throws(
    () =>
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "focus", state: "focus", timeoutMs: 5 }),
      ),
    /timeoutMs/,
  );
  assert.throws(
    () =>
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "paste", text: "x".repeat(MAX_PASTE_BYTES + 1) }),
      ),
    /paste text/,
  );
});

test("geometry is fail-closed at the live host boundary", () => {
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "application-mouse",
      action: "down",
      x: 80,
      y: 0,
    }),
  );
  assert.throws(() => translateTestdriveInput(command, context), /outside host geometry 80x24/);
  assert.throws(
    () => translateTestdriveInput(command, { ...context, geometry: null }),
    /geometry is unavailable/,
  );
});

test("unsupported terminal capabilities fail without emitting input", () => {
  const cases = [
    [{ version: 1, kind: "paste", text: "x" }, "bracketed paste"],
    [{ version: 1, kind: "focus", state: "blur" }, "host focus events"],
    [
      { version: 1, kind: "application-mouse", action: "move", x: 0, y: 0 },
      "SGR application mouse events",
    ],
    [{ version: 1, kind: "copy-capture" }, "clipboard capture"],
  ];
  for (const [document, expected] of cases) {
    const command = parseTestdriveInputDocument(JSON.stringify(document));
    assert.throws(
      () =>
        translateTestdriveInput(command, {
          geometry: context.geometry,
          capabilities: {},
        }),
      new RegExp(expected),
    );
  }
});

function orchestrationPort(overrides = {}) {
  let now = 10;
  const calls = [];
  const identity = { paneId: "%7", sessionId: "$3", cols: 80, rows: 24 };
  const port = {
    clock: { now: () => now },
    sleep: async (milliseconds) => {
      calls.push(["sleep", milliseconds]);
      now += milliseconds;
    },
    nonce: () => "12345678-1234-1234-1234-123456789abc",
    resolveIdentity: async (timeout) => {
      calls.push(["resolve", timeout]);
      return identity;
    },
    verifyIdentity: async (received, timeout) => {
      calls.push(["verify", received.paneId, timeout]);
    },
    capabilities: async () => fullTerminalCapabilities(),
    inject: async (received, bytes, timeout) => {
      calls.push(["inject", received.paneId, bytes, timeout]);
      return {
        physicalCalls: 1,
        transportAttempted: true,
        effectOccurred: true,
        loadMarkerAcquired: true,
        cleanupAttempted: false,
      };
    },
    captureAnsi: async () => "",
    waitForFrame: async () => "select text: drag to copy",
    armClipboard: async () => ({
      wait: async () => ({ bytes: 4, sha256: "a".repeat(64) }),
      dispose: async (timeout) => calls.push(["dispose", timeout]),
    }),
    ...overrides,
  };
  if (overrides.inject) {
    const injected = port.inject;
    port.inject = async (...args) => ({
      physicalCalls: 1,
      transportAttempted: true,
      effectOccurred: true,
      loadMarkerAcquired: true,
      cleanupAttempted: false,
      ...((await injected(...args)) ?? {}),
    });
  }
  return { port, calls, advance: (milliseconds) => (now += milliseconds) };
}

test("orchestration pins identity, uses one deadline, and verifies after delivery", async () => {
  const harness = orchestrationPort();
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "focus", state: "blur", timeoutMs: 500 }),
  );
  const result = await executeTestdriveInputOperation(command, harness.port);
  assert.equal(result.target, "%7");
  assert.equal(result.sessionId, "$3");
  assert.equal(result.requestedState, "blur");
  assert.deepEqual(
    harness.calls.filter(([kind]) => kind === "verify").map((call) => call[1]),
    ["%7", "%7"],
  );
  assert.deepEqual(harness.calls.find(([kind]) => kind === "inject").slice(1, 3), ["%7", "\x1b[O"]);
});

test("control-key receipt preserves the exact requested key", async () => {
  const harness = orchestrationPort();
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "control-key", key: "t", timeoutMs: 500 }),
  );
  const result = await executeTestdriveInputOperation(command, harness.port);
  assert.equal(result.requestedKey, "t");
  assert.deepEqual(
    harness.calls.filter(([kind]) => kind === "inject").map((call) => call[2]),
    ["\x14"],
  );
});

test("modified Meta+Arrow and application drag preserve exact requested input", async () => {
  const keyboard = orchestrationPort();
  const modified = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "modified-key",
      key: "right",
      modifiers: ["meta"],
      timeoutMs: 500,
    }),
  );
  const keyboardResult = await executeTestdriveInputOperation(modified, keyboard.port);
  assert.equal(keyboardResult.requestedKey, "right");
  assert.deepEqual(keyboardResult.requestedModifiers, ["meta"]);
  assert.equal(keyboard.calls.find(([kind]) => kind === "inject")[2], "\x1b[1;3C");

  const pointer = orchestrationPort();
  const drag = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "application-mouse",
      action: "drag",
      x: 40,
      y: 10,
      timeoutMs: 500,
    }),
  );
  const pointerResult = await executeTestdriveInputOperation(drag, pointer.port);
  assert.equal(pointerResult.requestedAction, "drag");
  assert.deepEqual(pointerResult.requestedPoint, { x: 40, y: 10 });
  assert.equal(pointerResult.requestedButton, "left");
  assert.deepEqual(pointerResult.requestedModifiers, []);
  assert.equal(pointer.calls.find(([kind]) => kind === "inject")[2], "\x1b[<32;41;11M");
});

test("one monotonic absolute deadline includes resolve, phases, and cleanup reserve", async () => {
  const harness = orchestrationPort({
    resolveIdentity: async () => {
      harness.advance(430);
      return { paneId: "%7", sessionId: "$3", cols: 80, rows: 24 };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "focus", state: "focus", timeoutMs: 500 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), /absolute deadline/);
  assert.equal(
    harness.calls.some(([kind]) => kind === "inject"),
    false,
  );
});

test("copy arms exact observation before Ctrl-C and always disposes it", async () => {
  const harness = orchestrationPort({
    armClipboard: async (identity, nonce, timeout) => {
      harness.calls.push(["arm", identity.paneId, nonce, timeout]);
      return {
        wait: async () => ({
          bytes: 9,
          sha256: "b".repeat(64),
          artifactId: "buffer9",
          bufferName: "buffer9",
          nonce,
          path: "/private/runtime/buffer9.json",
          priorCopyCount: 1,
          newCopyCount: 2,
          identityExact: true,
        }),
        dispose: async (remaining) => harness.calls.push(["dispose", remaining]),
        evidence: () => ({
          candidateAttempts: 2,
          occupiedCount: 1,
          retirementExact: true,
          retirementStage: "complete",
          retirementElapsedMs: 20,
          finalOwnerAbsent: true,
          finalHookAbsent: true,
          callbackInvocations: 1,
          callbackStage: "artifact-published",
          callbackOutcome: "published",
          callbackInventoryPolls: 1,
        }),
      };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 500 }),
  );
  const result = await executeTestdriveInputOperation(command, harness.port);
  assert.ok(
    harness.calls.findIndex(([kind]) => kind === "arm") <
      harness.calls.findIndex(([kind]) => kind === "inject"),
  );
  assert.deepEqual(result.clipboard, { bytes: 9, sha256: "b".repeat(64) });
  assert.equal("text" in result.clipboard, false);
  assert.equal("base64" in result.clipboard, false);
  assert.equal("artifactId" in result.clipboard, false);
  assert.equal("bufferName" in result.clipboard, false);
  assert.equal("nonce" in result.clipboard, false);
  assert.equal("path" in result.clipboard, false);
  assert.deepEqual(result.clipboardObservation, {
    candidateAttempts: 2,
    occupiedCount: 1,
    retirementExact: true,
    retirementStage: "complete",
    retirementElapsedMs: 20,
    finalOwnerAbsent: true,
    finalHookAbsent: true,
    callbackInvocations: 1,
    callbackStage: "artifact-published",
    callbackOutcome: "published",
    callbackInventoryPolls: 1,
    callbackHookElapsedMs: null,
    callbackHookEntryLagMs: null,
    callbackInventorySeenElapsedMs: null,
    callbackArtifactPublishedElapsedMs: null,
    callbackPreSaveElapsedMs: null,
    callbackSaveElapsedMs: null,
    callbackSaveOutcome: "not-started",
    callbackRetirementStage: "not-started",
    callbackRetirementElapsedMs: 0,
    callbackWorkSettled: false,
    callbackLeaseInactive: false,
    artifactObservedElapsedMs: null,
    duplicateSettleElapsedMs: null,
    callbackLastScanElapsedMs: null,
    clipboardArmElapsedMs: 0,
    clipboardArmStartedElapsedMs: 0,
    clipboardArmBudgetAtStartMs: 259,
    clipboardArmRawRemainingAtStartMs: 500,
    clipboardReleaseElapsedMs: 0,
    clipboardWaitStartedElapsedMs: 0,
    clipboardReleaseBudgetAtStartMs: 33,
    clipboardReleaseIdentityElapsedMs: 0,
    clipboardReleaseTransportAttempted: true,
    clipboardReleaseEffectOccurred: true,
    clipboardReleaseLoadMarkerAcquired: true,
    clipboardReleaseCleanupAttempted: false,
    priorCopyCount: 1,
    newCopyCount: 2,
    identityExact: true,
  });
  assert.equal(harness.calls.at(-1)[0], "dispose");
});

test("copy-capture retains its exact release slice after an r1-shaped arm", async () => {
  let verifies = 0;
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 1) harness.advance(792);
    },
    armClipboard: async (_identity, _nonce, timeout) => {
      assert.equal(timeout, 900);
      harness.advance(900);
      return {
        wait: async () => ({ bytes: 9, sha256: "b".repeat(64) }),
        dispose: async () => {},
      };
    },
    inject: async () => {
      harness.advance(100);
      return {
        physicalCalls: 1,
        transportAttempted: true,
        effectOccurred: true,
        loadMarkerAcquired: true,
        cleanupAttempted: false,
      };
    },
  });
  const result = await executeTestdriveInputOperation(
    parseTestdriveInputDocument(
      JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
    ),
    harness.port,
  );
  assert.equal(result.clipboardObservation.clipboardArmElapsedMs, 1_692);
  assert.equal(result.clipboardObservation.clipboardArmBudgetAtStartMs, 900);
  assert.equal(result.clipboardObservation.clipboardArmRawRemainingAtStartMs, 2_208);
  assert.equal(result.clipboardObservation.clipboardReleaseBudgetAtStartMs, 200);
  assert.equal(result.clipboardObservation.clipboardReleaseLoadMarkerAcquired, true);
  assert.equal(result.transportCalls, 1);
});

test("copy-capture allocates the live-shaped available arm slice without borrowing reserves", async () => {
  let verifies = 0;
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 1) harness.advance(1_079);
    },
    armClipboard: async (_identity, _nonce, timeout, cleanupTimeout) => {
      assert.equal(timeout, 671);
      assert.equal(cleanupTimeout, 650);
      harness.advance(671);
      return {
        wait: async () => ({ bytes: 9, sha256: "b".repeat(64) }),
        dispose: async () => {},
      };
    },
  });
  const result = await executeTestdriveInputOperation(
    parseTestdriveInputDocument(
      JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
    ),
    harness.port,
  );
  assert.equal(result.clipboardObservation.clipboardArmBudgetAtStartMs, 671);
  assert.equal(result.clipboardObservation.clipboardArmRawRemainingAtStartMs, 1_921);
  assert.equal(result.clipboardObservation.clipboardArmStartedElapsedMs, 1_079);
  assert.equal(result.clipboardObservation.clipboardArmElapsedMs, 1_750);
  assert.equal(result.clipboardObservation.clipboardReleaseBudgetAtStartMs, 200);
  assert.equal(result.clipboardObservation.clipboardReleaseEffectOccurred, true);
});

test("an arm that exceeds its live-shaped allocation retires without release", async () => {
  let verifies = 0;
  let disposed = 0;
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 1) harness.advance(1_079);
    },
    armClipboard: async (_identity, _nonce, timeout, cleanupTimeout) => {
      assert.equal(timeout, 671);
      assert.equal(cleanupTimeout, 650);
      harness.advance(672);
      return {
        wait: async () => null,
        dispose: async () => (disposed += 1),
      };
    },
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "clipboard-arm");
      assert.equal(error.observation.clipboardArmBudgetAtStartMs, 671);
      assert.equal(error.observation.clipboardArmRawRemainingAtStartMs, 1_921);
      assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
      assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
      return true;
    },
  );
  assert.equal(disposed, 1);
  assert.equal(
    harness.calls.some(([kind]) => kind === "inject"),
    false,
  );
});

test("copy-capture refuses pre-arm work when less than the minimum arm slice remains", async () => {
  let armed = false;
  const harness = orchestrationPort({
    verifyIdentity: async () => harness.advance(1_661),
    armClipboard: async () => {
      armed = true;
      throw new Error("must not arm");
    },
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "pre-release-budget");
      assert.equal(error.observation.completedTransportCalls, 0);
      assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
      assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
      return true;
    },
  );
  assert.equal(armed, false);
  assert.equal(
    harness.calls.some(([kind]) => kind === "inject"),
    false,
  );
});

test("copy-capture retires an arm that crosses its cap without Ctrl-C", async () => {
  let disposed = 0;
  const harness = orchestrationPort({
    armClipboard: async () => {
      harness.advance(901);
      return { wait: async () => null, dispose: async () => (disposed += 1) };
    },
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "clipboard-arm");
      assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
      assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
      return true;
    },
  );
  assert.equal(disposed, 1);
  assert.equal(
    harness.calls.some(([kind]) => kind === "inject"),
    false,
  );
});

test("copy-capture release identity and marked timeout fail before credit", async () => {
  let verifies = 0;
  let disposed = 0;
  const identityHarness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 2) throw new Error("host pane identity changed before Ctrl-C");
    },
    armClipboard: async () => ({
      wait: async () => null,
      dispose: async () => (disposed += 1),
    }),
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, identityHarness.port), (error) => {
    assert.equal(error.observation.substage, "release-identity");
    assert.equal(error.observation.completedTransportCalls, 0);
    assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
    assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
    return true;
  });
  assert.equal(disposed, 1);

  const timeoutHarness = orchestrationPort({
    inject: async () => {
      const error = new Error("tmux delivery timed out");
      error.code = "ETIMEDOUT";
      error.deliveryEvidence = {
        transportAttempted: true,
        effectOccurred: null,
        loadMarkerAcquired: true,
        cleanupAttempted: true,
      };
      throw error;
    },
  });
  await assert.rejects(executeTestdriveInputOperation(command, timeoutHarness.port), (error) => {
    assert.equal(error.observation.substage, "input-delivery");
    assert.equal(error.observation.completedTransportCalls, 0);
    assert.equal(error.observation.clipboardReleaseTransportAttempted, true);
    assert.equal(error.observation.clipboardReleaseEffectOccurred, null);
    assert.equal(error.observation.clipboardReleaseLoadMarkerAcquired, true);
    assert.equal(error.observation.clipboardReleaseCleanupAttempted, true);
    return true;
  });
});

test("clipboard work starts callback observation with exact post-input identity", async () => {
  let verifies = 0;
  const harness = orchestrationPort({
    verifyIdentity: async (identity, timeout) => {
      verifies += 1;
      harness.calls.push(["verify", identity.paneId, timeout]);
      harness.advance(verifies === 1 ? 65 : 100);
    },
    inject: async (identity, bytes, timeout) => {
      harness.calls.push(["inject", identity.paneId, bytes, timeout]);
      harness.advance(100);
    },
    armClipboard: async () => {
      harness.advance(850);
      return {
        wait: async (timeout) => {
          harness.calls.push(["clipboard-wait", timeout]);
          harness.advance(1_030);
          return { bytes: 9, sha256: "b".repeat(64) };
        },
        dispose: async (timeout) => harness.calls.push(["dispose", timeout]),
      };
    },
  });
  const result = await executeTestdriveInputOperation(
    parseTestdriveInputDocument(
      JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
    ),
    harness.port,
  );
  const inject = harness.calls.findLastIndex(([kind]) => kind === "inject");
  const postInputIdentity = harness.calls.findLastIndex(([kind]) => kind === "verify");
  const clipboardWait = harness.calls.findIndex(([kind]) => kind === "clipboard-wait");
  assert.ok(inject < postInputIdentity && inject < clipboardWait);
  assert.ok(harness.calls[postInputIdentity][2] <= 200);
  assert.equal(result.elapsedMs, 2_245);
});

test("post-input identity timeout runs alongside clipboard wait and still retires exactly", async () => {
  let verifies = 0;
  let waited = false;
  let retired = false;
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 3) {
        const error = new Error("host identity command timed out");
        error.code = "ETIMEDOUT";
        throw error;
      }
    },
    armClipboard: async () => ({
      wait: async () => {
        waited = true;
      },
      dispose: async () => {
        retired = true;
      },
    }),
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "post-input-identity");
      assert.equal(error.observation.cause, "timeout");
      return true;
    },
  );
  assert.equal(waited, true);
  assert.equal(retired, true);
});

test("post-input replacement rejects concurrent clipboard proof and retires the lease", async () => {
  let verifies = 0;
  let waited = false;
  let retired = false;
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 3) throw new Error("host pane identity changed after input");
    },
    armClipboard: async () => ({
      wait: async () => {
        waited = true;
      },
      dispose: async () => {
        retired = true;
      },
    }),
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "post-input-identity");
      assert.equal(error.observation.cause, "identity-mismatch");
      return true;
    },
  );
  assert.equal(waited, true);
  assert.equal(retired, true);
});

test("clipboard wait failure still performs bounded observation cleanup", async () => {
  const harness = orchestrationPort({
    armClipboard: async () => ({
      wait: async () => {
        throw new Error("missing clipboard event");
      },
      dispose: async (remaining) => harness.calls.push(["dispose", remaining]),
    }),
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 500 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.match(error.message, /missing clipboard event/);
    assert.equal(error.observation.substage, "clipboard-wait");
    return true;
  });
  assert.equal(harness.calls.at(-1)[0], "dispose");
  assert.ok(harness.calls.at(-1)[1] <= 500);
});

test("clipboard arm failure reports a bounded not-invoked callback outcome", async () => {
  const harness = orchestrationPort({
    armClipboard: async () => {
      const error = new Error("clipboard hook acquisition failed");
      error.clipboardLeaseEvidence = {
        candidateAttempts: 8,
        occupiedCount: 8,
        retirementExact: false,
        retirementStage: "preflight",
        retirementElapsedMs: 10,
        finalOwnerAbsent: true,
        finalHookAbsent: true,
      };
      throw error;
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 500 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.substage, "clipboard-arm");
    assert.equal(error.observation.callbackInvocations, 0);
    assert.equal(error.observation.callbackStage, "not-invoked");
    assert.equal(error.observation.callbackOutcome, "pending");
    return true;
  });
});

test("selection and copy preserve exact arm rollback with zero release effect", async () => {
  for (const kind of ["selection-drag", "copy-capture"]) {
    let captures = 0;
    const prefix = "\n\n\n  ";
    const harness = orchestrationPort({
      captureAnsi: async () =>
        captures++ === 0
          ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
          : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
      armClipboard: async () => {
        const error = new Error("clipboard acquisition timed out after exact rollback");
        error.clipboardLeaseEvidence = {
          candidateAttempts: 1,
          occupiedCount: 0,
          retirementExact: true,
          retirementStage: "complete",
          retirementElapsedMs: 40,
          finalOwnerAbsent: true,
          finalHookAbsent: true,
        };
        throw error;
      },
    });
    const document =
      kind === "copy-capture"
        ? { version: 1, kind, timeoutMs: 3_000 }
        : {
            version: 1,
            kind,
            from: { x: 2, y: 3 },
            to: { x: 5, y: 3 },
            contentRect: { x: 2, y: 3, width: 4, height: 1 },
            timeoutMs: 3_000,
          };
    await assert.rejects(
      executeTestdriveInputOperation(
        parseTestdriveInputDocument(JSON.stringify(document)),
        harness.port,
      ),
      (error) => {
        assert.equal(error.observation.substage, "clipboard-arm");
        assert.equal(error.observation.retirementExact, true);
        assert.equal(error.observation.finalOwnerAbsent, true);
        assert.equal(error.observation.finalHookAbsent, true);
        assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
        assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
        assert.equal(error.observation.completedTransportCalls, kind === "selection-drag" ? 4 : 0);
        return true;
      },
    );
  }
});

test("clipboard retirement failure rejects an otherwise successful copy with bounded evidence", async () => {
  const harness = orchestrationPort({
    armClipboard: async () => ({
      wait: async () => ({
        bytes: 9,
        sha256: "b".repeat(64),
        priorCopyCount: 1,
        newCopyCount: 2,
        identityExact: true,
      }),
      dispose: async () => {
        throw new Error("owned clipboard hook remained installed");
      },
      evidence: () => ({
        candidateAttempts: 2,
        occupiedCount: 1,
        retirementExact: false,
        retirementStage: "mutation",
        retirementElapsedMs: 20,
        finalOwnerAbsent: true,
        finalHookAbsent: false,
        callbackInvocations: 1,
        callbackStage: "artifact-published",
        callbackOutcome: "published",
        callbackInventoryPolls: 1,
      }),
    }),
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 500 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.substage, "clipboard-retirement");
    assert.equal(error.observation.candidateAttempts, 2);
    assert.equal(error.observation.occupiedCount, 1);
    assert.equal(error.observation.retirementExact, false);
    assert.equal(error.observation.priorCopyCount, 1);
    assert.equal(error.observation.newCopyCount, 2);
    assert.equal(error.observation.clipboardIdentityExact, true);
    return true;
  });
});

test("clipboard success reserves a fixed retirement budget inside the unchanged 3000ms deadline", async () => {
  const harness = orchestrationPort({
    armClipboard: async () => {
      let retired = false;
      return {
        wait: async (timeout) => {
          assert.equal(timeout, 2_350);
          harness.advance(2_340);
          return {
            bytes: 9,
            sha256: "b".repeat(64),
            priorCopyCount: 1,
            newCopyCount: 2,
            identityExact: true,
          };
        },
        dispose: async (timeout) => {
          assert.ok(timeout >= 650 && timeout <= 660);
          harness.advance(600);
          retired = true;
        },
        evidence: () => ({
          candidateAttempts: 1,
          occupiedCount: 0,
          retirementExact: retired,
          retirementStage: retired ? "complete" : "not-started",
          retirementElapsedMs: retired ? 600 : 0,
          finalOwnerAbsent: retired,
          finalHookAbsent: retired,
          callbackInvocations: 1,
          callbackStage: "artifact-published",
          callbackOutcome: "published",
          callbackInventoryPolls: 1,
        }),
      };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
  );
  const result = await executeTestdriveInputOperation(command, harness.port);
  assert.equal(result.elapsedMs, 2_940);
  assert.equal(result.clipboardObservation.retirementExact, true);
  assert.equal(result.clipboardObservation.retirementElapsedMs, 600);
});

test("copy callback beyond the former 1500ms work edge qualifies with retirement margin", async () => {
  const harness = orchestrationPort({
    armClipboard: async () => {
      harness.advance(850);
      let retired = false;
      return {
        wait: async (timeout) => {
          assert.ok(timeout >= 1_490 && timeout <= 1_500);
          harness.advance(1_150);
          return {
            bytes: 9,
            sha256: "b".repeat(64),
            priorCopyCount: 1,
            newCopyCount: 2,
            identityExact: true,
          };
        },
        dispose: async (timeout) => {
          assert.ok(timeout >= 990 && timeout <= 1_000);
          retired = true;
        },
        evidence: () => ({
          candidateAttempts: 1,
          occupiedCount: 0,
          retirementExact: retired,
          retirementStage: retired ? "complete" : "not-started",
          retirementElapsedMs: 50,
          finalOwnerAbsent: retired,
          finalHookAbsent: retired,
          callbackInvocations: 1,
          callbackStage: "artifact-published",
          callbackOutcome: "published",
          callbackInventoryPolls: 3,
        }),
      };
    },
  });
  const result = await executeTestdriveInputOperation(
    parseTestdriveInputDocument(
      JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
    ),
    harness.port,
  );
  assert.equal(result.elapsedMs, 2_000);
  assert.equal(result.clipboardObservation.callbackStage, "artifact-published");
  assert.equal(result.clipboardObservation.retirementExact, true);
});

test("clipboard arrival beyond the work budget fails before consuming retirement reserve", async () => {
  let disposedWith = null;
  const harness = orchestrationPort({
    armClipboard: async () => ({
      wait: async (timeout) => {
        harness.advance(timeout);
        throw new Error("clipboard arrived after work deadline");
      },
      dispose: async (timeout) => {
        disposedWith = timeout;
      },
      evidence: () => ({
        candidateAttempts: 1,
        occupiedCount: 0,
        retirementExact: true,
        retirementStage: "complete",
        retirementElapsedMs: 10,
        finalOwnerAbsent: true,
        finalHookAbsent: true,
        callbackInvocations: 1,
        callbackStage: "inventory-pending",
        callbackOutcome: "pending",
        callbackInventoryPolls: 1,
      }),
    }),
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.substage, "clipboard-wait");
    return true;
  });
  assert.equal(disposedWith, 650);
});

test("an already-owned r1-shaped callback may qualify only through exact retirement-edge recovery", async () => {
  let retired = false;
  const harness = orchestrationPort({
    inject: async () => {
      harness.advance(100);
      return {
        physicalCalls: 1,
        transportAttempted: true,
        effectOccurred: true,
        loadMarkerAcquired: true,
        cleanupAttempted: false,
      };
    },
    armClipboard: async () => ({
      wait: async (timeout) => {
        return waitForClipboardObservation({
          listArtifacts: () => [],
          readEvent: () => null,
          expected: {
            nonce: "12345678-1234-1234-1234-123456789abc",
            paneId: "%7",
          },
          clock: harness.port.clock,
          sleep: harness.port.sleep,
          timeoutMs: timeout,
          quietMs: 0,
        });
      },
      dispose: async (timeout) => {
        assert.equal(timeout, 650);
        harness.advance(250);
        retired = true;
        return {
          bytes: 19,
          sha256: "d".repeat(64),
          priorCopyCount: 0,
          newCopyCount: 1,
          identityExact: true,
        };
      },
      evidence: () => ({
        candidateAttempts: 1,
        occupiedCount: 0,
        retirementExact: retired,
        retirementStage: retired ? "complete" : "not-started",
        retirementElapsedMs: retired ? 250 : 0,
        finalOwnerAbsent: retired,
        finalHookAbsent: retired,
        callbackInvocations: 1,
        callbackStage: "artifact-published",
        callbackOutcome: "published",
        callbackInventoryPolls: 1,
        callbackHookElapsedMs: 0,
        callbackHookEntryLagMs: 120,
        callbackInventorySeenElapsedMs: 68,
        callbackPreSaveElapsedMs: 69,
        callbackSaveElapsedMs: 116,
        callbackSaveOutcome: "complete",
        callbackArtifactPublishedElapsedMs: 186,
        callbackRetirementStage: "already-exited",
        callbackRetirementElapsedMs: 0,
        callbackWorkSettled: retired,
        callbackLeaseInactive: retired,
        artifactObservedElapsedMs: 2_400,
        duplicateSettleElapsedMs: 40,
        callbackLastScanElapsedMs: 2_440,
      }),
    }),
  });
  const result = await executeTestdriveInputOperation(
    parseTestdriveInputDocument(
      JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
    ),
    harness.port,
  );
  assert.equal(result.elapsedMs, 2_600);
  assert.equal(result.clipboard.bytes, 19);
  assert.equal(result.clipboardObservation.retirementExact, true);
  assert.equal(result.clipboardObservation.callbackArtifactPublishedElapsedMs, 186);
});

test("retirement-edge recovery rejects lookalike timeout prose and code", async () => {
  const harness = orchestrationPort({
    armClipboard: async () => ({
      wait: async () => {
        const error = new Error("Clipboard observation deadline elapsed");
        error.code = "TMUX_IDE_CLIPBOARD_OBSERVATION_TIMEOUT";
        throw error;
      },
      dispose: async () => ({
        bytes: 19,
        sha256: "d".repeat(64),
        priorCopyCount: 0,
        newCopyCount: 1,
        identityExact: true,
      }),
    }),
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      harness.port,
    ),
    /Clipboard observation deadline elapsed/u,
  );
});

test("selection exhausts its proof slice before release and copy", async () => {
  let verifies = 0;
  let captures = 0;
  let armed = false;
  const prefix = "\n\n\n  ";
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 8) harness.advance(1_751);
    },
    captureAnsi: async () =>
      captures++ === 0
        ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
        : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
    armClipboard: async () => {
      armed = true;
      throw new Error("must not arm");
    },
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({
          version: 1,
          kind: "selection-drag",
          from: { x: 2, y: 3 },
          to: { x: 5, y: 3 },
          contentRect: { x: 2, y: 3, width: 4, height: 1 },
          timeoutMs: 3_000,
        }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "pre-release-budget");
      assert.equal(error.observation.completedTransportCalls, 4);
      return true;
    },
  );
  assert.equal(armed, false);
  assert.equal(harness.calls.filter(([kind]) => kind === "inject").length, 4);
});

test("live-shaped selection allocates its available arm and retains the exact release slice", async () => {
  let captures = 0;
  let injections = 0;
  const prefix = "\n\n\n  ";
  const harness = orchestrationPort({
    captureAnsi: async () => {
      if (captures === 0) harness.advance(1_055);
      return captures++ === 0
        ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
        : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`;
    },
    armClipboard: async (_identity, _nonce, timeout, cleanupTimeout) => {
      assert.equal(timeout, 671);
      assert.equal(cleanupTimeout, 650);
      harness.advance(600);
      return {
        wait: async () => ({ bytes: 4, sha256: "a".repeat(64) }),
        dispose: async () => {},
      };
    },
    inject: async (identity, bytes, timeout) => {
      harness.calls.push(["inject", identity.paneId, bytes, timeout]);
      injections += 1;
      if (injections === 5) harness.advance(100);
      return {
        physicalCalls: 1,
        transportAttempted: true,
        effectOccurred: true,
        loadMarkerAcquired: true,
        cleanupAttempted: false,
      };
    },
  });
  const result = await executeTestdriveInputOperation(
    parseTestdriveInputDocument(
      JSON.stringify({
        version: 1,
        kind: "selection-drag",
        from: { x: 2, y: 3 },
        to: { x: 5, y: 3 },
        contentRect: { x: 2, y: 3, width: 4, height: 1 },
        timeoutMs: 3_000,
      }),
    ),
    harness.port,
  );
  assert.equal(result.clipboardObservation.clipboardArmStartedElapsedMs, 1_079);
  assert.equal(result.clipboardObservation.clipboardArmElapsedMs, 1_679);
  assert.equal(result.clipboardObservation.clipboardArmBudgetAtStartMs, 671);
  assert.equal(result.clipboardObservation.clipboardArmRawRemainingAtStartMs, 1_921);
  assert.equal(result.clipboardObservation.clipboardReleaseBudgetAtStartMs, 200);
  assert.equal(result.clipboardObservation.clipboardReleaseTransportAttempted, true);
  assert.equal(result.clipboardObservation.clipboardReleaseEffectOccurred, true);
  assert.equal(result.clipboardObservation.clipboardReleaseLoadMarkerAcquired, true);
  assert.equal(result.clipboardObservation.clipboardReleaseCleanupAttempted, false);
  assert.equal(result.transportCalls, 5);
});

test("an arm over its exact cap retires without releasing", async () => {
  let captures = 0;
  let disposed = 0;
  const prefix = "\n\n\n  ";
  const harness = orchestrationPort({
    captureAnsi: async () =>
      captures++ === 0
        ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
        : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
    armClipboard: async () => {
      harness.advance(901);
      return { wait: async () => null, dispose: async () => (disposed += 1) };
    },
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({
          version: 1,
          kind: "selection-drag",
          from: { x: 2, y: 3 },
          to: { x: 5, y: 3 },
          contentRect: { x: 2, y: 3, width: 4, height: 1 },
          timeoutMs: 3_000,
        }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "clipboard-arm");
      assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
      assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
      return true;
    },
  );
  assert.equal(disposed, 1);
  assert.equal(harness.calls.filter(([kind]) => kind === "inject").length, 4);
});

test("release timeout seals marker acquisition and one cleanup attempt", async () => {
  let captures = 0;
  let injections = 0;
  const prefix = "\n\n\n  ";
  const harness = orchestrationPort({
    captureAnsi: async () =>
      captures++ === 0
        ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
        : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
    inject: async (identity, bytes, timeout) => {
      harness.calls.push(["inject", identity.paneId, bytes, timeout]);
      injections += 1;
      if (injections === 5) {
        const error = new Error("tmux delivery timed out");
        error.code = "ETIMEDOUT";
        error.deliveryEvidence = {
          transportAttempted: true,
          effectOccurred: null,
          loadMarkerAcquired: true,
          cleanupAttempted: true,
        };
        throw error;
      }
      return { physicalCalls: 1 };
    },
  });
  await assert.rejects(
    executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({
          version: 1,
          kind: "selection-drag",
          from: { x: 2, y: 3 },
          to: { x: 5, y: 3 },
          contentRect: { x: 2, y: 3, width: 4, height: 1 },
          timeoutMs: 3_000,
        }),
      ),
      harness.port,
    ),
    (error) => {
      assert.equal(error.observation.substage, "selection-release");
      assert.equal(error.observation.clipboardReleaseBudgetAtStartMs, 200);
      assert.equal(error.observation.clipboardReleaseTransportAttempted, true);
      assert.equal(error.observation.clipboardReleaseEffectOccurred, null);
      assert.equal(error.observation.clipboardReleaseLoadMarkerAcquired, true);
      assert.equal(error.observation.clipboardReleaseCleanupAttempted, true);
      return true;
    },
  );
});

test("fulfilled selection and copy effects over 200ms remain uncredited", async () => {
  for (const kind of ["selection-drag", "copy-capture"]) {
    let captures = 0;
    let injections = 0;
    let retired = 0;
    const prefix = "\n\n\n  ";
    const harness = orchestrationPort({
      captureAnsi: async () =>
        captures++ === 0
          ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
          : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
      inject: async () => {
        injections += 1;
        if ((kind === "copy-capture" && injections === 1) || injections === 5) {
          harness.advance(201);
        }
        return {
          physicalCalls: 1,
          transportAttempted: true,
          effectOccurred: true,
          loadMarkerAcquired: true,
          cleanupAttempted: false,
        };
      },
      armClipboard: async () => ({
        wait: async () => null,
        dispose: async () => (retired += 1),
      }),
    });
    const document =
      kind === "selection-drag"
        ? {
            version: 1,
            kind,
            from: { x: 2, y: 3 },
            to: { x: 5, y: 3 },
            contentRect: { x: 2, y: 3, width: 4, height: 1 },
            timeoutMs: 3_000,
          }
        : { version: 1, kind, timeoutMs: 3_000 };
    await assert.rejects(
      executeTestdriveInputOperation(
        parseTestdriveInputDocument(JSON.stringify(document)),
        harness.port,
      ),
      (error) => {
        assert.equal(error.observation.clipboardReleaseTransportAttempted, true);
        assert.equal(error.observation.clipboardReleaseEffectOccurred, true);
        assert.equal(error.observation.completedTransportCalls, kind === "selection-drag" ? 4 : 0);
        assert.equal(
          error.observation.completedPhysicalTransportCalls,
          kind === "selection-drag" ? 4 : 0,
        );
        return true;
      },
    );
    assert.equal(retired, 1);
  }
});

test("fulfilled malformed release proves an effect only from its exact outcome", async () => {
  for (const [outcome, effectOccurred] of [
    [
      {
        physicalCalls: 2,
        transportAttempted: true,
        effectOccurred: true,
        loadMarkerAcquired: true,
        cleanupAttempted: false,
      },
      null,
    ],
    [
      {
        physicalCalls: 1,
        transportAttempted: true,
        effectOccurred: false,
        loadMarkerAcquired: true,
        cleanupAttempted: false,
      },
      null,
    ],
  ]) {
    const harness = orchestrationPort({ inject: async () => outcome });
    await assert.rejects(
      executeTestdriveInputOperation(
        parseTestdriveInputDocument(
          JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
        ),
        harness.port,
      ),
      (error) => {
        assert.equal(error.observation.clipboardReleaseEffectOccurred, effectOccurred);
        assert.equal(error.observation.completedTransportCalls, 0);
        assert.equal(error.observation.completedPhysicalTransportCalls, 0);
        return true;
      },
    );
  }
});

test("selection and copy preserve proven unmarked pre-load failure as no effect", async () => {
  for (const kind of ["selection-drag", "copy-capture"]) {
    let captures = 0;
    let injections = 0;
    const prefix = "\n\n\n  ";
    const harness = orchestrationPort({
      captureAnsi: async () =>
        captures++ === 0
          ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
          : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
      inject: async () => {
        injections += 1;
        if ((kind === "copy-capture" && injections === 1) || injections === 5) {
          const error = new Error("load failed before paste");
          error.deliveryEvidence = {
            transportAttempted: true,
            effectOccurred: false,
            loadMarkerAcquired: false,
            cleanupAttempted: false,
          };
          throw error;
        }
      },
    });
    const document =
      kind === "selection-drag"
        ? {
            version: 1,
            kind,
            from: { x: 2, y: 3 },
            to: { x: 5, y: 3 },
            contentRect: { x: 2, y: 3, width: 4, height: 1 },
            timeoutMs: 3_000,
          }
        : { version: 1, kind, timeoutMs: 3_000 };
    await assert.rejects(
      executeTestdriveInputOperation(
        parseTestdriveInputDocument(JSON.stringify(document)),
        harness.port,
      ),
      (error) => {
        assert.equal(error.observation.clipboardReleaseTransportAttempted, true);
        assert.equal(error.observation.clipboardReleaseEffectOccurred, false);
        assert.equal(error.observation.clipboardReleaseLoadMarkerAcquired, false);
        return true;
      },
    );
  }
});

test("postflight identity or geometry replacement fails closed", async () => {
  let verifies = 0;
  const harness = orchestrationPort({
    verifyIdentity: async () => {
      verifies += 1;
      if (verifies === 2) throw new Error("host pane identity changed");
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({ version: 1, kind: "focus", state: "focus", timeoutMs: 500 }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), /identity changed/);
  assert.equal(verifies, 2);
});

test("selection uses renderer-true tmux cell color swaps before copy release", async () => {
  let captures = 0;
  const prefix = "\n\n\n  ";
  const beforeCapture = `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`;
  const selectedCapture = `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`;
  const harness = orchestrationPort({
    captureAnsi: async () => (captures++ === 0 ? beforeCapture : selectedCapture),
    armClipboard: async () => {
      harness.calls.push(["arm"]);
      return {
        wait: async () => ({ bytes: 8, sha256: "c".repeat(64) }),
        dispose: async () => harness.calls.push(["dispose"]),
      };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 5, y: 3 },
      contentRect: { x: 2, y: 3, width: 4, height: 1 },
      timeoutMs: 800,
    }),
  );
  const result = await executeTestdriveInputOperation(command, harness.port);
  assert.deepEqual(result.requestedSelection, {
    from: { x: 2, y: 3 },
    to: { x: 5, y: 3 },
    contentRect: { x: 2, y: 3, width: 4, height: 1 },
  });
  const injected = harness.calls.filter(([kind]) => kind === "inject").map((call) => call[2]);
  assert.deepEqual(injected.slice(0, 3), ["\x1b[<2;3;4M", "\x1b[<2;3;4m", "\r"]);
  assert.ok(harness.calls.findIndex(([kind]) => kind === "arm") < harness.calls.length - 2);
  assert.equal(injected.at(-1), "\x1b[<0;6;4m");
});

test("long selection keeps exact logical input but uses constant bounded host transport", async () => {
  let captures = 0;
  const prefix = `${"\n".repeat(3)}${" ".repeat(28)}`;
  const beforeCapture = `${prefix}\x1b[38;5;1;48;5;0m${"A".repeat(25)}\x1b[0m`;
  const selectedCapture = `${prefix}\x1b[38;5;0;48;5;1m${"A".repeat(25)}\x1b[0m`;
  const harness = orchestrationPort({
    inject: async (identity, bytes, timeout) => {
      harness.calls.push(["inject", identity.paneId, bytes, timeout]);
      harness.advance(70);
    },
    captureAnsi: async () => {
      harness.calls.push(["capture"]);
      return captures++ === 0 ? beforeCapture : selectedCapture;
    },
    armClipboard: async () => {
      harness.calls.push(["arm"]);
      return {
        wait: async () => {
          harness.calls.push(["clipboard-wait"]);
          return { bytes: 25, sha256: "e".repeat(64) };
        },
        dispose: async () => harness.calls.push(["dispose"]),
      };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 28, y: 3 },
      to: { x: 52, y: 3 },
      contentRect: { x: 28, y: 3, width: 52, height: 1 },
      timeoutMs: 3_000,
    }),
  );
  const logical = translateTestdriveInput(command, context).phases;
  const result = await executeTestdriveInputOperation(command, harness.port);
  const injected = harness.calls.filter(([kind]) => kind === "inject").map((call) => call[2]);
  assert.equal(injected.length, 5);
  assert.deepEqual(injected.slice(0, 3), ["\x1b[<2;29;4M", "\x1b[<2;29;4m", "\r"]);
  assert.equal(
    injected[3],
    logical
      .slice(0, -1)
      .map(({ bytes }) => bytes)
      .join(""),
  );
  assert.equal(injected[4], logical.at(-1).bytes);
  assert.equal(result.phases, logical.length + 3);
  assert.equal(result.transportCalls, 5);
  assert.equal(
    result.bytesInjected,
    injected.reduce((total, bytes) => total + Buffer.byteLength(bytes), 0),
  );
  const secondCapture = harness.calls.findLastIndex(([kind]) => kind === "capture");
  const arm = harness.calls.findIndex(([kind]) => kind === "arm");
  const release = harness.calls.findLastIndex(([kind]) => kind === "inject");
  const postInputIdentity = harness.calls.findLastIndex(([kind]) => kind === "verify");
  const clipboardWait = harness.calls.findIndex(([kind]) => kind === "clipboard-wait");
  assert.ok(secondCapture < arm);
  assert.ok(arm < release);
  assert.ok(release < postInputIdentity && release < clipboardWait);
  assert.equal(result.selectionStyle.cells, 25);
});

test("selection failure reports bounded logical and transport progress", async () => {
  let injections = 0;
  const harness = orchestrationPort({
    inject: async (_identity, _bytes, _timeout) => {
      injections += 1;
      if (injections === 4) throw new Error("pre-release transport failed");
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 26, y: 3 },
      contentRect: { x: 2, y: 3, width: 40, height: 1 },
      timeoutMs: 800,
    }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.operation, "tui-testdrive-input");
    assert.equal(error.observation.kind, "selection-drag");
    assert.equal(error.observation.substage, "drag-pre-release");
    assert.equal(error.observation.completedPhases, 3);
    assert.equal(error.observation.totalPhases, 29);
    assert.equal(error.observation.completedTransportCalls, 3);
    assert.equal(error.observation.totalTransportCalls, 5);
    assert.equal(error.observation.completedPhysicalTransportCalls, 3);
    assert.equal(error.observation.totalPhysicalTransportCalls, 5);
    assert.equal(error.observation.clipboardReleaseTransportAttempted, false);
    assert.equal(error.observation.clipboardReleaseLoadMarkerAcquired, false);
    assert.equal(error.observation.clipboardReleaseCleanupAttempted, false);
    return true;
  });
});

test("selection failure stderr accepts one exact content-free observation only", () => {
  const exact = {
    operation: "tui-testdrive-input",
    kind: "selection-drag",
    substage: "drag-pre-release",
    completedPhases: 3,
    totalPhases: 29,
    completedTransportCalls: 3,
    totalTransportCalls: 5,
    completedPhysicalTransportCalls: 3,
    totalPhysicalTransportCalls: 5,
    cause: "operation-error",
    elapsedMs: 24,
    remainingMs: 776,
  };
  const line = `TMUX_IDE_TESTDRIVE_OBSERVATION ${JSON.stringify(exact)}\ntransport failed\n`;
  assert.deepEqual(parseTestdriveInputFailureObservation(line, "selection-drag"), exact);
  assert.equal(parseTestdriveInputFailureObservation(line, "copy-capture"), null);
  assert.equal(parseTestdriveInputFailureObservation(`${line}${line}`, "selection-drag"), null);
  assert.equal(
    parseTestdriveInputFailureObservation(
      `TMUX_IDE_TESTDRIVE_OBSERVATION ${JSON.stringify({ ...exact, raw: "secret" })}\n`,
      "selection-drag",
    ),
    null,
  );
});

test("clipboard failure stderr seals only bounded lease and copy-count evidence", () => {
  const exact = {
    operation: "tui-testdrive-input",
    kind: "copy-capture",
    substage: "clipboard-retirement",
    completedPhases: 1,
    totalPhases: 1,
    completedTransportCalls: 1,
    totalTransportCalls: 1,
    completedPhysicalTransportCalls: 1,
    totalPhysicalTransportCalls: 1,
    cause: "operation-error",
    elapsedMs: 20,
    remainingMs: 780,
    candidateAttempts: 2,
    occupiedCount: 1,
    retirementExact: false,
    retirementStage: "mutation",
    retirementElapsedMs: 20,
    finalOwnerAbsent: true,
    finalHookAbsent: false,
    callbackInvocations: 1,
    callbackStage: "artifact-published",
    callbackOutcome: "published",
    callbackInventoryPolls: 1,
    callbackHookElapsedMs: 1,
    callbackHookEntryLagMs: 5,
    callbackInventorySeenElapsedMs: 120,
    callbackPreSaveElapsedMs: 130,
    callbackSaveElapsedMs: 100,
    callbackSaveOutcome: "complete",
    callbackArtifactPublishedElapsedMs: 240,
    callbackRetirementStage: "already-exited",
    callbackRetirementElapsedMs: 0,
    callbackWorkSettled: true,
    callbackLeaseInactive: true,
    artifactObservedElapsedMs: 250,
    duplicateSettleElapsedMs: 40,
    callbackLastScanElapsedMs: 290,
    clipboardArmElapsedMs: 10,
    clipboardArmStartedElapsedMs: 5,
    clipboardArmBudgetAtStartMs: 90,
    clipboardArmRawRemainingAtStartMs: 1_340,
    clipboardReleaseElapsedMs: 15,
    clipboardWaitStartedElapsedMs: 15,
    clipboardReleaseBudgetAtStartMs: null,
    clipboardReleaseIdentityElapsedMs: null,
    clipboardReleaseTransportAttempted: false,
    clipboardReleaseEffectOccurred: false,
    clipboardReleaseLoadMarkerAcquired: false,
    clipboardReleaseCleanupAttempted: false,
    priorCopyCount: 4,
    newCopyCount: 5,
    clipboardIdentityExact: true,
  };
  const line = `TMUX_IDE_TESTDRIVE_OBSERVATION ${JSON.stringify(exact)}\n`;
  assert.deepEqual(parseTestdriveInputFailureObservation(line, "copy-capture"), exact);
  const preArm = {
    ...exact,
    substage: "pre-release-budget",
    clipboardArmElapsedMs: null,
    clipboardArmStartedElapsedMs: null,
    clipboardArmBudgetAtStartMs: null,
    clipboardArmRawRemainingAtStartMs: null,
  };
  assert.deepEqual(
    parseTestdriveInputFailureObservation(
      `TMUX_IDE_TESTDRIVE_OBSERVATION ${JSON.stringify(preArm)}\n`,
      "copy-capture",
    ),
    preArm,
  );
  const ambiguousEffect = { ...exact, clipboardReleaseEffectOccurred: null };
  assert.deepEqual(
    parseTestdriveInputFailureObservation(
      `TMUX_IDE_TESTDRIVE_OBSERVATION ${JSON.stringify(ambiguousEffect)}\n`,
      "copy-capture",
    ),
    ambiguousEffect,
  );
  for (const mutation of [
    { ...exact, candidateAttempts: 9 },
    { ...exact, callbackStage: "artifact-published", callbackOutcome: "pending" },
    { ...exact, callbackStage: "inventory-seen", callbackOutcome: "published" },
    { ...exact, callbackStage: "hook-invoked", callbackOutcome: "seen" },
    { ...exact, clipboardArmBudgetAtStartMs: 89 },
    { ...exact, clipboardArmBudgetAtStartMs: 901 },
    { ...exact, clipboardArmBudgetAtStartMs: null },
    { ...exact, clipboardArmRawRemainingAtStartMs: null },
    { ...exact, clipboardArmRawRemainingAtStartMs: 5_001 },
    { ...exact, clipboardReleaseBudgetAtStartMs: 5_001 },
    { ...exact, clipboardReleaseTransportAttempted: "true" },
    { ...exact, clipboardReleaseEffectOccurred: "unknown" },
    { ...exact, hookName: "pane-set-clipboard[7]" },
    { ...exact, command: "run-shell secret" },
  ]) {
    assert.equal(
      parseTestdriveInputFailureObservation(
        `TMUX_IDE_TESTDRIVE_OBSERVATION ${JSON.stringify(mutation)}\n`,
        "copy-capture",
      ),
      null,
    );
  }
});

test("selection replacement before release fails closed and disposes without mouse-up", async () => {
  let captures = 0;
  let armed = false;
  const prefix = "\n\n\n  ";
  const harness = orchestrationPort({
    captureAnsi: async () =>
      captures++ === 0
        ? `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`
        : `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`,
    verifyIdentity: async () => {
      if (armed) throw new Error("host pane identity changed before release");
    },
    armClipboard: async () => {
      harness.calls.push(["arm"]);
      armed = true;
      return {
        wait: async () => ({ bytes: 4, sha256: "f".repeat(64) }),
        dispose: async () => harness.calls.push(["dispose"]),
      };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 5, y: 3 },
      contentRect: { x: 2, y: 3, width: 4, height: 1 },
      timeoutMs: 800,
    }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.substage, "release-identity");
    return true;
  });
  assert.equal(harness.calls.filter(([kind]) => kind === "inject").length, 4);
  assert.equal(
    harness.calls.some(([kind]) => kind === "arm"),
    true,
  );
  assert.equal(harness.calls.at(-1)[0], "dispose");
});

test("selection deadline after the fixed drag batch fails before capture, arm, or release", async () => {
  let injections = 0;
  const harness = orchestrationPort({
    inject: async (identity, bytes, timeout) => {
      harness.calls.push(["inject", identity.paneId, bytes, timeout]);
      injections += 1;
      harness.advance(injections === 4 ? 700 : 5);
    },
    captureAnsi: async () => {
      harness.calls.push(["capture"]);
      return "";
    },
    armClipboard: async () => {
      harness.calls.push(["arm"]);
      throw new Error("clipboard must not arm");
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 26, y: 3 },
      contentRect: { x: 2, y: 3, width: 40, height: 1 },
      timeoutMs: 800,
    }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.match(error.message, /absolute deadline/u);
    assert.equal(error.observation.substage, "selection-style-wait");
    assert.equal(error.observation.completedPhases, 28);
    assert.equal(error.observation.completedTransportCalls, 4);
    return true;
  });
  assert.equal(harness.calls.filter(([kind]) => kind === "capture").length, 1);
  assert.equal(
    harness.calls.some(([kind]) => kind === "arm"),
    false,
  );
  assert.equal(harness.calls.filter(([kind]) => kind === "inject").length, 4);
});

test("selection waits for the exact delayed style frame before arming one release", async () => {
  let captures = 0;
  const prefix = "\n\n\n  ";
  const before = `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`;
  const selected = `${prefix}\x1b[38;5;0;48;5;1mABCD\x1b[0m`;
  const harness = orchestrationPort({
    captureAnsi: async () => {
      harness.calls.push(["capture"]);
      captures += 1;
      return captures < 3 ? before : selected;
    },
    armClipboard: async () => {
      harness.calls.push(["arm"]);
      return {
        wait: async () => ({ bytes: 4, sha256: "1".repeat(64) }),
        dispose: async () => harness.calls.push(["dispose"]),
      };
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 5, y: 3 },
      contentRect: { x: 2, y: 3, width: 4, height: 1 },
      timeoutMs: 800,
    }),
  );
  const result = await executeTestdriveInputOperation(command, harness.port);
  assert.equal(captures, 3);
  assert.equal(result.transportCalls, 5);
  const armIndex = harness.calls.findIndex(([kind]) => kind === "arm");
  const releaseIndex = harness.calls.findLastIndex(([kind]) => kind === "inject");
  assert.ok(harness.calls.findLastIndex(([kind]) => kind === "capture") < armIndex);
  assert.ok(armIndex < releaseIndex);
});

test("selection replacement after the badge capture prevents the pre-release batch", async () => {
  let capturedBefore = false;
  const harness = orchestrationPort({
    captureAnsi: async () => {
      harness.calls.push(["capture"]);
      capturedBefore = true;
      return "";
    },
    verifyIdentity: async () => {
      if (capturedBefore) throw new Error("host pane identity changed after badge capture");
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 5, y: 3 },
      contentRect: { x: 2, y: 3, width: 4, height: 1 },
      timeoutMs: 800,
    }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.substage, "drag-pre-release-identity");
    return true;
  });
  assert.equal(harness.calls.filter(([kind]) => kind === "inject").length, 3);
});

test("selection replacement during the style wait cancels arm and release", async () => {
  let captures = 0;
  const prefix = "\n\n\n  ";
  const before = `${prefix}\x1b[38;5;1;48;5;0mABCD\x1b[0m`;
  const harness = orchestrationPort({
    captureAnsi: async () => {
      harness.calls.push(["capture"]);
      captures += 1;
      return before;
    },
    verifyIdentity: async () => {
      if (captures === 2) throw new Error("host pane identity changed during style wait");
    },
    armClipboard: async () => {
      harness.calls.push(["arm"]);
      throw new Error("clipboard must not arm");
    },
  });
  const command = parseTestdriveInputDocument(
    JSON.stringify({
      version: 1,
      kind: "selection-drag",
      from: { x: 2, y: 3 },
      to: { x: 5, y: 3 },
      contentRect: { x: 2, y: 3, width: 4, height: 1 },
      timeoutMs: 800,
    }),
  );
  await assert.rejects(executeTestdriveInputOperation(command, harness.port), (error) => {
    assert.equal(error.observation.substage, "selection-style-wait");
    return true;
  });
  assert.equal(harness.calls.filter(([kind]) => kind === "inject").length, 4);
  assert.equal(
    harness.calls.some(([kind]) => kind === "arm"),
    false,
  );
});

test("renderer selection proof consumes tmux capture -e color encoding, never SGR 7", () => {
  const before = "\x1b[38;2;220;30;40;48;2;10;20;30mAB\x1b[0m";
  const after = "\x1b[38;2;10;20;30;48;2;220;30;40mAB\x1b[0m";
  assert.deepEqual(
    proveRendererSelectionStyleDelta(
      before,
      after,
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      {
        cols: 2,
        rows: 1,
      },
      { x: 0, y: 0, width: 2, height: 1 },
    ),
    { cells: 2, extraChangedCells: 0 },
  );
  assert.throws(
    () =>
      proveRendererSelectionStyleDelta(
        before,
        "\x1b[7mAB\x1b[0m",
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { cols: 2, rows: 1 },
        { x: 0, y: 0, width: 2, height: 1 },
      ),
    /covered 0\/2/,
  );
});

test("multi-row selection wraps only inside pane content and leaves chrome/sidebar irrelevant", () => {
  const chrome = "\x1b[38;5;7;48;5;8mCCCCCCCC";
  const side = "\x1b[38;5;6;48;5;0mSS";
  const normal = "\x1b[38;5;1;48;5;0m";
  const selected = "\x1b[38;5;0;48;5;1m";
  const outside = "\x1b[38;5;3;48;5;0mZZ";
  const before = [
    chrome,
    `${side}${normal}ABCD${outside}`,
    `${side}${normal}EFGH${outside}`,
    chrome,
  ].join("\n");
  const after = [
    chrome,
    `${side}${normal}A${selected}BCD${outside}`,
    `${side}${selected}EF${normal}GH${outside}`,
    chrome,
  ].join("\n");
  assert.deepEqual(
    proveRendererSelectionStyleDelta(
      before,
      after,
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { cols: 8, rows: 4 },
      { x: 2, y: 1, width: 4, height: 2 },
    ),
    { cells: 5, extraChangedCells: 0 },
  );
  assert.throws(
    () =>
      proveRendererSelectionStyleDelta(
        before,
        after.replace("CCCCCCCC", "\x1b[38;5;8;48;5;7mCCCCCCCC"),
        { x: 3, y: 1 },
        { x: 3, y: 2 },
        { cols: 8, rows: 4 },
        { x: 2, y: 1, width: 4, height: 2 },
      ),
    /extra changed cells/u,
  );
});

test("strict schemas reject paste termination, lone surrogates, move buttons, and point drags", () => {
  for (const document of [
    { version: 1, kind: "paste", text: `bad\x1b[201~tail` },
    { version: 1, kind: "paste", text: "\ud800" },
    { version: 1, kind: "application-mouse", action: "move", x: 1, y: 1, button: "left" },
    {
      version: 1,
      kind: "selection-drag",
      from: { x: 1, y: 1 },
      to: { x: 1, y: 1 },
      contentRect: { x: 0, y: 0, width: 5, height: 5 },
    },
  ]) {
    assert.throws(() => parseTestdriveInputDocument(JSON.stringify(document)));
  }
});

test("clipboard evidence rejects missing, multiple, unrelated, and same-size polling races", () => {
  const expected = { nonce: "op-a", paneId: "%7" };
  const event = {
    version: 1,
    nonce: "op-a",
    paneId: "%7",
    bufferName: "buffer7",
    bytes: 12,
    sha256: "d".repeat(64),
  };
  assert.deepEqual(validateClipboardObservationEvents([event], expected), {
    bytes: 12,
    sha256: "d".repeat(64),
  });
  assert.throws(() => validateClipboardObservationEvents([], expected), /Missing/);
  assert.throws(() => validateClipboardObservationEvents([event, event], expected), /Multiple/);
  assert.throws(
    () => validateClipboardObservationEvents([{ ...event, nonce: "other" }], expected),
    /unrelated/,
  );
  // A same-sized unrelated buffer cannot qualify: identity is the operation
  // nonce + pane-scoped hook event, never a before/after size comparison.
  assert.throws(
    () =>
      validateClipboardObservationEvents(
        [{ ...event, nonce: "other", bytes: event.bytes }],
        expected,
      ),
    /unrelated/,
  );
});

test("clipboard observation keeps listening through quiescence and rejects two callbacks", async () => {
  let now = 0;
  const artifacts = [];
  const events = new Map();
  const promise = waitForClipboardObservation({
    listArtifacts: () => artifacts,
    readEvent: (id) => events.get(id) ?? null,
    expected: { nonce: "op-a", paneId: "%7" },
    clock: { now: () => now },
    sleep: async (milliseconds) => {
      now += milliseconds;
      if (now === 10) {
        artifacts.push("buffer1");
        events.set("buffer1", {
          version: 1,
          nonce: "op-a",
          paneId: "%7",
          bufferName: "buffer1",
          bytes: 3,
          sha256: "e".repeat(64),
        });
      }
      if (now === 30) {
        artifacts.push("buffer2");
        events.set("buffer2", {
          version: 1,
          nonce: "op-a",
          paneId: "%7",
          bufferName: "buffer2",
          bytes: 3,
          sha256: "f".repeat(64),
        });
      }
    },
    timeoutMs: 100,
    quietMs: 40,
  });
  await assert.rejects(promise, /Multiple clipboard events/);
});

test("clipboard waiter retains an exact artifact published by the terminal deadline scan", async () => {
  let now = 0;
  const event = {
    version: 1,
    nonce: "op-edge",
    paneId: "%7",
    bufferName: "buffer9",
    bytes: 3,
    sha256: "e".repeat(64),
  };
  const result = await waitForClipboardObservation({
    listArtifacts: () => (now >= 100 ? ["buffer9"] : []),
    readEvent: () => event,
    expected: { nonce: "op-edge", paneId: "%7" },
    clock: { now: () => now },
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    timeoutMs: 100,
    quietMs: 0,
  });
  assert.deepEqual(result, {
    artifactId: "buffer9",
    clipboard: { bytes: 3, sha256: "e".repeat(64) },
  });
});

test("clipboard waiter refuses missing and wrong private artifact identities", async () => {
  let now = 0;
  await assert.rejects(
    waitForClipboardObservation({
      listArtifacts: () => [],
      readEvent: () => null,
      expected: { nonce: "op-edge", paneId: "%7" },
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 20,
      quietMs: 0,
    }),
    /Clipboard observation deadline elapsed/u,
  );
  now = 0;
  await assert.rejects(
    waitForClipboardObservation({
      listArtifacts: () => ["buffer9"],
      readEvent: () => ({
        version: 1,
        nonce: "op-edge",
        paneId: "%7",
        bufferName: "buffer8",
        bytes: 3,
        sha256: "e".repeat(64),
      }),
      expected: { nonce: "op-edge", paneId: "%7" },
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 20,
      quietMs: 0,
    }),
    /buffer identity does not match/u,
  );
});

test("clipboard deadline edge retains a private artifact id through closed-hook settlement", async () => {
  let now = 0;
  let retired = false;
  const event = {
    version: 1,
    nonce: "op-edge",
    paneId: "%7",
    bufferName: "buffer9",
    bytes: 3,
    sha256: "e".repeat(64),
  };
  const observed = await waitForClipboardObservation({
    listArtifacts: () => (now >= 100 ? ["buffer9"] : []),
    readEvent: () => event,
    expected: { nonce: "op-edge", paneId: "%7" },
    clock: { now: () => now },
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    timeoutMs: 100,
    quietMs: 0,
  });
  retired = true;
  assert.equal(
    await settleClipboardObservationAfterRetirement({
      listArtifacts: () => (retired ? ["buffer9"] : []),
      readCallbackEvidence: () => ({
        callbackInvocations: 1,
        callbackStage: "artifact-published",
        callbackOutcome: "published",
        callbackInventoryPolls: 1,
      }),
      retainedBufferName: observed.artifactId,
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 100,
    }),
    40,
  );
  assert.deepEqual(observed.clipboard, { bytes: 3, sha256: "e".repeat(64) });
  assert.equal("artifactId" in observed.clipboard, false);
  assert.equal(JSON.stringify(observed.clipboard).includes("buffer9"), false);
  await assert.rejects(
    settleClipboardObservationAfterRetirement({
      listArtifacts: () => ["buffer9"],
      readCallbackEvidence: () => ({
        callbackInvocations: 1,
        callbackStage: "artifact-published",
        callbackOutcome: "published",
        callbackInventoryPolls: 1,
      }),
      retainedBufferName: "buffer8",
      clock: { now: () => now },
      sleep: async () => {},
      timeoutMs: 100,
    }),
    /changed during post-retirement settlement/u,
  );
  await assert.rejects(
    settleClipboardObservationAfterRetirement({
      listArtifacts: () => ["buffer9"],
      readCallbackEvidence: () => ({
        callbackInvocations: 1,
        callbackStage: "artifact-published",
        callbackOutcome: "published",
        callbackInventoryPolls: 1,
      }),
      retainedBufferName: null,
      clock: { now: () => now },
      sleep: async () => {},
      timeoutMs: 100,
    }),
    /changed during post-retirement settlement/u,
  );
});

test("post-retirement settlement rejects a duplicate arriving inside the exact quiet tail", async () => {
  let now = 0;
  const callback = {
    callbackInvocations: 1,
    callbackStage: "artifact-published",
    callbackOutcome: "published",
    callbackInventoryPolls: 1,
  };
  await assert.rejects(
    settleClipboardObservationAfterRetirement({
      listArtifacts: () => (now >= 30 ? ["buffer9", "overflow"] : ["buffer9"]),
      readCallbackEvidence: () => callback,
      retainedBufferName: "buffer9",
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 100,
    }),
    /changed during post-retirement settlement/,
  );
  now = 0;
  assert.equal(
    await settleClipboardObservationAfterRetirement({
      listArtifacts: () => ["buffer9"],
      readCallbackEvidence: () => callback,
      retainedBufferName: "buffer9",
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 100,
    }),
    40,
  );
});

test("post-retirement settlement fails boundedly when the callback never reaches publication", async () => {
  let now = 0;
  await assert.rejects(
    settleClipboardObservationAfterRetirement({
      listArtifacts: () => ["buffer9"],
      readCallbackEvidence: () => ({
        callbackInvocations: 1,
        callbackStage: "inventory-seen",
        callbackOutcome: "seen",
      }),
      retainedBufferName: "buffer9",
      clock: { now: () => now },
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      timeoutMs: 20,
    }),
    /duplicate settlement exceeded its deadline/,
  );
  assert.equal(now, 20);
});

test("clipboard callback artifact accounting has a small hard cap", () => {
  assert.equal(enforceClipboardCallbackCap(["buffer1", "buffer2", "buffer2"]), 2);
  assert.throws(
    () => enforceClipboardCallbackCap(["buffer1", "buffer2", "buffer3", "buffer4", "buffer5"]),
    /callback cap exceeded/,
  );
});

test("clipboard callback milestones are exact and reject wrong or late identities", () => {
  const expected = { nonce: "op-a", paneId: "%7" };
  const state = {
    version: 1,
    nonce: "op-a",
    paneId: "%7",
    stage: "artifact-published",
    outcome: "published",
    inventoryPolls: 3,
    hookElapsedMs: 1,
    hookEntryLagMs: 5,
    inventorySeenElapsedMs: 100,
    preSaveElapsedMs: 110,
    saveElapsedMs: 80,
    saveOutcome: "complete",
    artifactPublishedElapsedMs: 200,
  };
  assert.deepEqual(parseClipboardCallbackState(state, expected), {
    callbackStage: "artifact-published",
    callbackOutcome: "published",
    callbackInventoryPolls: 3,
    callbackHookElapsedMs: 1,
    callbackHookEntryLagMs: 5,
    callbackInventorySeenElapsedMs: 100,
    callbackPreSaveElapsedMs: 110,
    callbackSaveElapsedMs: 80,
    callbackSaveOutcome: "complete",
    callbackArtifactPublishedElapsedMs: 200,
  });
  for (const malformed of [
    { ...state, stage: "not-invoked", outcome: "pending" },
    { ...state, stage: "not-invoked", outcome: "error" },
    { ...state, nonce: "retired-op" },
    { ...state, paneId: "%8" },
    { ...state, stage: "raw-hook-command" },
    { ...state, outcome: "success-ish" },
    { ...state, inventoryPolls: 2_049 },
    { ...state, hookElapsedMs: null },
    { ...state, hookEntryLagMs: null },
    { ...state, hookEntryLagMs: 5_001 },
    { ...state, inventorySeenElapsedMs: 201 },
    { ...state, artifactPublishedElapsedMs: 99 },
    { ...state, preSaveElapsedMs: 99 },
    { ...state, saveElapsedMs: 91 },
    { ...state, saveOutcome: "pending" },
    { ...state, path: "/tmp/private" },
  ]) {
    assert.throws(() => parseClipboardCallbackState(malformed, expected), /malformed|unrelated/iu);
  }
});

test("clipboard callback stage and outcome compatibility is exhaustive", () => {
  const stages = [
    "not-invoked",
    "hook-invoked",
    "inventory-pending",
    "inventory-seen",
    "save-pending",
    "artifact-published",
  ];
  const outcomes = ["pending", "seen", "published", "error"];
  const valid = new Set([
    "not-invoked:pending",
    "not-invoked:error",
    "hook-invoked:pending",
    "hook-invoked:error",
    "inventory-pending:pending",
    "inventory-pending:error",
    "inventory-seen:seen",
    "inventory-seen:error",
    "save-pending:pending",
    "save-pending:error",
    "artifact-published:published",
  ]);
  for (const stage of stages)
    for (const outcome of outcomes)
      assert.equal(
        clipboardCallbackStageOutcomeExact(stage, outcome),
        valid.has(`${stage}:${outcome}`),
        `${stage}:${outcome}`,
      );
  assert.equal(clipboardCallbackStageOutcomeExact("unknown", "pending"), false);
  assert.equal(clipboardCallbackStageOutcomeExact("hook-invoked", "unknown"), false);
});

test("clipboard automatic inventory ignores named transport buffers and proves one append", () => {
  const baseline = parseClipboardAutoBufferInventory(
    "testdrive-input-7\t99\t100\nbuffer2\t4\t90\n",
    4,
  );
  const current = parseClipboardAutoBufferInventory(
    "buffer3\t8\t110\ntestdrive-input-7\t99\t100\nbuffer2\t4\t90\n",
    4,
  );
  assert.deepEqual(assessClipboardAutoBufferDelta(baseline, baseline), { status: "pending" });
  assert.deepEqual(assessClipboardAutoBufferDelta(baseline, current), {
    status: "captured",
    buffer: { name: "buffer3", size: 8, created: "110" },
  });
});

test("clipboard automatic inventory accepts only exact oldest rotation at buffer-limit", () => {
  const baseline = parseClipboardAutoBufferInventory(
    "buffer3\t3\t30\nbuffer2\t2\t20\nbuffer1\t1\t10\n",
    3,
  );
  const rotated = parseClipboardAutoBufferInventory(
    "buffer4\t4\t40\nbuffer3\t3\t30\nbuffer2\t2\t20\n",
    3,
  );
  assert.deepEqual(assessClipboardAutoBufferDelta(baseline, rotated), {
    status: "captured",
    buffer: { name: "buffer4", size: 4, created: "40" },
  });
  for (const source of [
    "buffer3\t3\t30\nbuffer2\t2\t20\n",
    "buffer4\t4\t40\nbuffer3\t3\t30\nbuffer1\t1\t10\n",
    "buffer5\t5\t50\nbuffer4\t4\t40\nbuffer3\t3\t30\n",
    "buffer4\t4\t40\nbuffer3\t99\t30\nbuffer2\t2\t20\n",
  ]) {
    assert.throws(
      () => assessClipboardAutoBufferDelta(baseline, parseClipboardAutoBufferInventory(source, 3)),
      /ambiguously/u,
    );
  }
});

test("clipboard inventory rejects duplicates, malformed rows, and oversized limits", () => {
  for (const [source, limit] of [
    ["buffer1\t1\t10\nbuffer1\t1\t10\n", 4],
    ["buffer1\t1\n", 4],
    ["buffer1\t-1\t10\n", 4],
    ["buffer1\t1\tbad\u0007\n", 4],
    ["", 2_049],
  ]) {
    assert.throws(() => parseClipboardAutoBufferInventory(source, limit));
  }
});

test("clipboard inventory rejects limit-one rotation and identical-content concurrent additions", () => {
  for (const source of ["", "buffer1\t4\t10\n", "buffer2\t4\t20\n"]) {
    assert.throws(() => parseClipboardAutoBufferInventory(source, 1), /malformed or over cap/u);
  }
  const baseline = parseClipboardAutoBufferInventory("buffer1\t4\t10\n", 4);
  const concurrent = parseClipboardAutoBufferInventory(
    "buffer3\t8\t20\nbuffer2\t8\t20\nbuffer1\t4\t10\n",
    4,
  );
  assert.throws(() => assessClipboardAutoBufferDelta(baseline, concurrent), /changed ambiguously/u);
});

test("pane clipboard hook defers pane identity and never asks tmux for buffer_name", () => {
  const command = buildClipboardPaneHookCommand({
    nodePath: "/usr/bin/node",
    scriptPath: "/repo/scripts/tui-testdrive.mjs",
    runtimeDir: "/private/runtime",
    socketPath: "/private/t.sock",
    nonce: "12345678-1234-4234-8234-123456789abc",
    paneId: "%7",
    hookName: "pane-set-clipboard[7]",
  });
  assert.match(command, /(?<!#)#\{q:hook_pane\}/u);
  assert.doesNotMatch(command, /buffer_name/u);
  assert.doesNotMatch(command, /pane-set-clipboard\[[0-9]+\]/u);
  assert.equal(command.startsWith("run-shell "), true);
});

test("clipboard callback common path owns exactly two marked tmux transactions", () => {
  const source = readFileSync(resolve("scripts/tui-testdrive.mjs"), "utf8");
  const start = source.indexOf("async function captureClipboardObservation");
  const end = source.indexOf("function liveHostProcessPid", start);
  const callback = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.equal(
    (callback.match(/readClipboardAutoBufferInventoryTransactionAsync\(\{/gu) ?? []).length,
    2,
  );
  assert.match(callback, /\{ bufferName: captured\.name, path: capturedPayload \}/u);
  assert.match(callback, /callbackTmuxChildren/u);
  assert.match(callback, /callbackController\.signal/u);
  assert.match(source, /runBoundedChildCommand\(\{/u);
  assert.doesNotMatch(callback, /clipboardAutoBufferInventory\(/u);
});

test("clipboard disposal uses an authenticated cooperative abort and rereads final state", () => {
  const source = readFileSync(resolve("scripts/tui-testdrive.mjs"), "utf8");
  const start = source.indexOf("async function armClipboardObservation");
  const end = source.indexOf("function captureHostPane", start);
  const owner = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(owner, /controlToken: callbackControlToken/u);
  assert.match(owner, /callback-abort\.tmp/u);
  assert.match(owner, /renameSync\(abortTemporaryPath, abortPath\)/u);
  assert.match(owner, /isAcknowledged: \(\) => readControlRecord\(ackPath, "abort-ack"\)/u);
  assert.match(owner, /callbackRetirementEvidence = error\.clipboardCallbackRetirement/u);
  const reapIndex = owner.indexOf("await reapOwnedClipboardCallback({");
  const finalReadIndex = owner.lastIndexOf("readCallbackEvidence();");
  assert.ok(reapIndex > 0 && finalReadIndex > reapIndex);
  assert.doesNotMatch(owner, /process\.kill\(/u);
  assert.doesNotMatch(owner, /callbackPid/u);
  assert.match(owner, /timeoutMs, cleanupTimeoutMs/u);
  assert.match(owner, /rollbackDeadline = performance\.now\(\) \+ cleanupTimeoutMs/u);
  assert.match(owner, /cleanupRemaining: rollbackRemaining/u);
  assert.match(owner, /ensureClipboardAcquisitionRollback\(\{/u);
  assert.match(owner, /Math\.floor\(rollbackDeadline - performance\.now\(\)\)/u);
});

test("clipboard marked transactions bound latency to two subprocess calls", () => {
  let calls = 0;
  let elapsedMs = 0;
  const invocations = [];
  const runTmux = (commands, options) => {
    calls += 1;
    elapsedMs += 100;
    invocations.push({ commands, options });
    return [
      "__TMUX_IDE_CLIPBOARD_LIMIT__",
      "2",
      "__TMUX_IDE_CLIPBOARD_BUFFERS__",
      "buffer1\t19\t100",
      "__TMUX_IDE_CLIPBOARD_INVENTORY_END__",
      "",
    ].join("\n");
  };
  const current = readClipboardAutoBufferInventoryTransaction({
    runTmux,
    timeoutMs: 1_000,
  });
  const afterSave = readClipboardAutoBufferInventoryTransaction({
    runTmux,
    timeoutMs: 900,
    save: { bufferName: "buffer1", path: "/private/runtime/buffer1.bin" },
  });
  assert.equal(calls, 2);
  assert.equal(elapsedMs, 200);
  assert.deepEqual(current.inventory.buffers, afterSave.inventory.buffers);
  assert.deepEqual(
    invocations.map(({ options }) => options.timeout),
    [1_000, 900],
  );
  assert.deepEqual(invocations[1].commands.slice(0, 5), [
    "save-buffer",
    "-b",
    "buffer1",
    "/private/runtime/buffer1.bin",
    ";",
  ]);
});

test("clipboard save transaction is abortable and settles its exact child promise", async () => {
  const controller = new AbortController();
  let childSettled = false;
  const pending = readClipboardAutoBufferInventoryTransactionAsync({
    runTmux: async (_commands, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            childSettled = true;
            reject(Object.assign(new Error("aborted save"), { name: "AbortError" }));
          },
          { once: true },
        );
      }),
    timeoutMs: 500,
    save: { bufferName: "buffer1", path: "/private/capture.bin" },
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /aborted save/u);
  assert.equal(childSettled, true);
});

test("clipboard marked inventory accepts only the bounded no-buffer partial shape", () => {
  const noBuffers = new Error("no buffers");
  noBuffers.stderr = "no buffers";
  noBuffers.stdout = [
    "__TMUX_IDE_CLIPBOARD_LIMIT__",
    "2",
    "__TMUX_IDE_CLIPBOARD_BUFFERS__",
    "",
  ].join("\n");
  const result = readClipboardAutoBufferInventoryTransaction({
    runTmux: () => {
      throw noBuffers;
    },
    timeoutMs: 100,
  });
  assert.deepEqual(result.inventory.buffers, []);
  const trailing = new Error("no buffers");
  trailing.stderr = "no buffers";
  trailing.stdout = `${noBuffers.stdout}unexpected\n`;
  assert.throws(() =>
    readClipboardAutoBufferInventoryTransaction({
      runTmux: () => {
        throw trailing;
      },
      timeoutMs: 100,
    }),
  );
  assert.throws(() =>
    readClipboardAutoBufferInventoryTransaction({
      runTmux: () => noBuffers.stdout,
      timeoutMs: 100,
    }),
  );
  assert.throws(() =>
    readClipboardAutoBufferInventoryTransaction({
      runTmux: () => "x".repeat(256 * 1_024 + 1),
      timeoutMs: 100,
    }),
  );
});

test("tmux 3.7b proves OSC52 rotation and consecutive selection-drag then copy-capture", async (t) => {
  let version;
  try {
    version = execFileSync("tmux", ["-V"], { encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    t.skip("tmux is unavailable");
    return;
  }
  if (version !== "tmux 3.7b") {
    t.skip(`requires tmux 3.7b, found ${version}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "tmi-clipboard-"));
  const socket = join(root, "t.sock");
  const targetSocket = join(root, "target.sock");
  const runtimeDir = join(root, "runtime");
  const observationRoot = join(runtimeDir, "clipboard-observations");
  mkdirSync(observationRoot, { recursive: true, mode: 0o700 });
  const tmux = (args, options = {}) =>
    execFileSync("tmux", ["-S", socket, ...args], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
      ...options,
    });
  const targetTmux = (args, options = {}) =>
    execFileSync("tmux", ["-S", targetSocket, ...args], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, TMUX: "", TMUX_TMPDIR: "" },
      ...options,
    });
  const contents = [
    Buffer.from("empty baseline callback"),
    Buffer.from("first exact clipboard"),
    Buffer.from("second rotation"),
    Buffer.from("selection exact text"),
    Buffer.from("selection exact text"),
  ];
  const fixture = [
    "let index=0;",
    `const values=${JSON.stringify(contents.map((value) => value.toString("base64")))};`,
    "process.stdin.setRawMode?.(true);",
    "process.stdin.resume();",
    "process.stdin.on('data',(bytes)=>{const input=bytes.toString('latin1');if(!input.includes('\\x1b[<0;')&&!input.includes('\\x03'))return;const value=values[Math.min(index++,values.length-1)];process.stdout.write('\\x1b]52;c;'+value+'\\x07');});",
  ].join("");
  const inventorySource = () => {
    try {
      return tmux(["list-buffers", "-F", "#{buffer_name}\t#{buffer_size}\t#{buffer_created}"]);
    } catch (error) {
      if (/no buffers/iu.test(String(error?.stderr ?? error?.message ?? ""))) return "";
      throw error;
    }
  };
  const arm = (nonce) => {
    const paneId = tmux(["display-message", "-p", "-t", "=clip:0.0", "#{pane_id}"]).trim();
    const operationDir = join(observationRoot, nonce);
    mkdirSync(operationDir, { mode: 0o700 });
    const source = inventorySource();
    writeFileSync(
      join(operationDir, "lease.json"),
      `${JSON.stringify({
        version: 1,
        nonce,
        paneId,
        hookName: null,
        controlToken: "99999999-1234-4234-8234-123456789abc",
        armedAtEpochMs: Date.now(),
        inventory: parseClipboardAutoBufferInventory(source, 2),
        pollTimeoutMs: 500,
      })}\n`,
      { mode: 0o600 },
    );
    const command = buildClipboardPaneHookCommand({
      nodePath: process.execPath,
      scriptPath: resolve("scripts/tui-testdrive.mjs"),
      runtimeDir,
      socketPath: socket,
      nonce,
      paneId,
    });
    const hookLease = acquireClipboardPaneHook({
      paneId,
      ownerToken: nonce,
      command,
      runTmux: tmux,
      remaining: () => 500,
    });
    const lease = JSON.parse(readFileSync(join(operationDir, "lease.json"), "utf8"));
    writeFileSync(
      join(operationDir, "lease.json"),
      `${JSON.stringify({ ...lease, hookName: hookLease.hookName })}\n`,
    );
    return { operationDir, paneId, hookName: hookLease.hookName, hookLease };
  };
  const waitEvent = async (operationDir) => {
    for (let index = 0; index < 200; index += 1) {
      const file = readdirSync(operationDir).find((name) => /^buffer[0-9]+\.json$/u.test(name));
      if (file) return JSON.parse(readFileSync(join(operationDir, file), "utf8"));
      await delay(5);
    }
    throw new Error(
      `real tmux clipboard callback timed out (${readdirSync(operationDir).join(",")}; ${inventorySource().replaceAll("\n", "|")})`,
    );
  };
  const waitPublishedCallback = async (operationDir, expected) => {
    for (let index = 0; index < 200; index += 1) {
      const statePath = join(operationDir, "callback-state.json");
      if (existsSync(statePath)) {
        const parsed = parseClipboardCallbackState(
          JSON.parse(readFileSync(statePath, "utf8")),
          expected,
        );
        if (parsed.callbackStage === "artifact-published") return parsed;
      }
      await delay(5);
    }
    throw new Error("real tmux callback did not publish its terminal state");
  };
  let realDeliveryOrdinal = 0;
  const injectBytes = (paneId, bytes) =>
    deliverExactHostBytes({
      identity: { paneId },
      bytes,
      timeoutMs: 1_000,
      bufferName: `testdrive-input-real-${realDeliveryOrdinal++}`,
      runTmux: tmux,
      clock: performance,
    });
  const invokeObserver = ({ nonce, paneId, observedPaneId = paneId }) =>
    execFileSync(
      process.execPath,
      [resolve("scripts/tui-testdrive.mjs"), "clipboard-observe", nonce, paneId, observedPaneId],
      {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH: socket,
          TMUX_IDE_TESTDRIVE_RUNTIME_DIR: runtimeDir,
        },
      },
    );
  try {
    tmux(["new-session", "-d", "-s", "clip", process.execPath, "-e", fixture]);
    targetTmux(["new-session", "-d", "-s", "target", "tail", "-f", "/dev/null"]);
    targetTmux(["set-option", "-g", "set-clipboard", "off"]);
    tmux(["set-option", "-g", "set-clipboard", "on"]);
    tmux(["set-option", "-g", "buffer-limit", "2"]);
    const empty = arm("11111111-1234-4234-8234-123456789abc");
    injectBytes(empty.paneId, "\x03");
    const emptyEvent = await waitEvent(empty.operationDir);
    assert.equal(emptyEvent.bytes, contents[0].byteLength);
    const emptyCallback = await waitPublishedCallback(empty.operationDir, {
      nonce: "11111111-1234-4234-8234-123456789abc",
      paneId: empty.paneId,
    });
    assert.ok(emptyCallback.callbackInventorySeenElapsedMs >= emptyCallback.callbackHookElapsedMs);
    assert.ok(
      emptyCallback.callbackArtifactPublishedElapsedMs >=
        emptyCallback.callbackInventorySeenElapsedMs,
    );
    assert.equal(
      retireClipboardPaneHook({
        paneId: empty.paneId,
        lease: empty.hookLease,
        runTmux: tmux,
        remaining: () => 500,
      }).retirementExact,
      true,
    );
    tmux(["delete-buffer", "-b", emptyEvent.bufferName]);
    rmSync(empty.operationDir, { recursive: true, force: true });
    tmux(["load-buffer", "-"], { input: "preexisting" });
    tmux(["load-buffer", "-b", "testdrive-input-fixture", "-"], { input: "transport" });
    const preexistingName = inventorySource().match(/^(buffer[0-9]+)\t/mu)?.[1];
    assert.match(preexistingName, /^buffer[0-9]+$/u);

    const first = arm("12345678-1234-4234-8234-123456789abc");
    injectBytes(first.paneId, "\x1b[<0;1;1m");
    const firstEvent = await waitEvent(first.operationDir);
    assert.match(firstEvent.bufferName, /^buffer[0-9]+$/u);
    assert.deepEqual(firstEvent, {
      version: 1,
      nonce: "12345678-1234-4234-8234-123456789abc",
      paneId: first.paneId,
      bufferName: firstEvent.bufferName,
      bytes: contents[1].byteLength,
      sha256: createHash("sha256").update(contents[1]).digest("hex"),
    });
    assert.equal(
      inventorySource()
        .split("\n")
        .filter((line) => /^buffer/u.test(line)).length,
      2,
    );
    assert.match(inventorySource(), new RegExp(`^${preexistingName}\\t`, "mu"));
    invokeObserver({
      nonce: "12345678-1234-4234-8234-123456789abc",
      paneId: first.paneId,
      hookName: first.hookName,
    });
    assert.equal(readdirSync(first.operationDir).includes("overflow.json"), true);
    assert.match(
      tmux(["show-hooks", "-p", "-t", first.paneId, "pane-set-clipboard"]),
      /^pane-set-clipboard\[[0-9]+\] .+$/mu,
    );

    assert.equal(
      retireClipboardPaneHook({
        paneId: first.paneId,
        lease: first.hookLease,
        runTmux: tmux,
        remaining: () => 500,
      }).retirementExact,
      true,
    );
    const second = arm("abcdef12-1234-4234-8234-123456789abc");
    injectBytes(second.paneId, "\x03");
    const secondEvent = await waitEvent(second.operationDir);
    assert.match(secondEvent.bufferName, /^buffer[0-9]+$/u);
    assert.equal(secondEvent.bytes, contents[2].byteLength);
    assert.equal(secondEvent.sha256, createHash("sha256").update(contents[2]).digest("hex"));
    assert.equal(
      inventorySource()
        .split("\n")
        .filter((line) => /^buffer/u.test(line)).length,
      2,
    );
    assert.match(inventorySource(), /testdrive-input-fixture/u);
    assert.equal(targetTmux(["show-options", "-gv", "set-clipboard"]).trim(), "off");

    retireClipboardPaneHook({
      paneId: second.paneId,
      lease: second.hookLease,
      runTmux: tmux,
      remaining: () => 500,
    });

    let captures = 0;
    let ownedObservation = null;
    const realIdentity = {
      paneId: second.paneId,
      sessionId: tmux(["display-message", "-p", "-t", second.paneId, "#{session_id}"]).trim(),
      cols: 80,
      rows: 24,
    };
    const operationNonces = [
      "55555555-1234-4234-8234-123456789abc",
      "66666666-1234-4234-8234-123456789abc",
    ];
    const armPort = async (_identity, nonce) => {
      const owned = arm(nonce);
      ownedObservation = owned;
      let retirementExact = false;
      let retainedArtifactId = null;
      let duplicateSettleElapsedMs = null;
      const observationStartedAt = performance.now();
      let artifactObservedElapsedMs = null;
      let callbackEvidence = null;
      const baseline = JSON.parse(
        readFileSync(join(owned.operationDir, "lease.json"), "utf8"),
      ).inventory;
      const listArtifacts = () =>
        [
          ...new Set(
            readdirSync(owned.operationDir)
              .filter((name) => /^(?:buffer[0-9]+|overflow)\.(?:bin|tmp|json)$/u.test(name))
              .map((name) => name.slice(0, name.lastIndexOf("."))),
          ),
        ].sort();
      const readCallbackEvidence = () => {
        const statePath = join(owned.operationDir, "callback-state.json");
        if (!existsSync(statePath)) return callbackEvidence;
        callbackEvidence = {
          callbackInvocations: existsSync(join(owned.operationDir, "overflow.json")) ? 2 : 1,
          ...parseClipboardCallbackState(JSON.parse(readFileSync(statePath, "utf8")), {
            nonce,
            paneId: owned.paneId,
          }),
        };
        return callbackEvidence;
      };
      return {
        wait: async (waitTimeoutMs) => {
          const observed = await waitForClipboardObservation({
            listArtifacts,
            readEvent: (artifactId) => {
              const eventPath = join(owned.operationDir, `${artifactId}.json`);
              return existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, "utf8")) : null;
            },
            expected: { nonce, paneId: owned.paneId },
            clock: performance,
            sleep: delay,
            timeoutMs: waitTimeoutMs,
            quietMs: 0,
          });
          retainedArtifactId = observed.artifactId;
          artifactObservedElapsedMs = Math.round(performance.now() - observationStartedAt);
          return {
            ...observed.clipboard,
            priorCopyCount: baseline.buffers.length,
            newCopyCount: Math.min(baseline.bufferLimit, baseline.buffers.length + 1),
            identityExact: true,
          };
        },
        dispose: async (cleanupTimeoutMs) => {
          const cleanupDeadline = performance.now() + cleanupTimeoutMs;
          try {
            retirementExact = retireClipboardPaneHook({
              paneId: owned.paneId,
              lease: owned.hookLease,
              runTmux: tmux,
              remaining: () => Math.max(1, Math.floor(cleanupDeadline - performance.now())),
            }).retirementExact;
            duplicateSettleElapsedMs = await settleClipboardObservationAfterRetirement({
              listArtifacts,
              readCallbackEvidence,
              retainedBufferName: retainedArtifactId,
              clock: performance,
              sleep: delay,
              timeoutMs: Math.max(1, Math.floor(cleanupDeadline - performance.now())),
            });
          } finally {
            rmSync(owned.operationDir, { recursive: true, force: true });
          }
        },
        evidence: () => ({
          candidateAttempts: owned.hookLease.candidateAttempts,
          occupiedCount: owned.hookLease.occupiedCount,
          retirementExact,
          retirementStage: retirementExact ? "complete" : "not-started",
          retirementElapsedMs: 0,
          finalOwnerAbsent: retirementExact,
          finalHookAbsent: retirementExact,
          ...readCallbackEvidence(),
          artifactObservedElapsedMs,
          duplicateSettleElapsedMs,
        }),
      };
    };
    const realPort = {
      clock: performance,
      sleep: delay,
      nonce: () => operationNonces.shift(),
      resolveIdentity: async () => realIdentity,
      verifyIdentity: async (identity) => assert.deepEqual(identity, realIdentity),
      capabilities: async () => fullTerminalCapabilities(),
      inject: async (identity, bytes) => injectBytes(identity.paneId, bytes),
      captureAnsi: async () =>
        captures++ === 0
          ? `${"\n".repeat(3)}  \x1b[38;5;1;48;5;0mABCD\x1b[0m`
          : `${"\n".repeat(3)}  \x1b[38;5;0;48;5;1mABCD\x1b[0m`,
      waitForFrame: async () => "select text: drag to copy",
      armClipboard: armPort,
    };
    const selection = await executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({
          version: 1,
          kind: "selection-drag",
          from: { x: 2, y: 3 },
          to: { x: 5, y: 3 },
          contentRect: { x: 2, y: 3, width: 4, height: 1 },
          timeoutMs: 3_000,
        }),
      ),
      realPort,
    );
    assert.equal(selection.clipboardObservation.retirementExact, true);
    assert.ok(selection.clipboardObservation.duplicateSettleElapsedMs >= 40);
    assert.deepEqual(Object.keys(selection.clipboard).sort(), ["bytes", "sha256"]);
    assert.doesNotMatch(
      JSON.stringify(selection),
      /buffer[0-9]+|operationNonces|clipboard-observations/u,
    );
    assert.equal(existsSync(ownedObservation.operationDir), false);
    const copy = await executeTestdriveInputOperation(
      parseTestdriveInputDocument(
        JSON.stringify({ version: 1, kind: "copy-capture", timeoutMs: 3_000 }),
      ),
      realPort,
    );
    assert.equal(copy.paneId, selection.paneId);
    assert.equal(copy.clipboard.sha256, selection.clipboard.sha256);
    assert.equal(copy.clipboardObservation.retirementExact, true);
    assert.equal(copy.clipboardObservation.identityExact, true);
    assert.ok(copy.clipboardObservation.duplicateSettleElapsedMs >= 40);
    assert.deepEqual(Object.keys(copy.clipboard).sort(), ["bytes", "sha256"]);
    assert.equal(existsSync(ownedObservation.operationDir), false);

    const timeout = arm("11111111-1234-4234-8234-123456789abc");
    assert.throws(
      () =>
        invokeObserver({
          ...timeout,
          nonce: "11111111-1234-4234-8234-123456789abc",
          observedPaneId: "%999",
        }),
      /pane identity mismatch/u,
    );
    assert.throws(
      () => invokeObserver({ ...timeout, nonce: "11111111-1234-4234-8234-123456789abc" }),
      /did not appear before deadline/u,
    );

    retireClipboardPaneHook({
      paneId: timeout.paneId,
      lease: timeout.hookLease,
      runTmux: tmux,
      remaining: () => 500,
    });
    const ambiguous = arm("22222222-1234-4234-8234-123456789abc");
    tmux(["load-buffer", "-"], { input: "concurrent-a" });
    tmux(["load-buffer", "-"], { input: "concurrent-b" });
    assert.throws(
      () => invokeObserver({ ...ambiguous, nonce: "22222222-1234-4234-8234-123456789abc" }),
      /changed ambiguously/u,
    );

    retireClipboardPaneHook({
      paneId: ambiguous.paneId,
      lease: ambiguous.hookLease,
      runTmux: tmux,
      remaining: () => 500,
    });
    const disposed = arm("33333333-1234-4234-8234-123456789abc");
    rmSync(disposed.operationDir, { recursive: true, force: true });
    assert.throws(
      () => invokeObserver({ ...disposed, nonce: "33333333-1234-4234-8234-123456789abc" }),
      /lease is no longer active/u,
    );
    retireClipboardPaneHook({
      paneId: disposed.paneId,
      lease: disposed.hookLease,
      runTmux: tmux,
      remaining: () => 500,
    });

    const zero = arm("44444444-1234-4234-8234-123456789abc");
    const zeroLeasePath = join(zero.operationDir, "lease.json");
    const zeroLease = JSON.parse(readFileSync(zeroLeasePath, "utf8"));
    writeFileSync(zeroLeasePath, `${JSON.stringify({ ...zeroLease, pollTimeoutMs: 0 })}\n`, {
      mode: 0o600,
    });
    assert.throws(
      () => invokeObserver({ ...zero, nonce: "44444444-1234-4234-8234-123456789abc" }),
      /lease identity is malformed/u,
    );
  } finally {
    try {
      tmux(["kill-server"]);
    } catch {
      // Server may already have exited with its fixture pane.
    }
    try {
      targetTmux(["kill-server"]);
    } catch {
      // Target fixture may already have exited.
    }
    rmSync(root, { recursive: true, force: true });
  }
});
