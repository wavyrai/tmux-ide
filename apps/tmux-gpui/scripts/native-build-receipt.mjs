// Local integrity only: not a signature, trusted provenance or commit attestation.
import { open, lstat, readdir, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
const REQUIRED = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "crates", "assets"];
const LIMIT = 256 * 1024 * 1024;
const hex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
export async function hashNativeFile(path, limit = LIMIT) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const initial = await file.stat();
    if (!initial.isFile() || initial.size > limit)
      throw new Error("Invalid or oversized integrity input");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const read = await file.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > limit) throw new Error("Integrity input exceeded bound");
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (
      bytes !== initial.size ||
      !same(initial, await file.stat()) ||
      !same(initial, await lstat(path))
    )
      throw new Error("Integrity input changed while hashing");
    return { bytes, mode: initial.mode & 0o777, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}
/** Declared local Rust inputs only. No target/cache, secrets, arbitrary root files or full Git dump. */
export async function snapshotNativeSources(workspace) {
  const root = await realpath(workspace),
    files = [];
  let total = 0,
    entries = 0;
  async function walk(path) {
    if (++entries > 20000 || path.length > 4096) throw new Error("Source snapshot exceeded bound");
    const absolute = join(root, path),
      stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error("Source symlinks are unsupported");
    if (stat.isDirectory()) {
      const names = await readdir(absolute);
      if (names.length > 20000) throw new Error("Source directory exceeded bound");
      for (const name of names.sort()) {
        if (name.startsWith(".")) throw new Error("Hidden source inputs require explicit review");
        await walk(`${path}/${name}`);
      }
    } else {
      const info = await hashNativeFile(absolute, Math.min(64 * 1024 * 1024, LIMIT - total));
      total += info.bytes;
      files.push({ path, ...info });
    }
  }
  for (const path of REQUIRED) await walk(path);
  try {
    await lstat(join(root, ".cargo"));
    await walk(".cargo");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { version: 1, files, sha256: digest(JSON.stringify(files)) };
}
function validate(receipt) {
  if (
    !receipt ||
    Object.keys(receipt).sort().join() !== "binary,build,kind,sources,version" ||
    receipt.version !== 1 ||
    receipt.kind !== "local-nonhermetic-native-build" ||
    !receipt.sources ||
    receipt.sources.version !== 1 ||
    !Array.isArray(receipt.sources.files) ||
    receipt.sources.files.length > 20000 ||
    !hex(receipt.sources.sha256) ||
    !receipt.binary ||
    Object.keys(receipt.binary).sort().join() !== "bytes,mode,sha256" ||
    !hex(receipt.binary.sha256) ||
    !Number.isSafeInteger(receipt.binary.bytes) ||
    receipt.binary.bytes < 1 ||
    receipt.binary.bytes > LIMIT ||
    !Number.isInteger(receipt.binary.mode) ||
    receipt.binary.mode < 0 ||
    receipt.binary.mode > 511 ||
    !receipt.build ||
    receipt.build.scope !== "local-cache-environment-not-hermetic" ||
    typeof receipt.build.hostTarget !== "string" ||
    receipt.build.hostTarget.length > 256 ||
    !Array.isArray(receipt.build.command) ||
    JSON.stringify(receipt.build.command) !==
      JSON.stringify([
        "build",
        "--locked",
        "--offline",
        "-p",
        "herdr-gpui",
        "--bin",
        "tmux-ide-gpui",
        "--release",
        "--message-format=json-render-diagnostics",
      ])
  )
    throw new Error("Malformed native build receipt");
  for (const name of ["cargo", "rustc"]) {
    const tool = receipt.build[name];
    if (
      !tool ||
      !isAbsolute(tool.path ?? "") ||
      tool.path.length > 4096 ||
      !hex(tool.sha256) ||
      typeof tool.version !== "string" ||
      tool.version.length > 8192
    )
      throw new Error("Malformed tool identity");
  }
  return receipt;
}
/** Preserve bounded Cargo-rendered errors instead of losing stdout diagnostics on failure. */
export function cargoDiagnosticTail(output) {
  let tail = "";
  for (const line of output.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message.reason === "compiler-message" && typeof message.message?.rendered === "string")
        tail = (tail + message.message.rendered).slice(-8192);
    } catch {
      /* Non-JSON output is represented by the command's bounded stderr. */
    }
  }
  return tail;
}
/** Choose only the executable reported by this successful Cargo invocation, never a guessed cache path. */
export function nativeArtifactFromCargo(output, packageId) {
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output) > 8 * 1024 * 1024 ||
    typeof packageId !== "string"
  )
    throw new Error("Invalid Cargo artifact output");
  const executables = new Set();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (
      message.reason !== "compiler-artifact" ||
      message.package_id !== packageId ||
      message.target?.name !== "tmux-ide-gpui" ||
      !Array.isArray(message.target.kind) ||
      !message.target.kind.includes("bin")
    )
      continue;
    if (typeof message.executable !== "string" || !isAbsolute(message.executable))
      throw new Error("Invalid native compiler artifact");
    executables.add(message.executable);
  }
  if (executables.size !== 1) throw new Error("Missing or ambiguous native compiler artifact");
  return [...executables][0];
}
export async function writeNativeBuildReceipt({ receiptPath, native, workspace, before, build }) {
  const sources = await snapshotNativeSources(workspace);
  if (JSON.stringify(before) !== JSON.stringify(sources))
    throw new Error("Native sources changed during build");
  const receipt = validate({
    version: 1,
    kind: "local-nonhermetic-native-build",
    sources,
    binary: await hashNativeFile(native),
    build,
  });
  const encoded = JSON.stringify(receipt, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
    throw new Error("Native receipt exceeded bound");
  await writeFile(receiptPath, encoded, { flag: "wx", mode: 0o600 });
  return receipt;
}
export async function verifyNativeBuildReceipt(receiptPath, native, workspace) {
  const file = await open(
    receiptPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let receipt;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid receipt file");
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 1),
      { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4 * 1024 * 1024 || bytesRead !== stat.size || !same(stat, await file.stat()))
      throw new Error("Receipt changed or exceeded bound");
    receipt = validate(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
  } finally {
    await file.close();
  }
  if (JSON.stringify(await snapshotNativeSources(workspace)) !== JSON.stringify(receipt.sources))
    throw new Error("Native source receipt mismatch");
  if (JSON.stringify(await hashNativeFile(native)) !== JSON.stringify(receipt.binary))
    throw new Error("Native binary receipt mismatch");
  return receipt;
}
