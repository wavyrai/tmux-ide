#!/usr/bin/env node
/** Export one explicit worktree without host dependencies, state or external Git metadata. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const excluded = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "coverage",
  ".next",
  ".tmux-ide",
  "context",
  "plans",
  ".DS_Store",
  ".development-container-source.json",
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function exportDevelopmentContainerContext(worktree, destination) {
  const root = realpathSync(worktree),
    output = resolve(destination);
  const parent = realpathSync(dirname(output));
  if (parent === root || parent.startsWith(root + sep))
    throw new Error("Container context must be outside the worktree");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== root)
    throw new Error("Select the canonical worktree root");
  const commit = git(["rev-parse", "HEAD"]),
    branch = git(["branch", "--show-current"]),
    status = git(["status", "--porcelain", "--untracked-files=all"]);
  const paths = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { env, encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (path) => !path.split("/").some((part) => excluded.has(part) || part.startsWith(".env")),
    )
    .sort();
  const unique = [...new Set(paths)];
  if (unique.length > 50000) throw new Error("Source file budget exceeded");
  mkdirSync(output, { mode: 0o700 });
  const files = [];
  let total = 0;
  const inspect = (path) => {
    let stat;
    try {
      stat = lstatSync(join(root, path));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(join(root, path));
      const actual = realpathSync(join(root, path));
      if (target.startsWith("/") || !actual.startsWith(root + sep))
        throw new Error("Source symlink escapes exported worktree");
      const resolved = relative(root, actual);
      if (!unique.some((file) => file === resolved || file.startsWith(resolved + "/")))
        throw new Error("Source symlink targets excluded input");
      return { path, type: "symlink", target, hash: hash(target), mode: 0o777 };
    }
    if (!realpathSync(join(root, path)).startsWith(root + sep))
      throw new Error("Source path escapes exported worktree");
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
      throw new Error("Unsupported or oversized source input");
    const bytes = readFileSync(join(root, path));
    return {
      path,
      type: "file",
      hash: hash(bytes),
      mode: stat.mode & 0o111 ? 0o755 : 0o644,
      bytes,
    };
  };
  try {
    for (const path of unique) {
      const input = inspect(path);
      if (!input) continue; // tracked deletions remain deleted
      total += input.bytes?.length ?? Buffer.byteLength(input.target);
      if (total > 256 * 1024 * 1024) throw new Error("Source byte budget exceeded");
      const target = join(output, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (input.type === "symlink") symlinkSync(input.target, target);
      else {
        writeFileSync(target, input.bytes);
        chmodSync(target, input.mode);
      }
      const record = { ...input };
      delete record.bytes;
      files.push(record);
    }
    for (const record of files) {
      const now = inspect(record.path);
      if (!now || now.hash !== record.hash || now.mode !== record.mode)
        throw new Error("Source changed during export");
    }
    if (
      git(["rev-parse", "HEAD"]) !== commit ||
      git(["branch", "--show-current"]) !== branch ||
      git(["status", "--porcelain", "--untracked-files=all"]) !== status
    )
      throw new Error("Source identity changed during export");
    const manifest = {
      version: 1,
      sourceWorktree: root,
      sourceCommit: commit,
      sourceBranch: branch || null,
      sourceDirty: status.length > 0,
      sourceCommitTimestamp: Number(git(["show", "-s", "--format=%ct", "HEAD"])),
      snapshotDigest: hash(JSON.stringify(files)),
      bytes: total,
      files,
      exclusions: [...excluded, ".env*"],
    };
    writeFileSync(
      join(output, ".development-container-source.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o644 },
    );
    return manifest;
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [worktree, output] = process.argv.slice(2);
  if (!worktree || !output)
    throw new Error("Usage: development-container-context.mjs <worktree> <new-context-directory>");
  const result = exportDevelopmentContainerContext(worktree, output);
  process.stdout.write(
    JSON.stringify({
      context: resolve(output),
      sourceCommit: result.sourceCommit,
      sourceDirty: result.sourceDirty,
      snapshotDigest: result.snapshotDigest,
      files: result.files.length,
      bytes: result.bytes,
    }) + "\n",
  );
}
