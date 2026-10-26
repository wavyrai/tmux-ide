// Opt-in real installed CLI qualification of Rust-managed first-run bootstrap.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, chmod, symlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
process.umask(0o077);
const run = promisify(execFile);
const [repo, tmux, testBinary, output] = process.argv.slice(2);
assert.equal(process.platform, "darwin");
assert([repo, tmux, testBinary, output].every((p) => p && isAbsolute(p)));
await mkdir(output, { mode: 0o700 });
for (const key of Object.keys(process.env))
  if (
    key.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key)
  )
    delete process.env[key];
process.env.PATH = dirname(tmux) + ":" + (process.env.PATH ?? "");
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const { createScratchFleet } = await load("scripts/lib/product-fixtures/scratch-fleet.ts");
const { createMacProcessIdentity } = await load("scripts/lib/owned-ssh-fixture.mjs");
let fleet,
  kernel,
  cli,
  node,
  began,
  passed = false,
  daemonRetired = false;
const allocations = [];
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
try {
  kernel = await createMacProcessIdentity({
    parent: output,
    onAllocated: (a) => allocations.push(a),
  });
  fleet = await createScratchFleet({ sessions: 1, windowsPerSession: 1, slug: "native-setup" });
  assert.equal(fleet.environment.TMUX_IDE_TMUX_BIN, tmux);
  const home = await realpath(fleet.environment.HOME);
  const root = join(home, ".local/share/tmux-ide");
  const release = join(root, "releases/install-Owned1");
  await mkdir(join(release, "node/bin"), { recursive: true });
  const pack = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", output],
    { cwd: repo, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  const tarball = JSON.parse(pack.stdout)[0].filename;
  assert.equal(dirname(tarball), ".");
  const install = await run(
    "npm",
    [
      "install",
      "--prefix",
      join(release, "npm"),
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(output, tarball),
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  await writeFile(join(output, "install.log"), install.stdout + install.stderr);
  node = join(release, "node/bin/node");
  cli = join(release, "npm/node_modules/tmux-ide/bin/cli.js");
  // npm's prefix layout is node_modules; the managed installer uses lib/node_modules.
  await mkdir(join(release, "npm/lib"));
  const { rename } = await import("node:fs/promises");
  await rename(join(release, "npm/node_modules"), join(release, "npm/lib/node_modules"));
  cli = join(release, "npm/lib/node_modules/tmux-ide/bin/cli.js");
  await copyFile(process.execPath, node);
  await chmod(node, 0o700);
  await writeFile(join(root, "installer-v1"), "1\n");
  await writeFile(join(release, ".installer-release-v1"), "1\n");
  await symlink("releases/install-Owned1", join(root, "current"));
  const artifacts = {};
  for (const [name, path] of Object.entries({
    node,
    cli,
    testBinary,
    tarball: join(output, tarball),
  }))
    artifacts[name] = {
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    };
  await save("artifacts.json", artifacts);
  const before = fleet.captureWindowPanes(fleet.sessionNames[0]);
  began = Math.floor(Date.now() / 1000);
  const result = await run(
    testBinary,
    ["owned_managed_install_bootstrap_and_reuse", "--ignored", "--nocapture", "--test-threads=1"],
    {
      env: {
        ...process.env,
        ...fleet.environment,
        HOME: home,
        TMUX_IDE_LOCAL_SETUP_FIXTURE: "owned",
      },
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  await writeFile(join(output, "test.log"), result.stdout + result.stderr);
  assert(result.stdout.includes("test result: ok. 1 passed; 0 failed;"));
  assert.equal(fleet.captureWindowPanes(fleet.sessionNames[0]), before);
  passed = true;
} catch (error) {
  await writeFile(
    join(output, "failure.log"),
    String(error) + "\n" + (error.stdout ?? "") + (error.stderr ?? ""),
  );
  process.exitCode = 1;
} finally {
  const cleanup = [];
  try {
    if (fleet && began) {
      const record = JSON.parse(await readFile(join(fleet.daemonInfoDir, "daemon.json"), "utf8"));
      assert(Number.isSafeInteger(record.pid) && record.pid > 0);
      const identity = await kernel.identify(record.pid);
      if (identity) {
        assert(Number(identity.split(":")[3]) >= began);
        const command = (
          await run("/bin/ps", ["-p", String(record.pid), "-o", "args="], { timeout: 2000 })
        ).stdout.trim();
        assert.equal(command, `${node} ${cli} --headless --json`);
        assert.equal(await kernel.identify(record.pid), identity);
        process.kill(record.pid, "SIGTERM");
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && (await kernel.identify(record.pid)) === identity)
          await delay(100);
        assert.notEqual(await kernel.identify(record.pid), identity, "owned daemon did not exit");
      }
    }
    daemonRetired = true;
    cleanup.push({ name: "daemon", ok: true });
  } catch (error) {
    cleanup.push({ name: "daemon", ok: false, error: String(error) });
    process.exitCode = 1;
  }
  if (daemonRetired) {
    try {
      await fleet?.dispose();
      cleanup.push({ name: "fleet", ok: true });
    } catch (error) {
      cleanup.push({ name: "fleet", ok: false, error: String(error) });
      process.exitCode = 1;
    }
  }
  for (const allocation of allocations.reverse()) await allocation.disposeFiles();
  await save("receipt.json", {
    passed,
    daemonRetired,
    cleanup,
    physicalGuiTested: false,
    fixtureRoot: fleet?.root,
  });
}
