// Explicit owned app/daemon startup qualification; no personal installation changes.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import {
  startDaemon,
  waitForReadinessLadder,
} from "../../../scripts/lib/product-fixtures/daemon.ts";
import { stopFixtureChild } from "../bridge/fixture-child.mjs";
const [app, cliPath, artifacts] = process.argv.slice(2);
assert(process.env.TMUX_IDE_NATIVE_TEST_PACKAGED === "owned-packaged");
assert([app, cliPath, artifacts].every((p) => p && isAbsolute(p)));
await mkdir(artifacts, { mode: 0o700 });
const run = promisify(execFile);
const fleet = await createScratchFleet({
  sessions: 2,
  windowsPerSession: 1,
  slug: "native-package",
});
let daemon, child;
let output = "";
try {
  daemon = await startDaemon(fleet, { cliPath });
  // Populate an owned workspace before asserting full readiness after termination.
  for (const name of fleet.sessionNames) await daemon.promote(name);
  await waitForReadinessLadder(daemon);
  const before = fleet.sessionNames.map((name) => fleet.captureWindowPanes(name));
  child = spawn(join(app, "Contents/MacOS/tmux-ide-launcher"), [], {
    env: { ...process.env, ...fleet.environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let exited = false,
    failure;
  child.on("error", (error) => {
    failure = error;
  });
  child.on("close", () => {
    exited = true;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output = (output + data).slice(-32768);
    });
  let desktop;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    assert(!exited, "packaged native process exited before window creation");
    const script = `ObjC.import("CoreGraphics"); var session=ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())); var windows=ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0,0))); JSON.stringify({locked:!!session.CGSSessionScreenIsLocked,windows:windows.filter(w=>w.kCGWindowOwnerPID===${child.pid} && w.kCGWindowLayer===0).map(w=>({id:w.kCGWindowNumber,bounds:w.kCGWindowBounds}))});`;
    desktop = JSON.parse(
      (await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 5000 }))
        .stdout,
    );
    if (desktop.windows.some((w) => w.bounds.Width > 100 && w.bounds.Height > 100)) break;
    await delay(250);
  }
  assert(
    desktop?.windows.some((w) => w.bounds.Width > 100 && w.bounds.Height > 100),
    "no native app window observed",
  );
  await delay(1500);
  assert(!exited, "native app exited after startup");
  const processRows = (await run("/bin/ps", ["-axo", "pid=,ppid=,comm="], { timeout: 5000 })).stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match && { pid: Number(match[1]), parent: Number(match[2]), command: match[3] };
    })
    .filter(Boolean);
  const descendants = new Set([child.pid]);
  for (let pass = 0; pass < processRows.length; pass++) {
    const old = descendants.size;
    for (const process of processRows)
      if (descendants.has(process.parent)) descendants.add(process.pid);
    if (old === descendants.size) break;
  }
  const native = processRows.find((p) => p.pid === child.pid);
  assert(native?.command.endsWith("/tmux-ide-gpui"));
  const helpers = processRows.filter((p) => p.pid !== child.pid && descendants.has(p.pid));
  assert(
    !helpers.some((p) => /\/(node|bun|ssh)$/.test(p.command)),
    "unexpected metadata helper in local startup",
  );
  let screenshot = false;
  if (!desktop.locked) {
    try {
      await run(
        "/usr/sbin/screencapture",
        ["-x", "-l", String(desktop.windows[0].id), join(artifacts, "native-home.png")],
        { timeout: 5000 },
      );
      screenshot = true;
    } catch {
      /* Recording permission is separate from successful startup. */
    }
  }
  const readinessBeforeStop = await daemon.readiness();
  await stopFixtureChild(child);
  assert.deepEqual(
    fleet.sessionNames.map((name) => fleet.captureWindowPanes(name)),
    before,
  );
  const readiness = await daemon.readiness();
  await writeFile(
    join(artifacts, "readiness.json"),
    JSON.stringify({ before: readinessBeforeStop, after: readiness }, null, 2),
  );
  assert.equal(readiness.blockedAt, null, "daemon must remain ready after app process termination");
  const receipt = {
    passed: true,
    normalPackagedLauncher: true,
    windowObserved: true,
    desktopLocked: desktop.locked,
    screenshot,
    helperProcesses: helpers.length,
    daemonSurvivedProcessTermination: true,
    sourcePanesUnchanged: true,
    physicalInputTested: false,
    windowCloseTested: false,
  };
  await writeFile(join(artifacts, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
} finally {
  await stopFixtureChild(child);
  try {
    await writeFile(
      join(artifacts, "native.log"),
      daemon ? output.replaceAll(daemon.record.authToken, "[redacted]") : output,
      { mode: 0o600 },
    );
    await daemon?.stop();
  } finally {
    await fleet.dispose();
  }
}
