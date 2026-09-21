import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  developmentCiIdentity,
  developmentCiScope,
  runDevelopmentCi,
  finalizeDevelopmentCi,
} from "./development-ci.mjs";
function fixture(t) {
  const p = mkdtempSync(join(tmpdir(), "ci-proof-"));
  t.after(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
const command = (code) => ({
  name: "owned-test",
  executable: process.execPath,
  args: ["-e", code],
  timeoutMs: 5000,
});
test("run/job/attempt/matrix names cannot collide or escape", () => {
  const env = { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "fast" };
  const first = developmentCiIdentity(env, "fast");
  assert.notEqual(first, developmentCiIdentity({ ...env, GITHUB_RUN_ATTEMPT: "2" }, "fast"));
  assert.notEqual(first, developmentCiIdentity({ ...env, GITHUB_JOB: "other" }, "fast"));
  assert.throws(() => developmentCiIdentity({ ...env, GITHUB_JOB: "../escape" }, "fast"));
  assert.throws(() => developmentCiIdentity({}, "fast"));
});
test("docs-only changes omit heavy work, runtime/workflow changes select it", () => {
  assert.equal(developmentCiScope(["README.md", "docs/content/docs/contributing.mdx"]), false);
  for (const path of [
    "packages/daemon/src/lib/development.ts",
    "scripts/a.mjs",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "native/tmux/native-grid.patch",
  ])
    assert.equal(developmentCiScope([path]), true);
});
test("parallel private runs have separate HOME/TMP and bounded logs", async (t) => {
  const parent = fixture(t);
  const code =
    "const fs=require('node:fs'); if(process.env.HOME===process.env.ORIGINAL_HOME)process.exit(9); fs.writeFileSync(process.env.TMPDIR+'/own','x'); process.stdout.write('x'.repeat(1100000));";
  const results = await Promise.all(
    ["a", "b"].map((name) =>
      runDevelopmentCi({
        root: join(parent, name),
        commands: [command(code)],
        env: { ...process.env, ORIGINAL_HOME: process.env.HOME },
      }),
    ),
  );
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].status, "passed");
    assert.equal(results[i].cleanup.confirmed, true);
    assert.equal(results[i].checks[0].logTruncated, true);
    assert.equal(readFileSync(join(parent, i ? "b" : "a", "owned-test.log")).length, 1048576);
    assert.equal(existsSync(results[i].workRoot), false);
  }
});
test("failed command produces receipt and preserves work without a false cleanup claim", async (t) => {
  const root = join(fixture(t), "failed");
  const r = await runDevelopmentCi({ root, commands: [command("process.exit(7)")] });
  assert.equal(r.status, "failed");
  assert.equal(r.checks[0].exitCode, 7);
  assert.equal(r.cleanup.children.confirmed, true);
  assert.equal(r.cleanup.confirmed, false);
  assert.equal(existsSync(r.workRoot), true);
  t.after(() => rmSync(r.workRoot, { recursive: true }));
  assert.equal(finalizeDevelopmentCi(root).status, "failed");
  await assert.rejects(runDevelopmentCi({ root, commands: [] }));
});
test("cancelled owned fixture settles its real descendant before root close", async (t) => {
  const root = join(fixture(t), "cancelled"),
    controller = new AbortController();
  const code = `const {spawn}=require('node:child_process'),fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.on('spawn',()=>fs.writeFileSync(process.env.TMPDIR+'/child.pid',String(child.pid)));process.on('SIGTERM',()=>{child.once('close',()=>process.exit(0));child.kill('SIGTERM')});setInterval(()=>{},1000);`;
  const pending = runDevelopmentCi({
    root,
    commands: [command(code)],
    signal: controller.signal,
    graceMs: 1000,
  });
  const work = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8")).workRoot;
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const marker = join(work, "tmp/child.pid");
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(10);
    assert.equal(existsSync(marker), true);
    const pid = Number(readFileSync(marker, "utf8"));
    controller.abort();
    const r = await pending;
    assert.equal(r.status, "cancelled");
    assert.equal(r.cleanup.children.confirmed, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(r.checks[0].pid, 0), { code: "ESRCH" });
    assert.equal(finalizeDevelopmentCi(root).status, "cancelled");
  } finally {
    controller.abort();
    await pending;
  }
});
test("always finalizer makes absent execution visibly unqualified", (t) => {
  const root = join(fixture(t), "never-started");
  const r = finalizeDevelopmentCi(root);
  assert.equal(r.status, "not-run-or-interrupted");
  assert.equal(r.cleanup.confirmed, false);
});
