/** Exact immutable development-artifact selection. Never builds, downloads or launches. */
import { createHash } from "node:crypto";
import {
  openSync,
  closeSync,
  readSync,
  fstatSync,
  constants,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DevelopmentInstance } from "./development-instance.ts";

export interface DevelopmentBuildManifest {
  version: 1;
  generation: string;
  instance: { id: string; digest: string; worktree: string; name: string };
  source: { commit: string; digest: string; dirty: boolean; files: number; lockfileHash: string };
  packageVersion: string;
  execution: "packaged-development";
  capabilities?: readonly ("managed-development-owner-v1" | "container-suspension-v1")[];
  host: {
    platform: string;
    arch: string;
    nodeVersion: string;
    nodeAbi: string;
    bunVersion: string;
  };
  tools: { node: string; bun: string; nodeHash: string; bunHash: string };
  cli: string;
  tui: string;
  dependencies: string;
  assets: string;
  hashes: {
    cli: string;
    tui: string;
    dependencies: string;
    assets: string;
    metadata: string;
    payload: string;
  };
  buildInputs: ReadonlyArray<{ name: string; path: string; digest: string }>;
  packages: ReadonlyArray<{ name: string; version: string }>;
  native: ReadonlyArray<{ path: string; sha256: string }>;
  qualification: { provenance: Record<string, unknown>; signature: "verified" | "not-applicable" };
}

const HASH_BUFFER = Buffer.allocUnsafe(64 * 1024);

export function developmentFileHash(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 512 * 1024 * 1024)
      throw new Error(`Invalid build file: ${path}`);
    const hash = createHash("sha256");
    const buffer = HASH_BUFFER;
    let total = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > info.size) throw new Error("Build file grew while hashing");
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    if (total !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new Error("Build file changed while hashing");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Deterministic digest, including relative symlink targets; no external symlink escape. */
export function developmentTreeHash(root: string, omitManifest = false): string {
  const digest = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (path: string): void => {
    if (++files > 100_000) throw new Error("Development artifact file budget exceeded");
    const info = lstatSync(path);
    const name = relative(root, path);
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path);
      const actual = realpathSync(path);
      if (actual !== root && !actual.startsWith(`${root}${sep}`))
        throw new Error("Development artifact symlink escapes generation");
      digest.update(JSON.stringify([name, "link", target]));
      return;
    }
    if (info.isDirectory()) {
      digest.update(JSON.stringify([name, "directory"]));
      for (const child of readdirSync(path).sort()) {
        if (omitManifest && path === root && child === "manifest.json") continue;
        visit(join(path, child));
      }
      return;
    }
    if (!info.isFile() || (bytes += info.size) > 1024 * 1024 * 1024)
      throw new Error("Development artifact byte budget exceeded");
    digest.update(JSON.stringify([name, info.mode & 0o777, info.size, developmentFileHash(path)]));
  };
  visit(root);
  return digest.digest("hex");
}

function assertRecord(value: unknown): asserts value is DevelopmentBuildManifest {
  if (!value || typeof value !== "object") throw new Error("Missing development build manifest");
  const m = value as DevelopmentBuildManifest;
  if (
    m.version !== 1 ||
    !/^build-[a-f0-9-]{36}$/u.test(m.generation) ||
    m.execution !== "packaged-development" ||
    !m.instance ||
    !m.host ||
    !m.tools ||
    !m.hashes ||
    !m.source ||
    !Array.isArray(m.native) ||
    !Array.isArray(m.packages) ||
    !m.qualification
  )
    throw new Error("Invalid development build manifest");
  for (const hash of [
    ...Object.values(m.hashes),
    m.source.digest,
    m.source.lockfileHash,
    m.tools.nodeHash,
    m.tools.bunHash,
  ])
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
      throw new Error("Invalid development artifact digest");
}

export function verifyDevelopmentBuild(
  instance: DevelopmentInstance,
  value: unknown,
): DevelopmentBuildManifest {
  assertRecord(value);
  const m = value;
  for (const key of ["id", "digest", "worktree", "name"] as const)
    if (m.instance[key] !== instance[key])
      throw new Error("Development build belongs to another instance/worktree");
  if (
    m.host.platform !== process.platform ||
    m.host.arch !== process.arch ||
    (!process.versions.bun && m.host.nodeAbi !== process.versions.modules) ||
    (process.versions.bun !== undefined && m.host.bunVersion !== process.versions.bun)
  )
    throw new Error("Development build host/native ABI mismatch");
  const root = join(instance.root, "artifacts", m.generation);
  if (realpathSync(root) !== root) throw new Error("Development artifact generation is redirected");
  for (const [key, rel] of Object.entries({
    cli: "bin/cli.js",
    tui: "tui/tmux-ide-tui",
    dependencies: "dependencies",
    assets: "packages/daemon/dist/native",
  })) {
    if (m[key as "cli"] !== join(root, rel)) throw new Error("Development artifact path mismatch");
  }
  if (
    developmentTreeHash(root, true) !== m.hashes.payload ||
    developmentFileHash(m.cli) !== m.hashes.cli ||
    developmentFileHash(m.tui) !== m.hashes.tui ||
    developmentTreeHash(m.dependencies) !== m.hashes.dependencies ||
    developmentTreeHash(m.assets) !== m.hashes.assets ||
    developmentFileHash(join(root, "package.json")) !== m.hashes.metadata
  )
    throw new Error("Development artifact contents changed; rebuild required");
  for (const tool of ["node"] as const) {
    if (
      resolve(m.tools[tool]) !== m.tools[tool] ||
      developmentFileHash(m.tools[tool]) !== m.tools[`${tool}Hash`]
    )
      throw new Error("Development build toolchain changed; rebuild required");
  }
  return m;
}

/** Source edits do not revoke a running/last-good build. D04 reports freshness separately. */
export function readDevelopmentBuild(
  instance: DevelopmentInstance,
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentBuildManifest {
  try {
    const selected = environment.TMUX_IDE_DEVELOPMENT_BUILD;
    const selectedHash = environment.TMUX_IDE_DEVELOPMENT_BUILD_HASH;
    if (Boolean(selected) !== Boolean(selectedHash))
      throw new Error("Incomplete development build pin");
    let pointer;
    if (selected) pointer = { version: 1, generation: selected, sha256: selectedHash };
    else {
      const pointerPath = join(instance.root, "build.json");
      const stat = lstatSync(pointerPath);
      if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid build pointer");
      pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    }
    if (pointer.version !== 1 || !/^build-[a-f0-9-]{36}$/u.test(pointer.generation))
      throw new Error("Invalid build pointer");
    const manifestPath = join(instance.root, "artifacts", pointer.generation, "manifest.json");
    if (
      lstatSync(manifestPath).size > 1024 * 1024 ||
      developmentFileHash(manifestPath) !== pointer.sha256
    )
      throw new Error("Development build manifest changed");
    return verifyDevelopmentBuild(instance, JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (error) {
    throw new Error(
      "No verified development build manifest. From the selected worktree run: pnpm exec tsx scripts/development-build.ts --bun <absolute-pinned-bun> (repeat the selected --name and --store options). Installed/download/source fallback is disabled.",
      { cause: error },
    );
  }
}

/** Forward only a fully verified generation. D04 can use the same exact argv/environment. */
export function developmentBuildLaunch(manifest: DevelopmentBuildManifest) {
  return {
    executable: manifest.tools.node,
    argv: [manifest.cli],
    environment: {
      TMUX_IDE_CLI: manifest.cli,
      TMUX_IDE_TUI_BIN: manifest.tui,
      TMUX_IDE_DEVELOPMENT_BUILD: manifest.generation,
      TMUX_IDE_DEVELOPMENT_BUILD_HASH: developmentFileHash(
        join(dirname(manifest.cli), "..", "manifest.json"),
      ),
    },
  };
}
