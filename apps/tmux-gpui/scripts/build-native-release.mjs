#!/usr/bin/env node
// Local cached build only; no clean-build, dependency-cache, SDK or attestation claim.
// Signals/timeouts retire only the direct Cargo child. Compiler descendants are not
// independently qualified here; interrupted builds produce no successful receipt.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
if (process.platform !== "darwin")
  throw new Error("Native release wrapper currently supports macOS only");
import { realpath, lstat, open, unlink } from "node:fs/promises";
import { join, resolve, relative, sep, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  snapshotNativeSources,
  nativeArtifactFromCargo,
  cargoDiagnosticTail,
  hashNativeFile,
  writeNativeBuildReceipt,
} from "./native-build-receipt.mjs";
const workspace = await realpath(fileURLToPath(new URL("../upstream", import.meta.url)));
if (process.argv.length !== 3)
  throw new Error("Usage: node build-native-release.mjs NEW_RECEIPT.json");
const output = resolve(process.argv[2]);
try {
  await lstat(output);
  throw new Error("Receipt already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const key of Object.keys(process.env)) {
  if (
    /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_|CARGO_TARGET_|HERDR_|CARGO_FEATURE_)/.test(
      key,
    )
  )
    throw new Error(`Unsupported build override: ${key}`);
}
const cargoHome = await realpath(process.env.CARGO_HOME ?? join(homedir(), ".cargo"));
const rustupHome = await realpath(process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"));
const env = {
  HOME: process.env.HOME,
  PATH: `${join(cargoHome, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
  CARGO_HOME: cargoHome,
  RUSTUP_HOME: rustupHome,
  HERDR_BUILD_PR_NUMBER: "",
  LANG: "C",
  LC_ALL: "C",
};
const lock = await open(output + ".lock", "wx", 0o600);
let child = null;
const terminate = () => {
  if (child?.pid)
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
};
let cancelled = false;
const cancel = () => {
  cancelled = true;
  terminate();
};
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
async function run(command, args, timeout = 20000, maxBytes = 4 * 1024 * 1024) {
  if (cancelled) throw new Error("Build cancelled");
  return new Promise((resolvePromise, reject) => {
    const owned = spawn(command, args, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = owned;
    let stdout = "",
      stderr = "",
      bytes = 0,
      failure;
    const timer = setTimeout(() => {
      failure = new Error("Build command deadline exceeded");
      terminate();
    }, timeout);
    const data = (stream, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new Error("Build command output exceeded bound");
        terminate();
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    owned.stdout.on("data", (chunk) => data("stdout", chunk));
    owned.stderr.on("data", (chunk) => data("stderr", chunk));
    owned.on("error", (error) => {
      failure = error;
    });
    owned.on("close", (code, signal) => {
      clearTimeout(timer);
      child = null;
      if (failure || code !== 0 || cancelled)
        reject(
          failure ??
            new Error(
              `Build command failed (${code ?? signal}): ${stderr.slice(-2048)}\n${cargoDiagnosticTail(stdout)}`,
            ),
        );
      else resolvePromise(stdout.trim());
    });
  });
}
const inside = (path) => {
  const rel = relative(workspace, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};
try {
  const before = await snapshotNativeSources(workspace);
  const rustup = join(cargoHome, "bin/rustup");
  const cargo = await realpath(await run(rustup, ["which", "cargo"]));
  const rustc = await realpath(await run(rustup, ["which", "rustc"]));
  // Cargo invoked directly does not establish rustup's toolchain environment.
  // Bind its compiler explicitly and prefer the resolved toolchain for rustdoc.
  env.RUSTC = rustc;
  env.PATH = `${dirname(rustc)}:${env.PATH}`;
  const tool = async (path, args) => ({
    path,
    ...(await hashNativeFile(path)),
    version: await run(path, args),
  });
  const cargoIdentity = await tool(cargo, ["--version"]),
    rustcIdentity = await tool(rustc, ["-vV"]);
  const target = /^host: (\S+)$/m.exec(rustcIdentity.version)?.[1];
  if (!target) throw new Error("Rust host target missing");
  const metadata = JSON.parse(
    await run(
      cargo,
      ["metadata", "--locked", "--offline", "--format-version", "1"],
      20000,
      16 * 1024 * 1024,
    ),
  );
  for (const pkg of metadata.packages ?? []) {
    if (
      pkg.source === null &&
      (!inside(await realpath(pkg.manifest_path)) ||
        (relative(workspace, await realpath(pkg.manifest_path)) !== "Cargo.toml" &&
          !relative(workspace, await realpath(pkg.manifest_path)).startsWith(`crates${sep}`)))
    )
      throw new Error("External local Cargo package unsupported");
  }
  if (
    !Array.isArray(metadata.packages) ||
    !metadata.packages.length ||
    !isAbsolute(metadata.target_directory)
  )
    throw new Error("Invalid Cargo metadata");
  const gitIdentity = async () => ({
    head: await run("/usr/bin/git", ["rev-parse", "HEAD"]),
    branch: await run("/usr/bin/git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    worktree: await run("/usr/bin/git", ["rev-parse", "--absolute-git-dir"]),
  });
  const git = await gitIdentity();
  const command = [
    "build",
    "--locked",
    "--offline",
    "-p",
    "herdr-gpui",
    "--bin",
    "tmux-ide-gpui",
    "--release",
    "--message-format=json-render-diagnostics",
  ];
  console.log("Building local native release; cached, nonhermetic scope.");
  const artifacts = await run(cargo, command, 600000, 8 * 1024 * 1024);
  if (JSON.stringify(git) !== JSON.stringify(await gitIdentity()))
    throw new Error("Git build identity changed");
  if (
    JSON.stringify(cargoIdentity) !== JSON.stringify(await tool(cargo, ["--version"])) ||
    JSON.stringify(rustcIdentity) !== JSON.stringify(await tool(rustc, ["-vV"]))
  )
    throw new Error("Build tool identity changed");
  const packages = metadata.packages.filter(
    (pkg) => pkg.name === "herdr-gpui" && pkg.source === null,
  );
  if (packages.length !== 1) throw new Error("Ambiguous native package identity");
  const native = await realpath(nativeArtifactFromCargo(artifacts, packages[0].id));
  if (cancelled) throw new Error("Build cancelled");
  const receipt = await writeNativeBuildReceipt({
    receiptPath: output,
    native,
    workspace,
    before,
    build: {
      scope: "local-cache-environment-not-hermetic",
      hostTarget: target,
      command,
      cargo: cargoIdentity,
      rustc: rustcIdentity,
      git,
      environment: {
        HERDR_BUILD_PR_NUMBER: "",
        CARGO_HOME: cargoHome,
        RUSTUP_HOME: rustupHome,
        RUSTC: rustc,
        PATH: env.PATH,
      },
      targetDirectory: metadata.target_directory,
    },
  });
  console.log(
    JSON.stringify({
      receipt: output,
      native,
      sha256: receipt.binary.sha256,
      sourceSha256: receipt.sources.sha256,
    }),
  );
} finally {
  terminate();
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
  await lock.close();
  await unlink(output + ".lock");
}
