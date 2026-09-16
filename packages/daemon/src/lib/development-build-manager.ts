import { withDevelopmentLock } from "./development-lock.ts";
import { validateBundledTmux } from "./bundled-tmux.ts";
/** Explicit build boundary. Runtime selection imports development-build.ts instead. */
import { execFile } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  discoverDevelopmentWorktree,
  validateDevelopmentDirectory,
  type DevelopmentInstance,
} from "./development-instance.ts";
import {
  developmentFileHash,
  developmentTreeHash,
  verifyDevelopmentBuild,
  type DevelopmentBuildManifest,
} from "./development-build.ts";

const execute = promisify(execFile);
async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  raw = false,
) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("TMUX_IDE_") &&
        !key.startsWith("GIT_") &&
        !["TMUX", "TMUX_PANE", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key),
    ),
  );
  const result = await execute(executable, [...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 5 * 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  return raw ? result.stdout : result.stdout.trim();
}

/** Hash all Git-visible build inputs (including relevant untracked files), not mutable outputs. */
export async function developmentSourceSnapshot(worktree: string, signal?: AbortSignal) {
  worktree = realpathSync(worktree);
  const commit = await command("git", ["rev-parse", "HEAD"], worktree, signal);
  const names = (
    await command(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      worktree,
      signal,
      true,
    )
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) =>
        /^(?:bin\/|packages\/|scripts\/|native\/|templates\/|skill\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|bunfig\.toml$|\.bun-version$|tsconfig[^/]*\.json$)/u.test(
          path,
        ) &&
        !/(?:^|\/)(?:node_modules|dist|\.turbo)(?:\/|$)/u.test(path) &&
        path !== "bin/cli.js",
    )
    .sort();
  const digest = createHash("sha256");
  let bytes = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const path = join(worktree, name);
    if (!existsSync(path)) {
      digest.update(JSON.stringify([name, "deleted"]));
      continue;
    }
    const actual = realpathSync(path);
    if (!actual.startsWith(`${worktree}${sep}`))
      throw new Error(`Source input escapes worktree: ${name}`);
    const info = lstatSync(actual);
    if (!info.isFile() || (bytes += info.size) > 512 * 1024 * 1024)
      throw new Error("Development source budget exceeded");
    digest.update(JSON.stringify([name, info.mode & 0o777, developmentFileHash(actual)]));
  }
  const dirty = Boolean(
    await command("git", ["status", "--porcelain", "--untracked-files=all"], worktree, signal),
  );
  return {
    commit,
    digest: digest.digest("hex"),
    dirty,
    files: names.length,
    lockfileHash: developmentFileHash(join(worktree, "pnpm-lock.yaml")),
  };
}

interface CopyBudget {
  files: number;
  bytes: number;
  signal?: AbortSignal;
}
async function copyTree(source: string, destination: string, budget: CopyBudget): Promise<void> {
  if (budget.files % 64 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  budget.signal?.throwIfAborted();
  if (++budget.files > 100_000) throw new Error("Development copy file budget exceeded");
  const actual = realpathSync(source);
  const info = lstatSync(actual);
  if (info.isDirectory()) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(actual).sort())
      if (name !== "node_modules" && name !== ".git")
        await copyTree(join(actual, name), join(destination, name), budget);
  } else if (info.isFile()) {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    budget.bytes += info.size;
    if (budget.bytes > 1024 * 1024 * 1024) throw new Error("Development copy byte budget exceeded");
    copyFileSync(actual, destination, constants.COPYFILE_FICLONE);
  } else throw new Error(`Unsupported build input: ${source}`);
}

function packageRoot(name: string, from: string, worktree = from): string {
  const require = createRequire(join(from, "package.json"));
  // Follow the explicit worktree install (including pnpm's store links), never
  // Node's global module search paths or a parent/sibling checkout fallback.
  const marker = from.indexOf(`${sep}node_modules${sep}`);
  const boundary = marker < 0 ? worktree : from.slice(0, marker);
  for (const directory of require.resolve.paths(name) ?? []) {
    if (!directory.startsWith(`${boundary}${sep}`)) continue;
    const candidate = join(directory, name, "package.json");
    if (existsSync(candidate)) return dirname(realpathSync(candidate));
  }
  throw new Error(`Missing worktree dependency: ${name}`);
}

/** Copy the resolved external closure, not pnpm links back to mutable worktree packages. */
async function snapshotDependencies(
  worktree: string,
  stage: string,
  external: string[],
  budget: CopyBudget,
) {
  const roots = new Map<string, string>();
  const packages: { name: string; version: string }[] = [];
  const visit = async (source: string): Promise<string> => {
    const old = roots.get(source);
    if (old) return old;
    if (roots.size >= 512) throw new Error("Dependency package budget exceeded");
    const metadata = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const destination = join(
      stage,
      "dependencies",
      createHash("sha256").update(source).digest("hex").slice(0, 24),
    );
    roots.set(source, destination);
    packages.push({ name: metadata.name, version: metadata.version });
    const before = developmentPackageDigest(source);
    await copyTree(source, destination, budget);
    if (before !== developmentPackageDigest(source))
      throw new Error(`Dependency changed during snapshot: ${metadata.name}`);
    for (const [name, optional] of new Map([
      ...Object.keys(metadata.dependencies ?? {}).map((name) => [name, false] as const),
      ...Object.keys(metadata.peerDependencies ?? {}).map((name) => [name, true] as const),
      ...Object.keys(metadata.optionalDependencies ?? {}).map((name) => [name, true] as const),
    ])) {
      let child;
      try {
        child = packageRoot(name, source, worktree);
      } catch (error) {
        if (optional) continue;
        throw error;
      }
      const target = await visit(child);
      const link = join(destination, "node_modules", name);
      mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
      symlinkSync(relative(dirname(link), target), link);
    }
    return destination;
  };
  mkdirSync(join(stage, "dependencies"), { recursive: true, mode: 0o700 });
  for (const specifier of external) {
    if (specifier.startsWith("node:") || builtinModules.includes(specifier)) continue;
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]!;
    let source;
    try {
      source = packageRoot(name, worktree);
    } catch {
      source = packageRoot(name, join(worktree, "packages/daemon"), worktree);
    }
    const target = await visit(source);
    const link = join(stage, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
    if (!existsSync(link)) symlinkSync(relative(dirname(link), target), link);
  }
  return packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}
function developmentPackageDigest(source: string): string {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (path: string): void => {
    if (++files > 50_000) throw new Error("Dependency file budget exceeded");
    const actual = realpathSync(path);
    const info = lstatSync(actual);
    if (info.isDirectory()) {
      for (const name of readdirSync(actual).sort())
        if (name !== "node_modules" && name !== ".git") visit(join(path, name));
    } else {
      if (!info.isFile() || (bytes += info.size) > 512 * 1024 * 1024)
        throw new Error("Dependency byte budget exceeded");
      hash.update(JSON.stringify([relative(source, path), developmentFileHash(actual)]));
    }
  };
  visit(source);
  return hash.digest("hex");
}

/** Older CLIs receive --help as well, so capability probing can never launch their app. */
export function parseDevelopmentCapabilities(
  output: string,
): readonly "managed-development-owner-v1"[] {
  try {
    const value = JSON.parse(output);
    return value?.version === 1 &&
      Array.isArray(value.capabilities) &&
      value.capabilities.includes("managed-development-owner-v1")
      ? ["managed-development-owner-v1"]
      : [];
  } catch {
    return [];
  }
}

export async function buildDevelopmentInstance(
  instance: DevelopmentInstance,
  options: {
    bun: string;
    node?: string;
    signal?: AbortSignal;
    /** Test-only failure injection immediately before publication. */
    beforePublish?: () => void | Promise<void>;
  },
): Promise<DevelopmentBuildManifest> {
  if (discoverDevelopmentWorktree(instance.worktree) !== instance.worktree)
    throw new Error("Build root is not the exact Git worktree");
  return withDevelopmentLock(
    instance,
    "build",
    async () => {
      const source = await developmentSourceSnapshot(instance.worktree, options.signal);
      const node = realpathSync(options.node ?? process.execPath);
      const bun = realpathSync(options.bun);
      if (!isAbsolute(options.bun)) throw new Error("Provide an absolute pinned Bun executable");
      const bunVersion = await command(bun, ["--version"], instance.worktree, options.signal);
      if (bunVersion !== readFileSync(join(instance.worktree, ".bun-version"), "utf8").trim())
        throw new Error("Development build requires the repository's pinned Bun version");
      const nodeInfo = JSON.parse(
        await command(
          node,
          ["-p", "JSON.stringify({version:process.version,abi:process.versions.modules})"],
          instance.worktree,
          options.signal,
        ),
      );
      if (nodeInfo.abi !== process.versions.modules)
        throw new Error("Build manager and selected Node ABI differ");
      const nodeHash = developmentFileHash(node);
      const bunHash = developmentFileHash(bun);
      const generation = `build-${randomUUID()}`;
      const stage = join(instance.root, "artifacts", `.${generation}.stage`);
      const final = join(instance.root, "artifacts", generation);
      validateDevelopmentDirectory(stage, instance.store);
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      let published = false;
      try {
        const cli = join(stage, "bin/cli.js");
        const tui = join(stage, "tui/tmux-ide-tui");
        const metadataPath = join(stage, "esbuild.json");
        await command(
          node,
          [
            join(instance.worktree, "scripts/build-cli.mjs"),
            "--outfile",
            cli,
            "--metafile",
            metadataPath,
          ],
          instance.worktree,
          options.signal,
        );
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        const external = Object.values(
          metadata.outputs as Record<string, { imports: { external: boolean; path: string }[] }>,
        ).flatMap((output) =>
          output.imports.filter((entry) => entry.external).map((entry) => entry.path),
        );
        const budget: CopyBudget = { files: 0, bytes: 0, signal: options.signal };
        const packages = await snapshotDependencies(
          instance.worktree,
          stage,
          [...new Set(external)],
          budget,
        );
        rmSync(metadataPath);
        const inputPackages = [
          "@opentui/core",
          "@opentui/solid",
          `@opentui/core-${process.platform}-${process.arch}`,
          "solid-js",
          "esbuild",
        ];
        const buildInputs = inputPackages.map((name) => {
          const path = name.startsWith("@opentui/core-")
            ? packageRoot(name, packageRoot("@opentui/core", instance.worktree), instance.worktree)
            : packageRoot(name, instance.worktree);
          return { name, path, digest: developmentPackageDigest(path) };
        });
        const packageVersion = JSON.parse(
          readFileSync(join(instance.worktree, "package.json"), "utf8"),
        ).version;
        writeFileSync(
          join(stage, "package.json"),
          JSON.stringify({ name: "tmux-ide", type: "module", version: packageVersion }),
          { mode: 0o600 },
        );
        for (const name of ["templates", "skill"])
          if (existsSync(join(instance.worktree, name)))
            await copyTree(join(instance.worktree, name), join(stage, name), budget);
        const nativeRelative = "packages/daemon/dist/native";
        mkdirSync(join(stage, nativeRelative), { recursive: true, mode: 0o700 });
        const nativeSource = join(instance.worktree, nativeRelative);
        if (
          !existsSync(
            join(nativeSource, "tmux", `${process.platform}-${process.arch}`, "manifest.json"),
          )
        )
          throw new Error(
            "Build the qualified native tmux bundle in this worktree before a development build",
          );
        const nativeInputHash = developmentPackageDigest(nativeSource);
        await copyTree(nativeSource, join(stage, nativeRelative), budget);
        validateBundledTmux(
          join(stage, nativeRelative, "tmux", `${process.platform}-${process.arch}`),
        );
        if (nativeInputHash !== developmentPackageDigest(nativeSource))
          throw new Error("Native input changed during snapshot");
        await command(
          bun,
          [join(instance.worktree, "scripts/build-tui.mjs"), "--outfile", tui],
          instance.worktree,
          options.signal,
        );
        if (process.platform === "darwin")
          await command("/usr/bin/codesign", ["--verify", "--strict", tui], stage, options.signal);
        const provenance = JSON.parse(
          await command(tui, ["__release-provenance"], stage, options.signal),
        );
        if (
          provenance.version !== packageVersion ||
          provenance.commit !== source.commit ||
          provenance.platform !== `${process.platform}-${process.arch}`
        )
          throw new Error("Compiled development provenance mismatch");
        await command(node, [cli, "--version"], stage, options.signal);
        const capabilities = parseDevelopmentCapabilities(
          await command(
            node,
            [cli, "--development-capabilities", "--help", "--json"],
            stage,
            options.signal,
          ),
        );
        await command(
          node,
          [
            "--input-type=module",
            "-e",
            `import {createRequire} from 'node:module'; const pty=createRequire(${JSON.stringify(cli)})('node-pty'); const p=pty.spawn('/bin/sh',['-c','printf development-native-ok'],{cwd:${JSON.stringify(stage)},env:{PATH:'/usr/bin:/bin'}}); let output=''; const timer=setTimeout(()=>{p.kill();process.exitCode=1;},3000); p.onData(data=>output+=data); p.onExit(()=>{clearTimeout(timer);if(!output.includes('development-native-ok'))process.exitCode=1;});`,
          ],
          stage,
          options.signal,
        );
        for (const input of buildInputs)
          if (developmentPackageDigest(input.path) !== input.digest)
            throw new Error(`Build input changed: ${input.name}`);
        const after = await developmentSourceSnapshot(instance.worktree, options.signal);
        if (source.commit !== after.commit || source.digest !== after.digest)
          throw new Error("Worktree changed during build; previous build retained");
        const native: { path: string; sha256: string }[] = [];
        const scan = (dir: string): void => {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) scan(path);
            else if (entry.isFile() && /\.(?:node|dylib|so|wasm)$/u.test(entry.name))
              native.push({
                path: join(final, relative(stage, path)),
                sha256: developmentFileHash(path),
              });
          }
        };
        scan(stage);
        const manifest: DevelopmentBuildManifest = {
          version: 1,
          generation,
          instance: {
            id: instance.id,
            digest: instance.digest,
            worktree: instance.worktree,
            name: instance.name,
          },
          source,
          packageVersion,
          execution: "packaged-development",
          capabilities,
          host: {
            platform: process.platform,
            arch: process.arch,
            nodeVersion: nodeInfo.version,
            nodeAbi: nodeInfo.abi,
            bunVersion,
          },
          tools: {
            node,
            bun,
            nodeHash,
            bunHash,
          },
          cli: join(final, "bin/cli.js"),
          tui: join(final, "tui/tmux-ide-tui"),
          dependencies: join(final, "dependencies"),
          assets: join(final, nativeRelative),
          hashes: {
            cli: developmentFileHash(cli),
            tui: developmentFileHash(tui),
            dependencies: developmentTreeHash(join(stage, "dependencies")),
            assets: developmentTreeHash(join(stage, nativeRelative)),
            metadata: developmentFileHash(join(stage, "package.json")),
            payload: developmentTreeHash(stage, true),
          },
          packages,
          native,
          buildInputs: [
            ...buildInputs,
            { name: "bundled-tmux", path: nativeSource, digest: nativeInputHash },
          ],
          qualification: {
            provenance,
            signature: process.platform === "darwin" ? "verified" : "not-applicable",
          },
        };
        if (developmentFileHash(node) !== nodeHash || developmentFileHash(bun) !== bunHash)
          throw new Error("Toolchain changed during build");
        options.signal?.throwIfAborted();
        await options.beforePublish?.();
        return await withDevelopmentLock(
          instance,
          "lifecycle",
          async () => {
            options.signal?.throwIfAborted();
            const current = await developmentSourceSnapshot(instance.worktree, options.signal);
            if (source.commit !== current.commit || source.digest !== current.digest)
              throw new Error("Worktree changed before publication; previous build retained");
            renameSync(stage, final);
            writeFileSync(join(final, "manifest.json"), JSON.stringify(manifest, null, 2), {
              flag: "wx",
              mode: 0o600,
            });
            verifyDevelopmentBuild(instance, manifest);
            const pointer = join(instance.root, `.build-${randomUUID()}.json`);
            try {
              writeFileSync(
                pointer,
                JSON.stringify({
                  version: 1,
                  generation,
                  sha256: developmentFileHash(join(final, "manifest.json")),
                }),
                { flag: "wx", mode: 0o600 },
              );
              renameSync(pointer, join(instance.root, "build.json"));
            } finally {
              rmSync(pointer, { force: true });
            }
            published = true;
            return manifest;
          },
          options.signal,
        );
      } finally {
        rmSync(stage, { recursive: true, force: true });
        if (!published) rmSync(final, { recursive: true, force: true });
      }
    },
    options.signal,
  );
}
