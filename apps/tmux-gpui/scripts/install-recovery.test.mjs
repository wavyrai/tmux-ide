import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readlink,
  readdir,
  rm,
  rename,
  unlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installApp, recoverApp } from "./install-transaction.mjs";
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "gpui-recovery-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stagedApp = join(base, "Stage.app"),
    installRoot = join(base, "managed");
  await mkdir(stagedApp, { mode: 0o700 });
  await writeFile(join(stagedApp, "payload"), "old");
  await installApp({ stagedApp, installRoot, version: "1", verify: async () => true });
  await writeFile(join(stagedApp, "payload"), "new");
  return { base, stagedApp, installRoot };
}
async function interrupt(f, phase) {
  const program = `import {installApp} from ${JSON.stringify(new URL("./install-transaction.mjs", import.meta.url).href)};
 await installApp({stagedApp:${JSON.stringify(f.stagedApp)},installRoot:${JSON.stringify(f.installRoot)},version:'2',verify:async()=>true,${phase === "before-activate" ? 'beforeActivate:async ()=>{const phase="before-activate";' : "onBoundary:async phase=>{"}if(phase===${JSON.stringify(phase)}) await new Promise(()=>{setInterval(()=>{},1000);process.stdout.write('READY\\n');});}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (c) => (stderr = (stderr + c).slice(-4096)));
  try {
    await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(Error("Boundary timeout " + stderr)), 5000);
      child.stdout.on("data", (c) => {
        text += c;
        if (text.includes("READY\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(Error("Premature close " + stderr));
      });
    });
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}
for (const [phase, disposition, expected] of [
  ["before-activate", "keep-current", "1"],
  ["candidate-renamed", "keep-current", "1"],
  ["current-switched", "keep-current", "2"],
  ["current-switched", "restore-previous", "1"],
]) {
  test(`real SIGKILL ${phase}: ${disposition}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    await interrupt(f, phase);
    let verified = 0;
    const result = await recoverApp({
      installRoot: f.installRoot,
      disposition,
      verify: async (app) => {
        verified++;
        assert.equal(
          await readFile(join(app, "payload"), "utf8"),
          expected === "1" ? "old" : "new",
        );
        return true;
      },
    });
    assert.equal(verified, 1);
    assert.equal(result.version, expected);
    assert.equal(
      await readlink(join(f.installRoot, "current")),
      `versions/${expected}/TmuxIDE.app`,
    );
    assert.equal((await readdir(f.installRoot)).includes(".transaction-lock"), false);
    if (expected === "1") {
      assert.equal(
        await readFile(join(result.quarantine, "candidate/TmuxIDE.app/payload"), "utf8"),
        "new",
      );
      await installApp({ ...f, version: "2", verify: async () => true });
      assert.equal(await readlink(join(f.installRoot, "current")), "versions/2/TmuxIDE.app");
    } else assert.equal(result.quarantine, null);
  });
}
test(
  "live PID, journal tamper and verifier denial leave lock and current untouched",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await interrupt(f, "candidate-renamed");
    const path = join(f.installRoot, ".transaction-lock/install.json"),
      original = await readFile(path, "utf8"),
      journal = JSON.parse(original);
    const options = {
      installRoot: f.installRoot,
      disposition: "keep-current",
      verify: async () => true,
    };
    await writeFile(path, JSON.stringify({ ...journal, pid: process.pid }));
    await assert.rejects(recoverApp(options), /still live/);
    await writeFile(path, JSON.stringify({ ...journal, root: { ...journal.root, ino: 0 } }));
    await assert.rejects(recoverApp(options), /identity changed/);
    await writeFile(path, original);
    await assert.rejects(
      recoverApp({ ...options, verify: async () => false }),
      /verification denied/,
    );
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/1/TmuxIDE.app");
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await readdir(f.installRoot)).includes(".recovery-lock"), false);
  },
);
test("legacy empty lock refuses explicit recovery", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.installRoot, ".transaction-lock"), { mode: 0o700 });
  await assert.rejects(
    recoverApp({
      installRoot: f.installRoot,
      disposition: "keep-current",
      verify: async () => true,
    }),
    /legacy/,
  );
});

test(
  "initial preactivation keeps no selection, verifies and quarantines candidate before retry",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await rm(f.installRoot, { recursive: true });
    await interrupt(f, "before-activate");
    await assert.rejects(
      recoverApp({
        installRoot: f.installRoot,
        disposition: "restore-previous",
        verify: async () => true,
      }),
      /No previous/,
    );
    let calls = 0;
    const result = await recoverApp({
      installRoot: f.installRoot,
      disposition: "keep-current",
      verify: async (app) => {
        calls++;
        assert.equal(await readFile(join(app, "payload"), "utf8"), "new");
        return true;
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.version, null);
    assert.equal(result.launchPath, null);
    assert.equal(
      await readFile(join(result.quarantine, "candidate/TmuxIDE.app/payload"), "utf8"),
      "new",
    );
    assert.equal((await readdir(f.installRoot)).includes("current"), false);
    await installApp({ ...f, version: "2", verify: async () => true });
  },
);
test(
  "CLI recovery after real SIGKILL requires policy and verifier",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await interrupt(f, "current-switched");
    const policy = join(f.base, "policy.json");
    await writeFile(
      policy,
      JSON.stringify({
        teamId: "TESTTEAM00",
        bundleId: "com.tmux-ide.gpui.preview",
        architecture: "arm64",
        minimumMacOS: "14.2",
      }),
    );
    const { main } = await import("./install-cli.mjs");
    const args = [
      "recover",
      "--prefix",
      f.installRoot,
      "--policy",
      policy,
      "--disposition",
      "restore-previous",
    ];
    const denied = await main(args, { platform: "darwin", verify: async () => false });
    assert.equal(denied.exitCode, 1);
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/2/TmuxIDE.app");
    const accepted = await main(args, {
      platform: "darwin",
      verify: async (app) => (await readFile(join(app, "payload"), "utf8")) === "old",
    });
    assert.equal(accepted.exitCode, 0);
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/1/TmuxIDE.app");
  },
);
test("recovery marker blocks normal mutation even after transaction lock is absent", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.installRoot, ".recovery-lock"), { mode: 0o700 });
  await assert.rejects(
    installApp({ ...f, version: "2", verify: async () => true }),
    /Incomplete recovery/,
  );
  assert.equal(await readlink(join(f.installRoot, "current")), "versions/1/TmuxIDE.app");
  assert.equal((await readdir(f.installRoot)).includes(".transaction-lock"), false);
});
test(
  "missing alias after switched current refuses without claiming a launch path",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await interrupt(f, "current-switched");
    await rm(join(f.installRoot, "TmuxIDE.app"));
    await assert.rejects(
      recoverApp({
        installRoot: f.installRoot,
        disposition: "keep-current",
        verify: async () => true,
      }),
      /alias missing/,
    );
  },
);

test(
  "verifier replacement of a managed candidate directory refuses before pointer mutation",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await interrupt(f, "candidate-renamed");
    const destination = join(f.installRoot, "versions/2"),
      displaced = join(f.base, "retained-candidate");
    await assert.rejects(
      recoverApp({
        installRoot: f.installRoot,
        disposition: "keep-current",
        verify: async () => {
          await rename(destination, displaced);
          await mkdir(destination, { mode: 0o700 });
          return true;
        },
      }),
      /Candidate changed/,
    );
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/1/TmuxIDE.app");
    assert.equal(await readFile(join(displaced, "TmuxIDE.app/payload"), "utf8"), "new");
    assert.ok((await readdir(f.installRoot)).includes(".transaction-lock"));
  },
);

for (const disposition of ["keep-current", "restore-previous"]) {
  test(
    `legacy prior without named alias recovers a usable launch path: ${disposition}`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const prior = join(f.installRoot, "versions/1");
      await rename(join(prior, "TmuxIDE.app"), join(prior, "app"));
      const recordPath = join(prior, "record.json");
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      delete record.bundle;
      await writeFile(recordPath, JSON.stringify(record));
      await unlink(join(f.installRoot, "current"));
      await symlink("versions/1/app", join(f.installRoot, "current"));
      await unlink(join(f.installRoot, "TmuxIDE.app"));
      await interrupt(f, "candidate-renamed");
      const result = await recoverApp({
        installRoot: f.installRoot,
        disposition,
        verify: async (app) => (await readFile(join(app, "payload"), "utf8")) === "old",
      });
      assert.equal(await readFile(join(result.launchPath, "payload"), "utf8"), "old");
      assert.equal(await readlink(result.launchPath), "current");
      assert.equal(await readlink(join(f.installRoot, "current")), "versions/1/app");
      await installApp({ ...f, version: "2", verify: async () => true });
      assert.equal(await readFile(join(result.launchPath, "payload"), "utf8"), "new");
    },
  );
}
