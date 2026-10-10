import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
  lstat,
  unlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installApp, rollbackApp, uninstallApp } from "./install-transaction.mjs";
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "gpui-install-transaction-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stagedApp = join(base, "Staged.app"),
    installRoot = join(base, "managed");
  await mkdir(stagedApp, { mode: 0o700 });
  await mkdir(join(stagedApp, "Contents"));
  await writeFile(join(stagedApp, "Contents", "binary"), "version one", { mode: 0o755 });
  return {
    base,
    stagedApp,
    installRoot,
    version: "1.0",
    verify: async (copy) => {
      assert.notEqual(copy, stagedApp);
      assert.equal(await readFile(join(copy, "Contents", "binary"), "utf8"), "version one");
      return true;
    },
  };
}
const content = (path) => readFile(join(path, "Contents", "binary"), "utf8");
test("initial activation and exact repeat verify private copies; upgrade retains rollback", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const verify = async (copy) => {
    calls++;
    return f.verify(copy);
  };
  const first = await installApp({ ...f, verify });
  assert.equal(first.previous, null);
  assert.equal(await readlink(join(f.installRoot, "current")), "versions/1.0/TmuxIDE.app");
  assert.equal((await installApp({ ...f, verify })).repeated, true);
  assert.equal(calls, 2);
  await writeFile(join(f.stagedApp, "Contents", "binary"), "version two");
  const next = await installApp({
    ...f,
    version: "2.0",
    verify: async (copy) => (await content(copy)) === "version two",
  });
  assert.equal(next.previous, "1.0");
  assert.equal(await content(first.app), "version one");
  let rollbackVerified = false;
  const rolled = await rollbackApp({
    installRoot: f.installRoot,
    verify: async (copy) => {
      rollbackVerified = true;
      return (await content(copy)) === "version one";
    },
  });
  assert.equal(rollbackVerified, true);
  assert.equal(rolled.version, "1.0");
  assert.equal(await content(next.app), "version two");
});
test("interruption before activation leaves previous pointer and no owned partial version", async (t) => {
  const f = await fixture(t);
  await installApp(f);
  await assert.rejects(
    installApp({
      ...f,
      version: "2.0",
      beforeActivate: () => {
        throw new Error("controlled interruption");
      },
    }),
    /controlled interruption/,
  );
  assert.equal(await readlink(join(f.installRoot, "current")), "versions/1.0/TmuxIDE.app");
  assert.deepEqual(await readdir(join(f.installRoot, "versions")), ["1.0"]);
  assert.ok(!(await readdir(f.installRoot)).includes(".transaction-lock"));
});
test("verification is mandatory, denies false, and rejects verifier payload mutation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(installApp({ ...f, verify: undefined }), /verifier/);
  await assert.rejects(installApp({ ...f, verify: async () => false }), /verification denied/);
  await assert.rejects(
    installApp({
      ...f,
      verify: async (copy) => {
        await writeFile(join(copy, "injected"), "bad");
        return true;
      },
    }),
    /changed payload/,
  );
  assert.deepEqual(await readdir(join(f.installRoot, "versions")), []);
  await assert.rejects(rollbackApp({ installRoot: f.installRoot }), /verifier/);
});
test("uninstall detaches only and preserves retained apps plus unrelated configuration", async (t) => {
  const f = await fixture(t);
  const installed = await installApp(f);
  await mkdir(join(f.installRoot, "user-config"));
  await writeFile(join(f.installRoot, "user-config", "keep"), "private config");
  const result = await uninstallApp(f);
  assert.equal(result.detached, "1.0");
  assert.deepEqual(result.retained, ["1.0"]);
  await assert.rejects(lstat(join(f.installRoot, "current")), { code: "ENOENT" });
  assert.equal(await content(installed.app), "version one");
  assert.equal(
    await readFile(join(f.installRoot, "user-config", "keep"), "utf8"),
    "private config",
  );
});
test("traversal, staging links, unrelated prefixes and foreign current entries fail closed", async (t) => {
  const f = await fixture(t);
  for (const version of ["../escape", "a/b", "..", "a..b", ""])
    await assert.rejects(installApp({ ...f, version }), /version identity/);
  await mkdir(f.installRoot, { mode: 0o700 });
  await writeFile(join(f.installRoot, "unrelated"), "keep");
  await assert.rejects(installApp(f), /unrelated/);
  await unlink(join(f.installRoot, "unrelated"));
  await symlink(join(f.stagedApp, "Contents", "binary"), join(f.stagedApp, "link"));
  await assert.rejects(installApp(f), /link/);
  await unlink(join(f.stagedApp, "link"));
  await installApp(f);
  await unlink(join(f.installRoot, "current"));
  await symlink(f.stagedApp, join(f.installRoot, "current"));
  await assert.rejects(installApp({ ...f, version: "2.0" }), /foreign/);
  await assert.rejects(uninstallApp(f), /foreign/);
  assert.equal(await content(f.stagedApp), "version one");
});
test("stale locks and symlinked managed parents cannot mutate unrelated directories", async (t) => {
  const f = await fixture(t);
  await installApp(f);
  await mkdir(join(f.installRoot, ".transaction-lock"));
  await assert.rejects(installApp({ ...f, version: "2.0" }), { code: "EEXIST" });
  await rm(join(f.installRoot, ".transaction-lock"), { recursive: true });
  const other = join(f.base, "other");
  await mkdir(other, { mode: 0o700 });
  await writeFile(join(other, "keep"), "keep");
  await rename(join(f.installRoot, "versions"), join(f.installRoot, "saved-versions"));
  await symlink(other, join(f.installRoot, "versions"));
  await assert.rejects(installApp({ ...f, version: "2.0" }), /private/);
  assert.equal(await readFile(join(other, "keep"), "utf8"), "keep");
});
test("changed retained app denies rollback and uncertain ownership denies uninstall", async (t) => {
  const f = await fixture(t);
  const first = await installApp(f);
  await installApp({ ...f, version: "2.0" });
  await writeFile(join(first.app, "unrelated"), "preserve");
  await assert.rejects(rollbackApp(f), /changed/);
  await assert.rejects(uninstallApp(f), /changed/);
  assert.equal(await readlink(join(f.installRoot, "current")), "versions/2.0/TmuxIDE.app");
  assert.equal(await readFile(join(first.app, "unrelated"), "utf8"), "preserve");
});

test("concurrent mutation is rejected before verifier while first transaction owns lock", async (t) => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise((done) => {
    enter = done;
  });
  const barrier = new Promise((done) => {
    release = done;
  });
  const first = installApp({
    ...f,
    verify: async (copy) => {
      enter();
      await barrier;
      return f.verify(copy);
    },
  });
  await entered;
  try {
    await assert.rejects(
      installApp({
        ...f,
        version: "2.0",
        verify: () => {
          throw new Error("must not verify");
        },
      }),
      { code: "EEXIST" },
    );
  } finally {
    release();
  }
  assert.equal((await first).version, "1.0");
});
test("same version with changed content and symlinked root are rejected", async (t) => {
  const f = await fixture(t);
  const initial = await installApp(f);
  await writeFile(join(f.stagedApp, "Contents", "binary"), "changed");
  await assert.rejects(installApp({ ...f, verify: async () => true }), /already used/);
  assert.equal(await content(initial.app), "version one");
  const alias = join(f.base, "alias");
  await symlink(f.installRoot, alias);
  await assert.rejects(
    installApp({ ...f, installRoot: alias, version: "2.0", verify: async () => true }),
    /Symlinked/,
  );
});
test("boundary parent replacement is detected before activation, preserving original and cleanup failures", async (t) => {
  const f = await fixture(t);
  await installApp(f);
  const displaced = join(f.base, "displaced");
  let error;
  try {
    await installApp({
      ...f,
      version: "2.0",
      beforeActivate: async () => {
        await rename(f.installRoot, displaced);
        await mkdir(f.installRoot, { mode: 0o700 });
        await writeFile(
          join(f.installRoot, ".tmux-gpui-install.json"),
          await readFile(join(displaced, ".tmux-gpui-install.json")),
        );
        await mkdir(join(f.installRoot, "versions"), { mode: 0o700 });
      },
    });
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof AggregateError);
  const messages = [];
  const visit = (e) => {
    messages.push(e.message);
    if (e.errors) e.errors.forEach(visit);
  };
  visit(error);
  assert.ok(messages.some((m) => m.includes("identity changed; mutation refused")));
  assert.ok(messages.some((m) => m.includes("cleanup refused")));
  assert.ok(messages.some((m) => m.includes("Lock ownership changed")));
  assert.deepEqual(await readdir(join(f.installRoot, "versions")), []);
  assert.equal(await readlink(join(displaced, "current")), "versions/1.0/TmuxIDE.app");
});
test("stable named launch alias survives upgrade/rollback and detach retains versions", async (t) => {
  const f = await fixture(t);
  const first = await installApp(f);
  assert.equal(first.launchPath, join(f.installRoot, "TmuxIDE.app"));
  assert.equal(await readlink(first.launchPath), "current");
  const identity = await lstat(first.launchPath);
  assert.equal((await installApp(f)).launchPath, first.launchPath);
  await installApp({ ...f, version: "2.0" });
  assert.equal(
    (await rollbackApp({ installRoot: f.installRoot, verify: f.verify })).launchPath,
    first.launchPath,
  );
  assert.equal((await lstat(first.launchPath)).ino, identity.ino);
  await writeFile(join(f.installRoot, "config"), "keep");
  await uninstallApp({ installRoot: f.installRoot });
  await assert.rejects(lstat(first.launchPath), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.installRoot, "current")), { code: "ENOENT" });
  assert.equal(await content(first.app), "version one");
  assert.equal(await readFile(join(f.installRoot, "config"), "utf8"), "keep");
});
test("foreign launch entries deny all pointer mutations and failed first install leaves no alias", async (t) => {
  const f = await fixture(t);
  await assert.rejects(installApp({ ...f, verify: async () => false }));
  const alias = join(f.installRoot, "TmuxIDE.app");
  await assert.rejects(lstat(alias), { code: "ENOENT" });
  await assert.rejects(
    installApp({
      ...f,
      beforeActivate() {
        throw new Error("boundary");
      },
    }),
    /boundary/,
  );
  await assert.rejects(lstat(alias), { code: "ENOENT" });
  await installApp(f);
  await unlink(alias);
  for (const kind of ["file", "directory", "link"]) {
    if (kind === "file") await writeFile(alias, "foreign");
    else if (kind === "directory") await mkdir(alias);
    else await symlink("foreign", alias);
    const identity = await lstat(alias);
    for (const operation of [
      () => installApp({ ...f, version: "2.0" }),
      () => rollbackApp({ installRoot: f.installRoot, verify: f.verify }),
      () => uninstallApp({ installRoot: f.installRoot }),
    ])
      await assert.rejects(operation(), /foreign launch/);
    assert.equal((await lstat(alias)).ino, identity.ino);
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/1.0/TmuxIDE.app");
    await rm(alias, { recursive: true });
  }
});
test("legacy app layout upgrades and rolls back without migration; suffix mismatch and ambiguity reject", async (t) => {
  const f = await fixture(t);
  await installApp(f);
  const dir = join(f.installRoot, "versions/1.0"),
    recordPath = join(dir, "record.json");
  await rename(join(dir, "TmuxIDE.app"), join(dir, "app"));
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  delete record.bundle;
  await writeFile(recordPath, JSON.stringify(record));
  await unlink(join(f.installRoot, "current"));
  await symlink("versions/1.0/app", join(f.installRoot, "current"));
  await unlink(join(f.installRoot, "TmuxIDE.app"));
  const repeat = await installApp(f);
  assert.equal(repeat.app, join(dir, "app"));
  await installApp({ ...f, version: "2.0" });
  await rollbackApp({ installRoot: f.installRoot, verify: f.verify });
  assert.equal(await readlink(join(f.installRoot, "current")), "versions/1.0/app");
  assert.equal(await content(repeat.launchPath), "version one");
  await unlink(join(f.installRoot, "current"));
  await symlink("versions/1.0/TmuxIDE.app", join(f.installRoot, "current"));
  await assert.rejects(installApp({ ...f, version: "3.0" }), /suffix mismatch/);
  await unlink(join(f.installRoot, "current"));
  await symlink("versions/1.0/app", join(f.installRoot, "current"));
  await mkdir(join(dir, "TmuxIDE.app"));
  await assert.rejects(installApp({ ...f, version: "3.0" }), /Unrecognized/);
});
test("repeat restoring a missing launch alias respects the preactivation guard", async (t) => {
  const f = await fixture(t);
  await installApp(f);
  const alias = join(f.installRoot, "TmuxIDE.app");
  await unlink(alias);
  const currentPath = join(f.installRoot, "current");
  const before = await lstat(currentPath);
  const sentinel = new Error("repeat activation denied");
  let called = 0;
  await assert.rejects(
    installApp({
      ...f,
      beforeActivate() {
        called++;
        throw sentinel;
      },
    }),
    (error) => error === sentinel,
  );
  assert.equal(called, 1);
  await assert.rejects(lstat(alias), { code: "ENOENT" });
  assert.equal((await lstat(currentPath)).ino, before.ino);
  assert.equal(await readlink(currentPath), "versions/1.0/TmuxIDE.app");
  assert.deepEqual(await readdir(join(f.installRoot, "versions")), ["1.0"]);
});
