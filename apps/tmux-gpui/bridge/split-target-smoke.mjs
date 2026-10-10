// Native tmux targeting proof only: no daemon, GUI, or production socket access.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH"].includes(key)
  )
    delete process.env[key];
}
const fleet = await createScratchFleet({
  sessions: 1,
  windowsPerSession: 1,
  slug: "gpui-split-target",
});
const run = (...args) =>
  execFileSync(fleet.environment.TMUX_IDE_TMUX_BIN, ["-S", fleet.socketPath, ...args], {
    env: { ...process.env, ...fleet.environment },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  }).trim();
const evidence = { binary: fleet.environment.TMUX_IDE_TMUX_BIN, cases: [], cleanup: false };
let failure;
try {
  for (const axis of ["cols", "rows"]) {
    const window = run(
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      `=${fleet.sessionNames[0]}`,
      "-n",
      axis,
      "sleep 120",
    );
    run("set-option", "-w", "-t", window, "pane-border-status", "off");
    run("resize-window", "-t", window, "-x", "160", "-y", "80");
    const l = run("list-panes", "-t", window, "-F", "#{pane_id}");
    const split = (pane, direction) =>
      run("split-window", "-d", direction, "-t", pane, "-P", "-F", "#{pane_id}", "sleep 120");
    const main = axis === "cols" ? "-h" : "-v",
      cross = axis === "cols" ? "-v" : "-h";
    const middle = split(l, main),
      right = split(middle, main),
      b = split(middle, cross),
      a2 = split(middle, main);
    const ids = { l, a1: middle, a2, b, right };
    const snapshot = () => ({
      layout: run("display-message", "-p", "-t", window, "#{window_layout}"),
      panes: Object.fromEntries(
        run(
          "list-panes",
          "-t",
          window,
          "-F",
          "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
        )
          .split("\n")
          .map((line) => {
            const [id, ...cells] = line.split("\t");
            return [id, cells.map(Number)];
          }),
      ),
    });
    const size = axis === "cols" ? 2 : 3,
      origin = axis === "cols" ? 0 : 1;
    const before = snapshot();
    run("resize-pane", "-t", a2, axis === "cols" ? "-x" : "-y", String(before.panes[a2][size] + 3));
    const wrong = snapshot();
    assert.equal(
      wrong.panes[right][origin],
      before.panes[right][origin],
      "A2 must not move desired outer boundary",
    );
    assert.notEqual(
      wrong.panes[a2][origin],
      before.panes[a2][origin],
      "A2 changes its inner boundary",
    );
    run("select-layout", "-t", window, before.layout);
    const restored = snapshot();
    assert.deepEqual(
      restored,
      before,
      "Both target trials must begin with exact same native tree and rectangles",
    );
    run("resize-pane", "-t", b, axis === "cols" ? "-x" : "-y", String(before.panes[b][size] + 3));
    const correct = snapshot();
    assert.equal(
      correct.panes[right][origin],
      before.panes[right][origin] + 3,
      "B must move outer middle/R boundary",
    );
    assert.equal(correct.panes[l][size], before.panes[l][size], "Unrelated outer pane unchanged");
    assert.equal(correct.panes[b][size], before.panes[b][size] + 3);
    assert.equal(
      correct.panes[a2][origin] + correct.panes[a2][size] + 1,
      correct.panes[right][origin],
      "Top subgroup remains aligned to outer boundary",
    );
    evidence.cases.push({
      axis,
      ids,
      before,
      wrongTargetA2: wrong,
      restored,
      correctTargetB: correct,
    });
    run("kill-window", "-t", window);
  }
  // H(V(H,H),V(H,H)): every leaf's nearest H ancestor is internal.
  const window = run(
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id}",
    "-t",
    `=${fleet.sessionNames[0]}`,
    "-n",
    "no-descendant",
    "sleep 120",
  );
  run("set-option", "-w", "-t", window, "pane-border-status", "off");
  run("resize-window", "-t", window, "-x", "160", "-y", "80");
  const left = run("list-panes", "-t", window, "-F", "#{pane_id}");
  const split = (pane, direction) =>
    run("split-window", "-d", direction, "-t", pane, "-P", "-F", "#{pane_id}", "sleep 120");
  const right = split(left, "-h");
  const groups = [left, right].map((top) => {
    const bottom = split(top, "-v");
    return [top, split(top, "-h"), bottom, split(bottom, "-h")];
  });
  const snapshot = () => ({
    layout: run("display-message", "-p", "-t", window, "#{window_layout}"),
    panes: Object.fromEntries(
      run(
        "list-panes",
        "-t",
        window,
        "-F",
        "#{pane_id}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}",
      )
        .split("\n")
        .map((line) => {
          const [id, ...cells] = line.split("\t");
          return [id, cells.map(Number)];
        }),
    ),
  });
  const before = snapshot();
  const boundary = (state) => Math.min(...groups[1].map((id) => state.panes[id][0]));
  const trials = [];
  for (const pane of groups.flat()) {
    run("select-layout", "-t", window, before.layout);
    const restored = snapshot();
    assert.deepEqual(restored, before);
    run("resize-pane", "-t", pane, "-x", String(before.panes[pane][2] + 3));
    const after = snapshot();
    assert.notDeepEqual(after, before, "Every trial must genuinely change internal geometry");
    assert.equal(after.panes[pane][2], before.panes[pane][2] + 3);
    assert.equal(
      boundary(after),
      boundary(before),
      "No leaf target can move the root H boundary in this tree",
    );
    // Both complete half bounds remain fixed, not merely a single chosen leaf.
    for (const group of groups) {
      assert.equal(
        Math.min(...group.map((id) => after.panes[id][0])),
        Math.min(...group.map((id) => before.panes[id][0])),
      );
      assert.equal(
        Math.max(...group.map((id) => after.panes[id][0] + after.panes[id][2])),
        Math.max(...group.map((id) => before.panes[id][0] + before.panes[id][2])),
      );
    }
    trials.push({ pane, restored, after });
  }
  evidence.cases.push({
    kind: "no-descendant-target",
    tree: "H(V(H,H),V(H,H))",
    groups,
    before,
    trials,
  });
  run("kill-window", "-t", window);
} catch (error) {
  failure = error;
} finally {
  try {
    await fleet.dispose();
    evidence.cleanup = true;
  } catch (error) {
    failure = new AggregateError(
      [...(failure ? [failure] : []), error],
      "Split target cleanup failed",
    );
  }
}
console.log(JSON.stringify(evidence, null, 2));
if (failure) throw failure;
