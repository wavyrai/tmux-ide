/** Opt-in real build acceptance. Takes two prepared worktrees, a private store, and pinned Bun. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveDevelopmentInstance } from "../../packages/daemon/src/lib/development-instance.ts";
import { buildDevelopmentInstance } from "../../packages/daemon/src/lib/development-build-manager.ts";
import {
  readDevelopmentBuild,
  developmentBuildLaunch,
  verifyDevelopmentBuild,
} from "../../packages/daemon/src/lib/development-build.ts";
import { developmentNamespaceEnvironment } from "../../packages/daemon/src/lib/runtime-namespace.ts";
const [first, second, store, bun] = process.argv.slice(2);
if (!first || !second || !store || !bun)
  throw new Error("Expected first-worktree second-worktree private-store absolute-bun");
const instances = [first, second].map((worktree) =>
  resolveDevelopmentInstance({ worktree, store }),
);
assert.notEqual(instances[0]!.id, instances[1]!.id);
const started = performance.now();
const outcomes = await Promise.allSettled(
  instances.map((instance) => buildDevelopmentInstance(instance, { bun })),
);
const builds = outcomes.map((outcome) => {
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
});
assert.throws(() => verifyDevelopmentBuild(instances[0]!, builds[1]), /another instance/);
const firstInstance = instances[0]!;
const original = builds[0]!;
const oldPin = developmentBuildLaunch(original).environment;
const pointer = readFileSync(join(firstInstance.root, "build.json"), "utf8");
await assert.rejects(
  buildDevelopmentInstance(firstInstance, {
    bun,
    beforePublish: () => {
      throw new Error("injected publication failure");
    },
  }),
  /injected publication/,
);
assert.equal(readFileSync(join(firstInstance.root, "build.json"), "utf8"), pointer);
assert.equal(readDevelopmentBuild(firstInstance, {}).generation, original.generation);
const raceInput = join(firstInstance.worktree, "scripts", "d03-source-race-fixture.ts");
try {
  await assert.rejects(
    buildDevelopmentInstance(firstInstance, {
      bun,
      beforePublish: () => {
        writeFileSync(raceInput, "export const changed = true;\n", { flag: "wx" });
      },
    }),
    /Worktree changed before publication/,
  );
} finally {
  rmSync(raceInput, { force: true });
}
assert.equal(readFileSync(join(firstInstance.root, "build.json"), "utf8"), pointer);

const replacement = await buildDevelopmentInstance(firstInstance, { bun });
assert.notEqual(replacement.generation, original.generation);
assert.equal(readDevelopmentBuild(firstInstance, oldPin).generation, original.generation);
assert.equal(readDevelopmentBuild(firstInstance, {}).generation, replacement.generation);
const selectedAt = performance.now();
readDevelopmentBuild(firstInstance, oldPin);
const selectionMs = performance.now() - selectedAt;
for (let index = 0; index < instances.length; index++) {
  const instance = instances[index]!;
  const build = builds[index]!;
  const env = {
    ...process.env,
    ...developmentNamespaceEnvironment(instance, "qualification-private-capability-1234"),
    ...developmentBuildLaunch(build).environment,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  assert.match(
    execFileSync(build.tools.node, [build.cli, "--version"], {
      cwd: instance.root,
      env,
      encoding: "utf8",
      timeout: 10000,
    }),
    new RegExp(build.packageVersion.replaceAll(".", "\\.")),
  );
  const provenance = JSON.parse(
    execFileSync(build.tui, ["__release-provenance"], {
      cwd: instance.root,
      env,
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  assert.equal(provenance.commit, build.source.commit);
  const nativeModule = new URL("../../packages/daemon/src/lib/bundled-tmux.ts", import.meta.url)
    .href;
  const nativePath = execFileSync(
    build.tools.node,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import {resolveBundledTmux} from ${JSON.stringify(nativeModule)};console.log(resolveBundledTmux());`,
    ],
    { cwd: instance.root, env, encoding: "utf8", timeout: 10000 },
  ).trim();
  assert.equal(
    nativePath,
    join(build.assets, "tmux", `${process.platform}-${process.arch}`, "tmux"),
  );
  assert.match(
    execFileSync(nativePath, ["-V"], { cwd: instance.root, env, encoding: "utf8", timeout: 10000 }),
    /tmux/,
  );
  const buildModule = new URL("../../packages/daemon/src/lib/development-build.ts", import.meta.url)
    .href;
  const selected = execFileSync(
    bun,
    [
      "--eval",
      `import {readDevelopmentBuild} from ${JSON.stringify(buildModule)};console.log(readDevelopmentBuild(${JSON.stringify(instance)}).generation);`,
    ],
    { cwd: instance.root, env, encoding: "utf8", timeout: 10000 },
  ).trim();
  assert.equal(selected, build.generation);
}
const receipt = {
  ok: true,
  elapsedMs: performance.now() - started,
  selectionMs,
  maxRSSKiB: process.resourceUsage().maxRSS,
  instances: instances.map((i) => ({ id: i.id, worktree: i.worktree, root: i.root })),
  builds: builds.map((b) => ({
    generation: b.generation,
    source: b.source,
    host: b.host,
    cli: b.cli,
    tui: b.tui,
    qualification: b.qualification,
  })),
  replacement: replacement.generation,
  failedPublicationRetained: true,
  changedSourceRejected: true,
  nativeBundleResolutionVerified: true,
  bunRuntimeSelectorVerified: true,
  oldPinRetained: true,
};
writeFileSync(join(store, "qualification.json"), JSON.stringify(receipt, null, 2));
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
