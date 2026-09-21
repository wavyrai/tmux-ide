/** Development-only source cache. No compiler is imported by the warm launcher. */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  linkSync,
  readlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_RUNS = 32;
const MAX_STAGING = 4;
const own = process.getuid?.();
const hashBuffer = Buffer.allocUnsafe(64 * 1024);
export function hashFile(path, budget = { bytes: 0 }) {
  const fd = openSync(path, "r");
  try {
    const buffer = hashBuffer;
    const hash = createHash("sha256");
    let size = 0,
      count;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      size += count;
      budget.bytes += count;
      if (size > MAX_FILE || budget.bytes > MAX_TOTAL)
        throw new Error("Manager input exceeds byte budget");
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
function inside(root, path) {
  const rel = relative(root, realpathSync(path));
  if (rel.startsWith(`..${sep}`) || rel === "..")
    throw new Error("Manager input escapes its worktree");
  return rel;
}
function regular(path, max = MAX_FILE) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > max)
    throw new Error("Manager cache requires bounded regular files");
  return stat;
}
export function managerCompiler(root) {
  const require = createRequire(join(root, "package.json"));
  const entry = require.resolve("esbuild");
  const packagePath = require.resolve("esbuild/package.json");
  const binary = createRequire(packagePath).resolve(
    `@esbuild/${process.platform}-${process.arch}/bin/esbuild`,
  );
  const typescript = require.resolve("typescript");
  const typescriptPackage = require.resolve("typescript/package.json");
  for (const path of [entry, packagePath, binary, typescript, typescriptPackage])
    inside(root, path);
  return {
    entry: realpathSync(entry),
    packagePath: realpathSync(packagePath),
    binary: realpathSync(binary),
    typescript: realpathSync(typescript),
    typescriptPackage: realpathSync(typescriptPackage),
  };
}
export function sourceSnapshot(root) {
  const paths = new Set();
  const resolutions = new Map();
  const inspectModules = (folder) => {
    if (!existsSync(folder)) return;
    const inspect = (path) => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let target;
        try {
          target = realpathSync(path);
        } catch {
          target = readlinkSync(path);
        }
        resolutions.set(relative(root, path), target);
      } else if (stat.isDirectory() && path.split(sep).at(-1).startsWith("@")) {
        for (const name of readdirSync(path).sort()) inspect(join(path, name));
      } else if (stat.isDirectory()) resolutions.set(relative(root, path), realpathSync(path));
      if (resolutions.size > MAX_FILES)
        throw new Error("Manager resolution inventory exceeds budget");
    };
    for (const name of readdirSync(folder).sort())
      if (!name.startsWith(".")) inspect(join(folder, name));
  };
  inspectModules(join(root, "node_modules"));
  const visit = (path) => {
    const stat = lstatSync(path);
    inside(root, path);
    if (stat.isSymbolicLink())
      throw new Error("Manager source symlinks require an explicit real worktree input");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name === "node_modules") {
          inspectModules(join(path, name));
          continue;
        }
        if (["dist", ".git", ".next", ".turbo"].includes(name)) continue;
        visit(join(path, name));
      }
    } else if (stat.isFile() && /\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(path)) {
      paths.add(relative(root, path));
      if (paths.size > MAX_FILES) throw new Error("Manager source exceeds file budget");
    }
  };
  visit(join(root, "scripts"));
  for (const name of readdirSync(join(root, "packages")).sort()) {
    const folder = join(root, "packages", name);
    if (!lstatSync(folder).isDirectory()) continue;
    inspectModules(join(folder, "node_modules"));
    if (existsSync(join(folder, "src"))) visit(join(folder, "src"));
    for (const file of readdirSync(folder))
      if (/\.json$/.test(file)) paths.add(relative(root, join(folder, file)));
  }
  for (const file of readdirSync(root))
    if (
      ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".bun-version"].includes(
        file,
      ) ||
      /\.json$/.test(file)
    )
      paths.add(file);
  const compiler = managerCompiler(root);
  for (const path of Object.values(compiler)) paths.add(relative(root, path));
  const budget = { bytes: 0 };
  const files = [...paths].sort().map((path) => {
    const full = join(root, path);
    inside(root, full);
    regular(full);
    return [path, hashFile(full, budget)];
  });
  return {
    digest: createHash("sha256")
      .update(
        JSON.stringify({
          root,
          files,
          resolutions: [...resolutions].sort(([a], [b]) => a.localeCompare(b)),
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        }),
      )
      .digest("hex"),
    compiler,
    files: files.map(([path]) => path),
  };
}
function directory(path) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== own || (stat.mode & 0o077) !== 0)
    throw new Error("Manager cache must be a private owned directory");
}
export function managerCache(root) {
  // Resolve every pre-existing ancestor before any cache writes.
  inside(root, join(root, "node_modules"));
  const base = join(root, "node_modules", ".cache");
  try {
    mkdirSync(base, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  inside(root, base);
  if (!lstatSync(base).isDirectory()) throw new Error("Manager cache ancestor must be a directory");
  const cache = join(base, "tmux-ide-manager");
  directory(cache);
  for (const name of ["generations", "runs", "staging"]) directory(join(cache, name));
  return cache;
}
function dead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
export function pruneCache(cache) {
  for (const folder of ["runs", "staging"]) {
    for (const name of readdirSync(join(cache, folder))) {
      const match = /^(\d+)-[a-f0-9-]{36}(?:\.mjs)?$/.exec(name);
      if (match && dead(Number(match[1])))
        rmSync(join(cache, folder, name), { recursive: true, force: true });
    }
  }
  const generations = readdirSync(join(cache, "generations"))
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .flatMap((name) => {
      try {
        return [{ name, time: lstatSync(join(cache, "generations", name)).mtimeMs }];
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    })
    .sort((a, b) => b.time - a.time);
  for (const entry of generations.slice(2))
    rmSync(join(cache, "generations", entry.name), { recursive: true, force: true });
}
export function readManifest(root, cache, digest) {
  try {
    const dir = join(cache, "generations", digest);
    if (!/^[a-f0-9]{64}$/.test(digest)) return null;
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== own || (stat.mode & 0o077) !== 0) return null;
    const path = join(dir, "manifest.json");
    regular(path, 1024 * 1024);
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value.version !== 1 ||
      value.root !== root ||
      value.digest !== digest ||
      !/^[a-f0-9]{64}$/.test(value.bundleHash) ||
      !Array.isArray(value.inputs) ||
      value.inputs.length > MAX_FILES
    )
      return null;
    const budget = { bytes: 0 };
    for (const [input, hash] of value.inputs) {
      if (
        typeof input !== "string" ||
        resolve(root, input) !== join(root, input) ||
        input.startsWith("..") ||
        typeof hash !== "string"
      )
        return null;
      const full = join(root, input);
      inside(root, full);
      regular(full);
      if (hashFile(full, budget) !== hash) return null;
    }
    regular(join(dir, "manager.mjs"));
    if (hashFile(join(dir, "manager.mjs")) !== value.bundleHash) return null;
    return { ...value, dir };
  } catch {
    return null;
  }
}
export function pinBundle(cache, manifest) {
  pruneCache(cache);
  if (readdirSync(join(cache, "runs")).length >= MAX_RUNS)
    throw new Error("Manager cache has too many live or unverified launch pins");
  const path = join(cache, "runs", `${process.pid}-${randomUUID()}.mjs`);
  linkSync(join(manifest.dir, "manager.mjs"), path);
  try {
    if (readdirSync(join(cache, "runs")).length > MAX_RUNS)
      throw new Error("Manager launch pin capacity reached");
    regular(path);
    if (hashFile(path) !== manifest.bundleHash)
      throw new Error("Manager bundle changed during selection");
  } catch (error) {
    rmSync(path);
    throw error;
  }
  return { path, release: () => rmSync(path, { force: true }) };
}
export async function ensureManager(root) {
  root = realpathSync(root);
  const cache = managerCache(root);
  pruneCache(cache);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = sourceSnapshot(root);
    let manifest = readManifest(root, cache, snapshot.digest);
    if (!manifest) {
      if (readdirSync(join(cache, "staging")).length >= MAX_STAGING)
        throw new Error("Manager compiler concurrency limit reached; wait for the active builds");
      const stage = join(cache, "staging", `${process.pid}-${randomUUID()}`);
      directory(stage);
      try {
        if (readdirSync(join(cache, "staging")).length > MAX_STAGING)
          throw new Error("Manager compiler capacity reached");
        await new Promise((resolvePromise, reject) => {
          const child = spawn(
            process.execPath,
            [join(root, "scripts", "build-development-manager.mjs"), stage, snapshot.digest],
            {
              cwd: root,
              stdio: ["ignore", "ignore", "inherit"],
              env: { ...process.env, ESBUILD_BINARY_PATH: snapshot.compiler.binary },
            },
          );
          let interrupted;
          let finished = false;
          const signals = ["SIGINT", "SIGTERM"].map((signal) => {
            const forward = () => {
              interrupted = signal;
              child.kill(signal);
            };
            process.on(signal, forward);
            return [signal, forward];
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
          const finish = (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            for (const [signal, listener] of signals) process.off(signal, listener);
            error ? reject(error) : resolvePromise();
          };
          child.once("error", finish);
          child.once("exit", (code) => {
            if (interrupted) {
              const error = new Error("Development manager compilation interrupted");
              error.exitCode = interrupted === "SIGINT" ? 130 : 143;
              finish(error);
            } else
              finish(
                code === 0
                  ? null
                  : new Error(
                      "Development manager compilation failed; check source and frozen dependencies",
                    ),
              );
          });
        });
        manifest = readManifest(root, cache, snapshot.digest);
        if (!manifest)
          throw new Error("Manager source changed during compilation; retry the command");
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    try {
      return pinBundle(cache, manifest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("Manager cache changed repeatedly during selection; retry the command");
}
export function publishManager(root, stage, digest, metafile) {
  if (sourceSnapshot(root).digest !== digest)
    throw new Error("Manager source changed while compiling");
  const inputs = managerInputs(root, metafile);
  const bundleHash = hashFile(join(stage, "manager.mjs"));
  writeFileSync(
    join(stage, "manifest.json"),
    JSON.stringify({ version: 1, root, digest, inputs, bundleHash }),
    { mode: 0o600, flag: "wx" },
  );
  const cache = dirname(dirname(stage));
  const target = join(cache, "generations", digest);
  try {
    renameSync(stage, target);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !readManifest(root, cache, digest))
      throw error;
  }
}

export function managerInputs(root, metafile) {
  const names = Object.keys(metafile.inputs).sort();
  if (names.length > MAX_FILES) throw new Error("Manager compiler input count exceeds budget");
  const budget = { bytes: 0 };
  return names.map((input) => {
    const full = resolve(root, input);
    inside(root, full);
    regular(full);
    return [relative(root, full), hashFile(full, budget)];
  });
}
export function validateManagerStage(root, stage) {
  const cache = managerCache(root);
  if (
    dirname(stage) !== join(cache, "staging") ||
    !/^\d+-[a-f0-9-]{36}$/.test(stage.split(sep).at(-1))
  )
    throw new Error("Use the worktree development manager bootstrap");
  const stat = lstatSync(stage);
  if (!stat.isDirectory() || stat.uid !== own || (stat.mode & 0o077) !== 0)
    throw new Error("Manager compilation staging must be private");
}
