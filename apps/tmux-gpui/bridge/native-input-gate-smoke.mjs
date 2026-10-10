// Diagnostic native-publication barrier, NOT a daemon-authority timing proof.
import { createScratchFleet } from "../../../scripts/lib/product-fixtures/scratch-fleet.ts";
import { startDaemon } from "../../../scripts/lib/product-fixtures/daemon.ts";
import { runPreview } from "./preview-processes.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const app = process.env.TMUX_GPUI_TEST_APP;
const directory = process.env.TMUX_GPUI_INPUT_GATE_DIR;
if (!app || !directory || !isAbsolute(directory) || existsSync(directory))
  throw new Error("Set explicit TMUX_GPUI_TEST_APP and absent absolute TMUX_GPUI_INPUT_GATE_DIR");
const native = join(resolve(app), "Contents/MacOS/tmux-ide-gpui");
const node = join(resolve(app), "Contents/Resources/node");
const browser = join(resolve(app), "Contents/Resources/bridge/browser.bundle.mjs");
const helper = fileURLToPath(new URL("./native-input-gate-helper.mjs", import.meta.url));
const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const inputs = Object.fromEntries(
  await Promise.all(
    [
      native,
      node,
      browser,
      helper,
      fileURLToPath(new URL("./native-input-gate-filter.mjs", import.meta.url)),
      fileURLToPath(new URL("./preview-processes.mjs", import.meta.url)),
    ].map(async (path) => [path, await sha(path)]),
  ),
);
await mkdir(directory, { mode: 0o700 }); // Refuse existing directories; retain evidence after cleanup.
const controller = new AbortController();
let fleet,
  daemon,
  preview,
  outcome,
  passed = false;
const errors = [];
const deadline = Date.now() + 180000;
const abort = () => controller.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
const timer = setTimeout(abort, 180000);
async function wait(predicate) {
  while (!predicate()) {
    if (controller.signal.aborted || Date.now() > deadline)
      throw new Error("Input gate deadline/cancellation");
    if (outcome) throw new Error("Native/helper closed before the proof completed");
    await new Promise((done) => setTimeout(done, 25));
  }
}
try {
  fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "gpui-input-gate" });
  const capture = () =>
    execFileSync(
      fleet.environment.TMUX_IDE_TMUX_BIN,
      ["-S", fleet.socketPath, "capture-pane", "-p", "-t", `=${fleet.sessionNames[0]}:=one`],
      {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ...fleet.environment },
      },
    ).trimEnd();
  fleet.typeInPane(fleet.sessionNames[0], "export PS1='gate> '; clear");
  await wait(() => capture().trim() === "gate>");
  daemon = await startDaemon(fleet);
  const env = { ...process.env, ...fleet.environment, PATH: "/usr/bin:/bin" };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  process.chdir(fleet.root);
  preview = runPreview({
    native: { command: native, args: ["--tmux-browser-stdio"], env },
    helper: { command: node, args: [helper, node, browser, directory], env },
    duplex: true,
    graceMs: 4000,
    signal: controller.signal,
  }).then(
    (code) => {
      outcome = { code };
      return code;
    },
    (error) => {
      outcome = { error: String(error) };
      throw error;
    },
  );
  // Attach a rejection observer immediately; the owner still awaits preview in finally.
  void preview.catch(() => {});
  console.log("Diagnostic app: choose session/pane. Wait for DIAGNOSTIC input gate held.");
  await wait(() => existsSync(join(directory, "held.json")));
  const untouched = capture();
  console.log(
    `HELD: click terminal, type echo WINDOW_ONE_OK and Return; then create ${join(directory, "release")}. Readiness is a test override, not daemon timing.`,
  );
  await wait(() => existsSync(join(directory, "released.json")));
  if (capture() !== untouched) throw new Error("Early input changed source before explicit rearm");
  console.log(
    `RELEASED: without clicking, offer WINDOW_ONE_OK and Return again; then create ${join(directory, "checkpoint")}.`,
  );
  await wait(() => existsSync(join(directory, "checkpoint")));
  if (capture() !== untouched)
    throw new Error("Authority publication resumed an interrupted command suffix");
  console.log("UNCHANGED: click ready terminal, retype echo WINDOW_ONE_OK and Return.");
  await wait(() =>
    capture()
      .split("\n")
      .some((line) => line.trim() === "WINDOW_ONE_OK"),
  );
  console.log("Exact marker verified. Close with Cmd-Q.");
  while (!outcome) {
    if (controller.signal.aborted) throw new Error("Close deadline/cancellation");
    await new Promise((done) => setTimeout(done, 25));
  }
  if ((await preview) !== 0) throw new Error("Preview close failed");
  if (
    !capture()
      .split("\n")
      .some((line) => line.trim() === "WINDOW_ONE_OK")
  )
    throw new Error("App close disturbed source");
  const cleanup = JSON.parse(await readFile(join(directory, "helper-cleanup.json"), "utf8"));
  if (!cleanup.reaped || cleanup.failed) throw new Error("Diagnostic helper cleanup failed");
  for (const [path, hash] of Object.entries(inputs))
    if ((await sha(path)) !== hash) throw new Error("Diagnostic input changed");
  passed = true;
} catch (error) {
  errors.push(String(error));
} finally {
  controller.abort();
  for (const cleanup of [
    async () => {
      if (preview) await preview;
    },
    async () => {
      if (daemon) await daemon.stop();
    },
    async () => {
      if (fleet) await fleet.dispose();
    },
  ]) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(String(error));
    }
  }
  clearTimeout(timer);
  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
  passed = passed && errors.length === 0;
  await writeFile(
    join(directory, "result.json"),
    JSON.stringify(
      {
        passed,
        scope:
          "native publication/admission boundary; readiness overridden; not daemon timing or packaged launcher qualification",
        inputs,
        outcome,
        errors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
if (errors.length) throw new Error(errors.join("; "));

console.log(
  JSON.stringify({ passed, sourceSurvivesClose: true, diagnosticReadinessOverride: true }),
);
