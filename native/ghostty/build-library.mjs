import { execFile } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const provenance = JSON.parse(await readFile(join(here, "provenance.json"), "utf8"));
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--verify-only" && !arg.startsWith("--output="))) {
  throw new Error(
    "Usage: GHOSTTY_SOURCE=/checkout ZIG_BINARY=/path/zig node native/ghostty/build-library.mjs [--output=/tmp/new-directory] [--verify-only]",
  );
}
const outputs = args.filter((arg) => arg.startsWith("--output="));
if (outputs.length > 1) throw new Error("Specify at most one output directory");
const source = process.env.GHOSTTY_SOURCE;
const zig = process.env.ZIG_BINARY;
if (!source || !zig || !isAbsolute(source) || !isAbsolute(zig)) {
  throw new Error("GHOSTTY_SOURCE and ZIG_BINARY must be absolute paths");
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(`This prototype recipe requires macOS arm64 (${provenance.target})`);
}
const patch = join(here, provenance.patch);
const patchBytes = await readFile(patch);
if (createHash("sha256").update(patchBytes).digest("hex") !== provenance.patchSha256) {
  throw new Error("Ghostty external I/O patch checksum mismatch");
}
const revision = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
if (revision !== provenance.commit)
  throw new Error("GHOSTTY_SOURCE must be at the pinned Ghostty revision");
if ((await exec(zig, ["version"])).stdout.trim() !== provenance.zigVersion) {
  throw new Error(`This recipe requires Zig ${provenance.zigVersion}`);
}
if (args.includes("--verify-only")) {
  console.log(
    `Verified Ghostty ${revision}, patch ${provenance.patchSha256}, Zig ${provenance.zigVersion}`,
  );
} else {
  let root;
  if (outputs.length) {
    root = resolve(outputs[0].slice("--output=".length));
    const parent = await realpath(dirname(root));
    const temporary = await realpath("/tmp");
    if (parent !== temporary && !parent.startsWith(`${temporary}/`)) {
      throw new Error("Output must be a new directory under /tmp");
    }
    // Refuse existing output so a repeated invocation cannot overwrite an artifact.
    await mkdir(root);
  } else root = await mkdtemp("/tmp/tmux-ide-ghostty-build-");
  const checkout = join(root, "source");
  const cache = join(root, "cache");
  const globalCache = join(root, "global-cache");
  const prefix = join(root, "install");
  const run = async (name, command, commandArgs, cwd) => {
    try {
      const result = await exec(command, commandArgs, { cwd, maxBuffer: 32 * 1024 * 1024 });
      await writeFile(join(root, `${name}.log`), result.stdout + result.stderr);
      return result;
    } catch (error) {
      await writeFile(
        join(root, `${name}.log`),
        String(error.stdout ?? "") + String(error.stderr ?? error),
      );
      throw error;
    }
  };
  await run("worktree", "git", ["-C", source, "worktree", "add", "--detach", checkout, revision]);
  await run("patch-check", "git", ["apply", "--check", patch], checkout);
  await run("patch", "git", ["apply", patch], checkout);
  const common = [
    "-Dapp-runtime=none",
    "-Demit-macos-app=false",
    "--cache-dir",
    cache,
    "--global-cache-dir",
    globalCache,
  ];
  await run(
    "build",
    zig,
    [
      "build",
      "-Doptimize=ReleaseFast",
      `-Dtarget=${provenance.target}`,
      "-Demit-xcframework=true",
      "-Dxcframework-target=native",
      ...common,
      "--prefix",
      prefix,
    ],
    checkout,
  );
  await run(
    "test",
    zig,
    [
      "build",
      "test",
      "-Dtest-filter=external backend",
      "-Demit-xcframework=false",
      ...common,
      "--summary",
      "all",
    ],
    checkout,
  );
  const framework = join(root, "GhosttyKit.xcframework");
  await cp(join(checkout, "macos/GhosttyKit.xcframework"), framework, { recursive: true });
  await cp(join(here, "LICENSE.ghostty"), join(root, "LICENSE.ghostty"));
  await writeFile(join(root, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(JSON.stringify({ root, framework, resources: join(prefix, "share/ghostty") }));
}
