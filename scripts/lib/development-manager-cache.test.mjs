import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  ensureManager,
  managerCache,
  managerCompiler,
  readManifest,
  sourceSnapshot,
  pinBundle,
} from "./development-manager-cache.mjs";
const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../..");
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "manager source space ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of [
    "scripts/lib",
    "packages/contracts/src",
    "node_modules/esbuild",
    `node_modules/@esbuild/${process.platform}-${process.arch}`,
  ])
    mkdirSync(join(root, dir), { recursive: true });
  for (const path of [
    "scripts/development-instance.mjs",
    "scripts/build-development-manager.mjs",
    "scripts/lib/development-manager-cache.mjs",
    "scripts/lib/cli-bundle-policy.mjs",
    "scripts/lib/contracts-initializer-purity.mjs",
  ])
    cpSync(join(repo, path), join(root, path));
  const compiler = managerCompiler(repo);
  cpSync(resolve(compiler.packagePath, ".."), join(root, "node_modules/esbuild"), {
    recursive: true,
  });
  const nativePackage = createRequire(compiler.packagePath).resolve(
    `@esbuild/${process.platform}-${process.arch}/package.json`,
  );
  cpSync(
    resolve(nativePackage, ".."),
    join(root, `node_modules/@esbuild/${process.platform}-${process.arch}`),
    { recursive: true },
  );
  cpSync(resolve(compiler.typescriptPackage, ".."), join(root, "node_modules/typescript"), {
    recursive: true,
  });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tmux-ide", type: "module" }));
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(root, "scripts/value.js"), "export default 'one';\n");
  writeFileSync(
    join(root, "scripts/development-instance.ts"),
    "import value from './value'; console.log(JSON.stringify({value,args:process.argv.slice(2),pid:process.pid}));\n",
  );
  return root;
}
const run = async (root, args = []) =>
  JSON.parse(
    (
      await exec(process.execPath, [join(root, "scripts/development-instance.mjs"), ...args], {
        cwd: root,
        timeout: 15000,
      })
    ).stdout,
  );
const generations = (root) => readdirSync(join(managerCache(root), "generations"));
test("warm entry preserves arguments and invalidates source, resolution, lock, config and compiler", async (t) => {
  const root = fixture(t);
  assert.equal((await run(root, ["hello world", "--json"])).args[0], "hello world");
  const first = generations(root)[0];
  await run(root);
  assert.deepEqual(generations(root), [first]);
  writeFileSync(join(root, "scripts/value.ts"), "export default 'two';\n");
  assert.equal((await run(root)).value, "two");
  for (const [path, content] of [
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n# change\n"],
    ["tsconfig.json", '{"compilerOptions":{"target":"ES2022"}}'],
    [
      "node_modules/esbuild/package.json",
      readFileSync(join(root, "node_modules/esbuild/package.json"), "utf8") + "\n",
    ],
  ]) {
    const before = sourceSnapshot(root).digest;
    writeFileSync(join(root, path), content);
    assert.notEqual(sourceSnapshot(root).digest, before);
    assert.equal((await run(root)).value, "two");
  }
  assert(generations(root).length <= 2);
  assert.equal(readdirSync(join(managerCache(root), "runs")).length, 0);
});
test("concurrent cold publication and aliases select a complete manager", async (t) => {
  const root = fixture(t),
    alias = `${root}-alias`;
  symlinkSync(root, alias);
  t.after(() => rmSync(alias));
  const results = await Promise.all([run(root), run(alias), run(root)]);
  assert(results.every((r) => r.value === "one"));
  assert.equal(generations(root).length, 1);
  assert.equal(readdirSync(join(managerCache(root), "staging")).length, 0);
});
test("pinned bytes remain importable after concurrent generation pruning", async (t) => {
  const root = fixture(t),
    pin = await ensureManager(root);
  t.after(pin.release);
  for (const value of ["two", "three"]) {
    writeFileSync(join(root, "scripts/value.js"), `export default '${value}';\n`);
    assert.equal((await run(root)).value, value);
  }
  assert.equal(JSON.parse((await exec(process.execPath, [pin.path])).stdout).value, "one");
});
test("bundle swap after manifest selection is rejected before execution", async (t) => {
  const root = fixture(t);
  await run(root);
  const cache = managerCache(root),
    manifest = readManifest(root, cache, sourceSnapshot(root).digest);
  writeFileSync(join(manifest.dir, "manager.mjs"), "throw new Error('untrusted');");
  assert.throws(() => pinBundle(cache, manifest), /changed during selection/);
  assert.equal(readdirSync(join(cache, "runs")).length, 0);
});
test("source build failure never reuses last cached code", async (t) => {
  const root = fixture(t);
  await run(root);
  writeFileSync(join(root, "scripts/value.js"), "syntax error !!!");
  await assert.rejects(
    run(root, ["--json"]),
    (error) =>
      error.code === 1 && JSON.parse(error.stdout).code === "DEVELOPMENT_MANAGER_UNAVAILABLE",
  );
});
test("cache symlink escape is refused before writes", (t) => {
  const root = fixture(t),
    outside = mkdtempSync(join(tmpdir(), "manager-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(root, "node_modules/.cache"));
  symlinkSync(outside, join(root, "node_modules/.cache/tmux-ide-manager"));
  assert.throws(() => managerCache(root), /private owned|escapes/);
  assert.deepEqual(readdirSync(outside), []);
});
test("cold compiler SIGTERM preserves exit143 and removes its reservation", async (t) => {
  const root = fixture(t),
    builder = join(root, "scripts/build-development-manager.mjs");
  writeFileSync(
    builder,
    "import {writeFileSync as mark} from 'node:fs'; mark(process.cwd()+'/compiler-started','yes'); await new Promise(r=>setTimeout(r,10000));\n" +
      readFileSync(builder, "utf8"),
  );
  const child = spawn(
    process.execPath,
    [join(root, "scripts/development-instance.mjs"), "--json"],
    { stdio: "ignore" },
  );
  const completion = new Promise((resolvePromise, reject) => {
    child.once("exit", (code) => resolvePromise(code));
    child.once("error", reject);
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(join(root, "compiler-started")))
    await new Promise((r) => setTimeout(r, 20));
  assert(existsSync(join(root, "compiler-started")));
  child.kill("SIGTERM");
  assert.equal(await completion, 143);
  assert.equal(readdirSync(join(managerCache(root), "staging")).length, 0);
});

test("manager argument failures retain execution errors instead of cache errors", async (t) => {
  const root = fixture(t);
  writeFileSync(
    join(root, "scripts/development-instance.ts"),
    "import {parseArgs} from 'node:util'; parseArgs({options:{json:{type:'boolean'}}});",
  );
  await assert.rejects(
    run(root, ["--invalid", "--json"]),
    (error) =>
      error.code === 1 &&
      error.stderr.includes("ERR_PARSE_ARGS_UNKNOWN_OPTION") &&
      !error.stdout.includes("DEVELOPMENT_MANAGER_UNAVAILABLE"),
  );
  assert.equal(readdirSync(join(managerCache(root), "runs")).length, 0);
});
test("retargeting an existing workspace alias invalidates otherwise unchanged source", async (t) => {
  const root = fixture(t);
  for (const name of ["first", "second"]) {
    mkdirSync(join(root, `packages/${name}/src`), { recursive: true });
    writeFileSync(
      join(root, `packages/${name}/package.json`),
      JSON.stringify({ name: "@tmux-ide/fixture", type: "module", exports: "./src/index.ts" }),
    );
    writeFileSync(join(root, `packages/${name}/src/index.ts`), `export default '${name}';`);
  }
  mkdirSync(join(root, "node_modules/@tmux-ide"));
  const alias = join(root, "node_modules/@tmux-ide/fixture");
  symlinkSync(join(root, "packages/first"), alias);
  writeFileSync(
    join(root, "scripts/development-instance.ts"),
    "import value from '@tmux-ide/fixture';console.log(JSON.stringify({value}));",
  );
  assert.equal((await run(root)).value, "first");
  const before = sourceSnapshot(root).digest;
  unlinkSync(alias);
  symlinkSync(join(root, "packages/second"), alias);
  assert.notEqual(sourceSnapshot(root).digest, before);
  assert.equal((await run(root)).value, "second");
});

test("concurrent pruning tolerates only already-removed generation entries", async (t) => {
  const root = fixture(t),
    cache = managerCache(root);
  for (let n = 0; n < 40; n++)
    mkdirSync(join(cache, "generations", n.toString(16).padStart(64, "0")), { mode: 0o700 });
  await Promise.all(
    Array.from({ length: 6 }, () =>
      exec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const {pruneCache}=await import(process.argv[1]); for(let n=0;n<30;n++)pruneCache(process.argv[2]);",
          new URL("./development-manager-cache.mjs", import.meta.url).href,
          cache,
        ],
        { timeout: 10000 },
      ),
    ),
  );
  assert(readdirSync(join(cache, "generations")).length <= 2);
});

test("untracked source roots fail closed instead of caching incomplete resolution freshness", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "custom"));
  writeFileSync(join(root, "custom/value.js"), "export default 'uncaptured';");
  writeFileSync(
    join(root, "scripts/development-instance.ts"),
    "import value from '../custom/value'; console.log(JSON.stringify({value}));",
  );
  await assert.rejects(
    run(root, ["--json"]),
    (error) =>
      error.code === 1 &&
      error.stderr.includes("Unsupported manager source root") &&
      JSON.parse(error.stdout).code === "DEVELOPMENT_MANAGER_UNAVAILABLE",
  );
  assert.equal(generations(root).length, 0);
});
