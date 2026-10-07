import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkReferenceOutputContent,
  createReferenceOutputWitness,
  observeReferenceOutputAttempt,
  expectedReferencePrefix,
  parseReferenceNativeIdentity,
} from "./performance-reference-output-content.mjs";

const small = () => ({
  identity: {
    sessionName: "owned",
    sessionId: "$1",
    windowId: "@1",
    paneId: "%1",
    semanticPaneId: "pane",
    pid: 9,
    cols: 8,
    rows: 2,
    cursorX: 2,
    cursorY: 1,
    alternate: 0,
    insert: 0,
    origin: 0,
    wrap: 1,
    scrollTop: 0,
    scrollBottom: 1,
  },
  cells: [[..."startup "], [..."p>      "]],
});
function smallInput() {
  const baseline = small(),
    payloads = ["x", "y"],
    expected = expectedReferencePrefix(baseline, payloads);
  return {
    baseline,
    payloads,
    native: {
      identity: { ...baseline.identity, cursorX: expected.cursorX },
      cells: expected.cells,
    },
    hostCells: expected.cells.map((r) => [...r]),
    rect: { width: 8, bodyRows: 2 },
  };
}
test("prefix oracle preserves nonblank startup and every unchanged cell", () => {
  const input = smallInput();
  assert.equal(checkReferenceOutputContent(input).observedPrefix, 2);
  assert.equal(input.native.cells[1].join(""), "p>xy    ");
});
for (const [name, mutate] of Object.entries({
  "unchanged native cell corruption": (x) => {
    x.native.cells[0][0] = "!";
  },
  "wrong host prefix": (x) => {
    x.hostCells[1][2] = "z";
  },
  "host extra text outside echo": (x) => {
    x.hostCells[0][7] = "!";
  },
  "cursor drift": (x) => {
    x.native.identity.cursorY = 0;
  },
  "geometry change": (x) => {
    x.native.identity.cols = 9;
  },
  "mode change": (x) => {
    x.native.identity.insert = 1;
  },
  "hidden echo column": (x) => {
    x.rect.width = 3;
    x.hostCells = x.hostCells.map((r) => r.slice(0, 3));
  },
  "hidden echo row": (x) => {
    x.rect.bodyRows = 1;
    x.hostCells = x.hostCells.slice(0, 1);
  },
  "wrap unsupported": (x) => {
    x.payloads = Array(6).fill("x");
  },
}))
  test(`rejects ${name}`, () => {
    const x = smallInput();
    mutate(x);
    assert.throws(() => checkReferenceOutputContent(x));
  });
test("mode/identity parser fails closed on absent flags, alternate screen and foreign session", () => {
  const raw = "owned\t$1\t@1\t%1\tpane\t9\t8\t2\t2\t1\t0\t0\t0\t1\t0\t1\n";
  assert.equal(parseReferenceNativeIdentity(raw, "owned").cursorX, 2);
  assert.throws(() => parseReferenceNativeIdentity(raw, "foreign"));
  assert.throws(() =>
    parseReferenceNativeIdentity(raw.replace("\t0\t0\t0\t1", "\t1\t0\t0\t1"), "owned"),
  );
  assert.throws(() =>
    parseReferenceNativeIdentity(raw.replace("\t0\t0\t0\t1", "\t\t0\t0\t1"), "owned"),
  );
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "reference-output-unit-"));
  let count = 0,
    revision = 2;
  const native = Array.from({ length: 40 }, () => Array(132).fill(" "));
  native[0].splice(0, 5, ..."ready");
  native[1].splice(0, 5, ..."echo>");
  const hostIdentity = {
    paneId: "%2",
    sessionId: "$2",
    sessionName: "host-owned",
    processId: 101,
    cols: 160,
    rows: 44,
  };
  const state = {
    root,
    native,
    layoutCalls: 0,
    clock: null,
    decodeDeadline: false,
    wrongHost: false,
    wrongProcess: false,
    stale: false,
    hidden: false,
    persistenceFailure: false,
    foreignHost: false,
    changeGeometry: false,
    deadline: false,
    revBack: false,
  };
  const identity = () => ({
    processId: "opentui:101",
    clockId: "opentui-performance-now",
    clockKind: "performance-now",
    semanticPaneId: "pane",
    generation: "generation",
    incarnation: "incarnation",
    revision: state.revBack ? 2 : revision,
    stateHash: revision.toString(16).padStart(16, "0"),
    cols: 132,
    rows: 40,
  });
  const records = () => [
    {
      type: "performance.trace.header",
      processId: "opentui:101",
      clockId: "opentui-performance-now",
    },
    { type: "performance.terminal-canonical-mode", ...identity() },
    {
      type: "performance.terminal-cursor-presentation",
      ...identity(),
      traceId: count ? `trace${count}` : null,
      viewportCols: 132,
      viewportRows: 40,
      sourceEpoch: 1,
      rendererEpoch: 1,
      cursorX: 5 + count,
      cursorY: 1,
      screenX: 34 + count,
      screenY: 5,
      visible: !state.hidden,
    },
    ...(count
      ? [
          {
            type: "performance.stage",
            stage: "paint",
            ...identity(),
            revision: state.stale ? 1 : identity().revision,
            traceId: `trace${count}`,
          },
        ]
      : []),
  ];
  const command = (binary, args, options) => {
    assert(options.timeout > 0 && options.timeout <= 1750);
    assert(options.maxBuffer <= 4 * 1024 * 1024);
    assert.equal(options.env.TMUX, "");
    if (state.deadline) throw Error("probe timed out");
    if (binary === "tmux") {
      assert.deepEqual(args.slice(0, 2), ["-S", join(root, "private.sock")]);
      if (args.includes("list-panes")) {
        if (args.at(-1).includes("window_visible_layout")) {
          state.layoutCalls++;
          if (state.decodeDeadline && state.layoutCalls >= 4) state.clock = 1e12;
          return "abcd,132x41,0,0,1\t@1\t0\ttop\t%1\tpane\t1\n";
        }
        return `owned\t$1\t@1\t%1\tpane\t9\t${state.changeGeometry ? 133 : 132}\t40\t${5 + count}\t1\t0\t0\t0\t1\t0\t39\n`;
      }
      assert(args.includes("capture-pane"));
      if (state.persistenceFailure) {
        unlinkSync(join(root, "output-content.json"));
        mkdirSync(join(root, "output-content.json"));
        native[0][0] = "!";
      }
      return native.map((r) => r.join("")).join("\n") + "\n";
    }
    assert.deepEqual(args, ["scripts/tui-testdrive.mjs", "capture", "--ansi", "--json"]);
    const host = Array.from({ length: 44 }, () => Array(160).fill(" "));
    for (let y = 0; y < 40; y++) for (let x = 0; x < 132; x++) host[y + 3][x + 28] = native[y][x];
    if (state.wrongHost) host[4][33] = "!";
    // Valid wide chrome outside the selected pane must not invalidate ASCII body.
    const lines = host.map((r) => r.join(""));
    lines[0] = "界" + " ".repeat(158);
    return JSON.stringify({
      version: 1,
      cols: 160,
      rows: 44,
      hostIdentity: {
        ...hostIdentity,
        ...(state.foreignHost ? { paneId: "%999" } : {}),
        ...(state.wrongProcess ? { processId: 102 } : {}),
      },
      ansi: lines.join("\n"),
    });
  };
  return {
    state,
    records,
    hostIdentity,
    advance() {
      native[1][5 + count] = count % 2 ? "y" : "x";
      count++;
      revision++;
      return {
        traceId: `trace${count}`,
        semanticPaneId: "pane",
        generation: "generation",
        incarnation: "incarnation",
      };
    },
    async start() {
      return createReferenceOutputWitness({
        root,
        reference: {
          runtimeDir: root,
          hostSession: "host-owned",
          socketArgs: ["-S", join(root, "private.sock")],
        },
        target: "owned",
        generation: "generation",
        records,
        payloads: ["x", "y"],
        expectedHost: hostIdentity,
        command,
        now: () => state.clock ?? performance.now(),
      });
    },
  };
}
test("actual observer orchestration fences fake native/host commands and retains each prefix", async () => {
  const r = rig();
  try {
    const w = await r.start();
    w.observe(0, r.advance());
    w.observe(1, r.advance());
    assert.equal(w.finish().observed, 2);
    const ledger = JSON.parse(readFileSync(w.path, "utf8"));
    assert.equal(ledger.baseline.native.cells[0].join("").trimEnd(), "ready");
    assert.deepEqual(
      ledger.attempts.map((a) => a.status),
      ["observed", "observed"],
    );
    assert.equal(ledger.attempts[1].previousRevision, 3);
  } finally {
    rmSync(r.state.root, { recursive: true, force: true });
  }
});
for (const key of [
  "wrongHost",
  "wrongProcess",
  "foreignHost",
  "stale",
  "hidden",
  "changeGeometry",
  "deadline",
  "revBack",
  "decodeDeadline",
])
  test(`orchestration retains failed ordinal: ${key}`, async () => {
    const r = rig();
    try {
      const w = await r.start();
      const match = r.advance();
      r.state[key] = true;
      assert.throws(() => w.observe(0, match));
      const ledger = JSON.parse(readFileSync(w.path, "utf8"));
      assert.equal(ledger.status, "failed");
      if (key === "decodeDeadline") assert.match(ledger.attempts[0].error, /after comparison/u);
      assert.equal(ledger.attempts[0].status, "failed");
      assert.equal(ledger.attempts[1].status, "not-observed");
      assert.throws(() => w.finish());
    } finally {
      rmSync(r.state.root, { recursive: true, force: true });
    }
  });
test("missing intermediate observation refuses finish or skipping ordinal", async () => {
  const r = rig();
  try {
    const w = await r.start();
    assert.throws(() => w.finish());
    assert.throws(() => w.observe(1, r.advance()));
  } finally {
    rmSync(r.state.root, { recursive: true, force: true });
  }
});
test("content failure and persistence failure are both preserved", async () => {
  const r = rig();
  try {
    const w = await r.start();
    const match = r.advance();
    r.state.persistenceFailure = true;
    assert.throws(
      () => w.observe(0, match),
      (e) => e instanceof AggregateError && e.errors.length === 2,
    );
  } finally {
    rmSync(r.state.root, { recursive: true, force: true });
  }
});

test("controller branch preserves matched input plus observation and ledger errors", () => {
  const original = Error("bad viewport"),
    persistence = Error("disk full"),
    attempt = { ordinal: 0, status: "matched" };
  assert.throws(
    () =>
      observeReferenceOutputAttempt(
        {
          observe() {
            throw original;
          },
        },
        attempt,
        {},
        () => {
          throw persistence;
        },
      ),
    (e) => e instanceof AggregateError && e.errors[0] === original && e.errors[1] === persistence,
  );
  assert.equal(attempt.status, "matched");
  assert.equal(attempt.outputObservation, "failed");
});

test("combining single-cell baseline survives exact crop; wide pane baseline rejects", async () => {
  for (const cell of ["e\u0301", "界"]) {
    const r = rig();
    r.state.native[0][0] = cell;
    try {
      if (cell === "界") await assert.rejects(r.start());
      else {
        const w = await r.start();
        w.observe(0, r.advance());
      }
    } finally {
      rmSync(r.state.root, { recursive: true, force: true });
    }
  }
});

test("CLI rejects non-owned or non-36 content variants before creating resources", () => {
  for (const args of [
    ["--capture-output-content"],
    ["--capture-output-content", "--owned-daemon-capture", "--input-samples", "35"],
  ]) {
    const result = spawnSync(process.execPath, ["scripts/performance-reference.mjs", ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires owned capture and exactly 36 inputs/u);
  }
});
