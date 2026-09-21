/* global process, console */
/** Materialize an exported source snapshot into an owned container volume. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  chmodSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
const [input = "/opt/source-snapshot", destination = "/workspace"] = process.argv.slice(2);
if (process.getuid?.() === 0) throw new Error("Source fixture must run as non-root");
const source = realpathSync(input),
  target = resolve(destination);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (existsSync(target)) {
  const stat = lstatSync(target);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    readdirSync(target).length
  )
    throw new Error("Source destination must be an empty owned directory");
}
const manifest = JSON.parse(
  readFileSync(join(source, ".development-container-source.json"), "utf8"),
);
if (
  manifest.version !== 1 ||
  !Array.isArray(manifest.files) ||
  manifest.files.length > 50000 ||
  digest(JSON.stringify(manifest.files)) !== manifest.snapshotDigest ||
  !Number.isSafeInteger(manifest.sourceCommitTimestamp) ||
  manifest.sourceCommitTimestamp < 0 ||
  !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(manifest.sourceCommit)
)
  throw new Error("Invalid exported source manifest");
const paths = new Set();
for (const file of manifest.files) {
  if (
    typeof file.path !== "string" ||
    !file.path ||
    file.path.includes("\\") ||
    file.path.startsWith("/") ||
    file.path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === ".git" ||
          part === ".development-container-source.json",
      ) ||
    paths.has(file.path) ||
    !/^[a-f0-9]{64}$/u.test(file.hash)
  )
    throw new Error("Invalid exported source path");
  paths.add(file.path);
  if (file.type === "symlink") {
    if (
      typeof file.target !== "string" ||
      file.target.startsWith("/") ||
      digest(file.target) !== file.hash ||
      !resolve(source, dirname(file.path), file.target).startsWith(source + sep) ||
      !realpathSync(join(source, file.path)).startsWith(source + sep)
    )
      throw new Error("Invalid source symlink");
  } else if (
    file.type !== "file" ||
    ![0o644, 0o755].includes(file.mode) ||
    !realpathSync(join(source, file.path)).startsWith(source + sep)
  )
    throw new Error("Invalid source file");
}
for (const file of manifest.files) {
  let parent = dirname(file.path);
  while (parent !== ".") {
    if (paths.has(parent)) throw new Error("Source file overlaps another input directory");
    parent = dirname(parent);
  }
}
mkdirSync(target, { recursive: true, mode: 0o700 });
if (realpathSync(target) === source || realpathSync(target).startsWith(source + sep))
  throw new Error("Source destination must be outside snapshot");
chmodSync(target, 0o700);
let total = 0;
// Write regular inputs first; no supplied symlink can redirect a write.
for (const file of manifest.files.filter((entry) => entry.type === "file")) {
  const original = join(source, file.path),
    stat = lstatSync(original);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Invalid source input size");
  const bytes = readFileSync(original);
  total += bytes.length;
  if (bytes.length > 32 * 1024 * 1024 || total > 256 * 1024 * 1024 || digest(bytes) !== file.hash)
    throw new Error("Source input digest or byte budget changed");
  const output = join(target, file.path);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, bytes, { flag: "wx", mode: file.mode });
}
for (const file of manifest.files.filter((entry) => entry.type === "symlink")) {
  const output = join(target, file.path);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  symlinkSync(file.target, output);
}
writeFileSync(
  join(target, ".development-container-source.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const date = `${manifest.sourceCommitTimestamp} +0000`;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_AUTHOR_DATE: date,
  GIT_COMMITTER_DATE: date,
};
for (const args of [
  ["init"],
  ["config", "user.name", "tmux-ide fixture"],
  ["config", "user.email", "fixture@example.invalid"],
  ["add", "--force", "--all"],
  ["commit", "-m", `Owned source export ${manifest.sourceCommit}`],
  ["checkout", "--detach"],
])
  execFileSync("git", ["-C", target, ...args], { env, stdio: "inherit" });
execFileSync(
  "pnpm",
  [
    "install",
    "--offline",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--store-dir",
    "/pnpm/store",
    "--child-concurrency=1",
  ],
  { cwd: target, stdio: "inherit" },
);
execFileSync("pnpm", ["rebuild", "node-pty", "esbuild", "@parcel/watcher"], {
  cwd: target,
  stdio: "inherit",
  env: {
    ...env,
    npm_config_jobs: "2",
    npm_config_build_from_source: "true",
    npm_config_nodedir: "/usr/local",
  },
});
const native = join(
  target,
  "packages/daemon/dist/native/tmux",
  `${process.platform}-${process.arch}`,
);
mkdirSync(dirname(native), { recursive: true });
execFileSync("cp", ["-a", "/opt/native/tmux", native]);
console.log(
  JSON.stringify({
    source: manifest.sourceCommit,
    snapshot: manifest.snapshotDigest,
    worktree: target,
    node: process.version,
    abi: process.versions.modules,
    arch: process.arch,
  }),
);
