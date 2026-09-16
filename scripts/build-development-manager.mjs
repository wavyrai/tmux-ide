import { build } from "esbuild";
import { dirname, join, resolve, relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { cliBundlePlugins } from "./lib/cli-bundle-policy.mjs";
import {
  publishManager,
  managerInputs,
  validateManagerStage,
  sourceSnapshot,
} from "./lib/development-manager-cache.mjs";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [stage, digest] = process.argv.slice(2);
if (!stage || !/^[a-f0-9]{64}$/.test(digest))
  throw new Error("Use the development manager bootstrap");
validateManagerStage(root, stage);
if (sourceSnapshot(root).digest !== digest)
  throw new Error("Manager source changed before compilation");
const options = {
  absWorkingDir: root,
  entryPoints: [join(root, "scripts/development-instance.ts")],
  outfile: join(stage, "manager.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  metafile: true,
  plugins: cliBundlePlugins(),
  logLevel: "warning",
};
// Discover the input closure, then fence the actual publication build against it.
const discovered = await build(options);
const snapshot = sourceSnapshot(root);
const tracked = new Set(snapshot.files);
for (const input of Object.keys(discovered.metafile.inputs)) {
  if (!tracked.has(relative(root, resolve(root, input))))
    throw new Error(
      "Unsupported manager source root: bundled inputs must belong to the tracked scripts/package-source/config inventory",
    );
}
const visited = new Set();
function verifyConfig(path) {
  if (visited.has(path)) return;
  if (visited.size >= 64 || !tracked.has(relative(root, path)))
    throw new Error(
      "Manager tsconfig inheritance must remain in the tracked worktree source/config inventory",
    );
  visited.add(path);
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) throw new Error("Invalid manager tsconfig");
  const inherited = parsed.config.extends;
  for (const name of typeof inherited === "string"
    ? [inherited]
    : Array.isArray(inherited)
      ? inherited
      : []) {
    let next =
      name.startsWith(".") || name.startsWith("/")
        ? resolve(dirname(path), name)
        : createRequire(path).resolve(name);
    if (!existsSync(next) && existsSync(next + ".json")) next += ".json";
    verifyConfig(next);
  }
}
for (const input of Object.keys(discovered.metafile.inputs)) {
  let folder = dirname(resolve(root, input));
  while (folder.startsWith(root)) {
    if (existsSync(join(folder, "tsconfig.json"))) {
      verifyConfig(join(folder, "tsconfig.json"));
      break;
    }
    if (folder === root) break;
    folder = dirname(folder);
  }
}
const before = managerInputs(root, discovered.metafile);
const result = await build(options);
if (JSON.stringify(before) !== JSON.stringify(managerInputs(root, result.metafile)))
  throw new Error("Manager inputs changed during compilation");
publishManager(root, stage, digest, result.metafile);
