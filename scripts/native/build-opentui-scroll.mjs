#!/usr/bin/env node

// Build the opt-in native scrolling candidate without touching an installed
// OpenTUI package, the supplied checkout, or the application's default build.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  NATIVE_SCROLL_RELEASE_PINS,
  nativeScrollSha256,
  nativeScrollHostLibc,
} from "../lib/native-scroll-release-manifest.mjs";

const sourceCommit = NATIVE_SCROLL_RELEASE_PINS.sourceCommit;
const zigVersion = "0.15.2";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const patch = join(repository, "patches/opentui-native-scroll-ad9a818.patch");
const help = `Usage: build-opentui-scroll.mjs --source PATH --zig PATH --output PATH [--preflight]

Requires a clean OpenTUI checkout at ${sourceCommit}
and an explicitly supplied Zig ${zigVersion} executable. --output must not exist
and must be outside both checkouts. --preflight checks prerequisites and patch
applicability without creating output. No package installation or download of
OpenTUI/Zig is performed; Zig may fetch the upstream pinned build dependencies.

The normal run clones the supplied source into output, applies the pinned patch,
runs the full native test suite, and builds ReleaseFast. Logs and provenance.json
remain in output, including on failure. Successful macOS/Linux glibc host builds
also emit release-manifest.json for build-tui.mjs --release-scroll-manifest.
Configure your host SDK through your
normal toolchain environment; this script does not change SDK or host settings.

The candidate remains opt-in at runtime: TMUX_IDE_NATIVE_SCROLL_PROTOTYPE=1.
This command does not select it for the TUI or alter the production default.
`;

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function inside(parent, child) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." &&
      !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(path))
  );
}

function libraries(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory()
      ? libraries(child)
      : /(?:lib)?opentui\.(?:dylib|so|dll)$/.test(entry.name)
        ? [child]
        : [];
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help);
    return;
  }
  const options = {};
  let preflight = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--preflight") {
      preflight = true;
      continue;
    }
    if (
      !["--source", "--zig", "--output"].includes(name) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      options[name]
    ) {
      throw new Error(`Invalid or duplicate argument: ${name}. Use --help.`);
    }
    options[name] = args[++i];
  }
  for (const name of ["--source", "--zig", "--output"]) {
    if (!options[name]) throw new Error(`Missing ${name}. Use --help.`);
  }
  const source = realpathSync(options["--source"]);
  const zig = realpathSync(options["--zig"]);
  const requestedOutput = resolve(options["--output"]);
  const output = join(realpathSync(dirname(requestedOutput)), basename(requestedOutput));
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  if (inside(source, output) || inside(repository, output))
    throw new Error("Output must be outside both checkouts.");
  if (capture("git", ["rev-parse", "HEAD"], source) !== sourceCommit)
    throw new Error(`Source must be pinned to ${sourceCommit}.`);
  if (capture("git", ["status", "--porcelain", "--untracked-files=all"], source))
    throw new Error("Source checkout must be clean, including untracked files.");
  if (capture(zig, ["version"]) !== zigVersion) throw new Error(`Expected Zig ${zigVersion}.`);
  capture("git", ["apply", "--check", patch], source);
  console.log(`Verified OpenTUI ${sourceCommit} and Zig ${zigVersion}; patch applies cleanly.`);
  if (preflight) return;

  mkdirSync(output);
  const checkout = join(output, "opentui");
  const provenance = {
    sourceCommit,
    zigVersion,
    patchSha256: createHash("sha256").update(readFileSync(patch)).digest("hex"),
    status: "building",
  };
  const record = () =>
    writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  record();
  const run = (label, command, commandArgs, cwd) => {
    console.log(label);
    const log = join(output, `${label}.log`);
    const fd = openSync(log, "w");
    let result;
    try {
      result = spawnSync(command, commandArgs, {
        cwd,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, TMUX_IDE_NATIVE_SCROLL_PROTOTYPE: "0" },
      });
    } finally {
      closeSync(fd);
    }
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} failed; inspect ${log}`);
  };
  try {
    run("clone", "git", ["clone", "--no-hardlinks", "--no-checkout", source, checkout]);
    run("checkout", "git", ["checkout", "--detach", sourceCommit], checkout);
    run("patch", "git", ["apply", patch], checkout);
    const native = join(checkout, "packages/core/src/zig");
    run("native-tests", zig, ["build", "test", "--summary", "all"], native);
    run("native-build", zig, ["build", "-Doptimize=ReleaseFast", "--summary", "all"], native);
    provenance.libraries = libraries(join(native, "lib"));
    if (provenance.libraries.length === 0)
      throw new Error("Build produced no OpenTUI native library.");
    provenance.librarySha256 = Object.fromEntries(
      provenance.libraries.map((path) => [
        path,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]),
    );
    provenance.status = "passed";
    record();
    // A release manifest is emitted only for the host ABI whose tests just ran.
    // Experimental builds on other libc variants remain possible, not promoted.
    const libc = nativeScrollHostLibc();
    if (
      ["darwin", "linux"].includes(process.platform) &&
      ["arm64", "x64"].includes(process.arch) &&
      (process.platform !== "linux" || libc === "glibc")
    ) {
      if (provenance.libraries.length !== 1)
        throw new Error("Release manifest requires exactly one host native library.");
      const artifact = (path) => ({
        path: relative(output, path),
        sha256: nativeScrollSha256(path),
      });
      const manifest = {
        version: 1,
        status: "passed",
        ...NATIVE_SCROLL_RELEASE_PINS,
        platform: process.platform,
        arch: process.arch,
        libc,
        patchSha256: provenance.patchSha256,
        recipeSha256: nativeScrollSha256(fileURLToPath(import.meta.url)),
        tests: artifact(join(output, "native-tests.log")),
        build: artifact(join(output, "native-build.log")),
        library: artifact(provenance.libraries[0]),
      };
      writeFileSync(
        join(output, "release-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
    console.log(`Native tests and build passed. Libraries:\n${provenance.libraries.join("\n")}`);
  } catch (error) {
    provenance.status = "failed";
    provenance.error = error.message;
    record();
    throw error;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
