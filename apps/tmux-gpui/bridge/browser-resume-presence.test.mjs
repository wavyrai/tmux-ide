import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { URL } from "node:url";

// Execute the smoke's actual resume journey so its admission predicate cannot
// drift from this regression. Publications model ordered helper replies still
// in flight when the browser immediately publishes a local focus change.
const source = await readFile(new URL("./browser-smoke.mjs", import.meta.url), "utf8");
const start = source.indexOf("    resumeEvidence = { started:");
const end = source.indexOf("    let last = 0;", start);
assert.ok(start >= 0 && end > start);
const journey = source.slice(start, end);

test("resume smoke waits for the current presence acknowledgement before sending a viewport", async () => {
  const events = [{ presenceRevision: 0, inputReady: true }];
  const commands = [];
  let waits = 0;
  let phase = 0;
  const context = vm.createContext({
    assert,
    Date,
    events,
    resumeEvidence: null,
    recordResume() {},
    resumePublication: (event) => event,
    second: "pane-b",
    untouched: { cols: 80, rows: 24 },
    fleet: {
      sessionNames: ["a", "b"],
      windowGrid: (session) => (session === "b" ? { cols: 111, rows: 47 } : { cols: 80, rows: 24 }),
      captureWindowPanes: () => "",
    },
    observedGrid: () => ({ cols: 95, rows: 30 }),
    send(command) {
      commands.push(command);
      if (command.type === "presence") {
        phase++;
        // The local browser publication revokes input immediately, but only
        // the helper's eventual reply acknowledges this presence transition.
        events.push({ presenceRevision: phase - 1, inputReady: false });
      } else if (command.type === "pane") {
        events.push({
          request: 7,
          presenceRevision: phase,
          inputReady: false,
          snapshot: {},
          status: "Window inactive — activate tmux-ide to type",
        });
      } else if (command.input?.data?.cols === 95) {
        assert.equal(events.at(-1).presenceRevision, 2);
        assert.equal(events.at(-1).inputReady, true);
      }
    },
    async until(predicate) {
      waits++;
      if (waits <= 2 || waits === 5) {
        // Background's local false publication and foreground's late ready
        // publication from the previous revision must both remain insufficient.
        events.push({ request: 7, presenceRevision: phase - 1, inputReady: waits !== 1 });
        assert.equal(predicate(), false, "a stale publication must not finish the presence wait");
        const command = commands.filter((command) => command.type === "presence").at(-1);
        assert.equal(command.revision, phase, "each transition needs a fresh revision");
        events.push({ request: 7, presenceRevision: phase, inputReady: waits === 1 });
        assert.equal(
          predicate(),
          false,
          "matching revision must also have the requested readiness",
        );
        events.push({ request: 7, presenceRevision: phase, inputReady: waits !== 1 });
      }
      assert.equal(predicate(), true, "the matching helper acknowledgement must finish the wait");
    },
  });
  await vm.runInContext(`(async () => { ${journey} })()`, context);
  assert.equal(waits, 5);
  assert.deepEqual(
    commands.filter((command) => command.type === "presence").map((command) => command.revision),
    [1, 2, 3, 4],
  );
  assert.equal(commands.filter((command) => command.input?.data?.cols === 95).length, 1);
});

const focusStart = source.indexOf("    if (process.env.TMUX_GPUI_TEST_FOCUS_ONLY) {");
const focusEnd = source.indexOf("    } else {", focusStart);
const nativeFocusJourney = source.slice(source.indexOf("\n", focusStart) + 1, focusEnd);
async function nativeFocusFixture(shrink = false) {
  const events = [{ request: 4, presenceRevision: 2, inputReady: true }];
  let calls = 0,
    grid = { cols: 89, rows: 26 };
  const context = vm.createContext({
    events,
    assert,
    console: { log() {} },
    fleet: { sessionNames: ["a", "b"], windowGrid: () => ({ ...grid }) },
    async until(predicate) {
      calls++;
      if (calls === 1) {
        assert.equal(predicate(), true);
        return;
      }
      if (calls === 2) {
        events.push({ request: 4, presenceRevision: 2, inputReady: false });
        assert.equal(
          predicate(),
          false,
          "local focus publication is not a background acknowledgement",
        );
        events.push({ request: 4, presenceRevision: 3, inputReady: false });
        if (shrink === true) grid = { cols: 80, rows: 24 };
      } else {
        events.push({ request: 4, presenceRevision: 3, inputReady: true });
        assert.equal(predicate(), false, "old presence revision cannot qualify foreground return");
        events.push({ request: 4, presenceRevision: 4, inputReady: true });
        if (shrink === "foreground") grid = { cols: 80, rows: 24 };
      }
      assert.equal(predicate(), true);
    },
  });
  await vm.runInContext("(async()=>{" + nativeFocusJourney + "})()", context);
  assert.equal(calls, 3);
}
test("physical-focus journey requires fresh blur/refocus acknowledgements and preserves exact grid", async () => {
  await nativeFocusFixture();
});
test("physical-focus journey rejects the original shrink to80x24", async () => {
  await assert.rejects(nativeFocusFixture(true), /physical focus loss preserves/);
});
test("physical-focus journey rejects geometry loss on foreground return", async () => {
  await assert.rejects(nativeFocusFixture("foreground"), /physical focus return preserves/);
});
