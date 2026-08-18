import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PASTE_BYTES,
  enforceClipboardCallbackCap,
  deliverExactHostBytes,
  exactPtyPasteBufferArgs,
  executeTestdriveInputOperation,
  fullTerminalCapabilities,
  parseTestdriveInputDocument,
  proveRendererSelectionStyleDelta,
  translateTestdriveInput,
  validateClipboardObservationEvents,
  waitForClipboardObservation,
} from "./tui-testdrive-input.mjs";

const context = {
  capabilities: fullTerminalCapabilities(),
  geometry: { cols: 80, rows: 24 },
};

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

test("exact delivery injects tmux and always performs bounded buffer cleanup", () => {
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
          if (args[0] === "paste-buffer") throw new Error("paste failed");
        },
      }),
    /paste failed/,
  );
  assert.deepEqual(
    calls.map(([args]) => args[0]),
    ["load-buffer", "paste-buffer", "delete-buffer"],
  );
  assert.ok(calls[0][1].timeout > calls[1][1].timeout);
  assert.ok(calls[2][1].timeout <= 100);
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
        if (args[0] === "delete-buffer") throw new Error("already deleted by -d");
      },
    }),
  );
  assert.ok(calls[1].includes("-d"));
  assert.equal(calls.at(-1)[0], "delete-buffer");
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
    },
    captureAnsi: async () => "",
    waitForFrame: async () => "select text: drag to copy",
    armClipboard: async () => ({
      wait: async () => ({ bytes: 4, sha256: "a".repeat(64) }),
      dispose: async (timeout) => calls.push(["dispose", timeout]),
    }),
    ...overrides,
  };
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
  assert.deepEqual(
    harness.calls.filter(([kind]) => kind === "verify").map((call) => call[1]),
    ["%7", "%7"],
  );
  assert.deepEqual(harness.calls.find(([kind]) => kind === "inject").slice(1, 3), ["%7", "\x1b[O"]);
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
        wait: async () => ({ bytes: 9, sha256: "b".repeat(64) }),
        dispose: async (remaining) => harness.calls.push(["dispose", remaining]),
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
  assert.equal(harness.calls.at(-1)[0], "dispose");
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
  await assert.rejects(
    executeTestdriveInputOperation(command, harness.port),
    /missing clipboard event/,
  );
  assert.equal(harness.calls.at(-1)[0], "dispose");
  assert.ok(harness.calls.at(-1)[1] <= 500);
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
  await executeTestdriveInputOperation(command, harness.port);
  const injected = harness.calls.filter(([kind]) => kind === "inject").map((call) => call[2]);
  assert.deepEqual(injected.slice(0, 3), ["\x1b[<2;3;4M", "\x1b[<2;3;4m", "\r"]);
  assert.ok(harness.calls.findIndex(([kind]) => kind === "arm") < harness.calls.length - 2);
  assert.equal(injected.at(-1), "\x1b[<0;6;4m");
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
    { cells: 2 },
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
    { cells: 5 },
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

test("clipboard callback artifact accounting has a small hard cap", () => {
  assert.equal(enforceClipboardCallbackCap(["buffer1", "buffer2", "buffer2"]), 2);
  assert.throws(
    () => enforceClipboardCallbackCap(["buffer1", "buffer2", "buffer3", "buffer4", "buffer5"]),
    /callback cap exceeded/,
  );
});
