// Bounded private-tree extraction pattern adapted from penso/herdr-gpui, Apache-2.0,
// 302700e1486977092e4a9165bc083ecdc9236227, crates/herdr-gpui/src/updater/install/archive.rs.
// See upstream/LICENSE and NOTICE. This narrower subset rejects ALL links/extensions.
// Bundle paths are printable ASCII only, with case aliases rejected on every filesystem.
// Non-ASCII bundle filenames are unsupported; terminal content is unrelated.
// No execution, Apple signature verification or installation. Caller owns successful staging.
// Private permissions are not protection against a hostile same-user filesystem actor;
// filesystem calls themselves cannot be given a hard kernel-level cancellation deadline.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath, open, mkdtemp, mkdir, chmod, rm } from "node:fs/promises";
import { isAbsolute, resolve, join, dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { verifyManifest } from "./preview-release-manifest.mjs";
const LIMIT = 1024 * 1024 * 1024;
const ROOT = "TmuxIDE.app";
class ExtractError extends Error {
  constructor(code) {
    super(`Archive extraction ${code}`);
  }
}
const fail = (code) => {
  throw new ExtractError(code);
};
const zero = (bytes) => bytes.every((b) => b === 0);
function octal(bytes, blank = false) {
  const text = bytes.toString("latin1");
  if (blank && /^[\0 ]*$/.test(text)) return 0;
  if (!/^ *[0-7]+[\0 ]*$/.test(text)) fail("invalid octal field");
  const value = Number.parseInt(text.trimStart(), 8);
  if (!Number.isSafeInteger(value)) fail("numeric field overflow");
  return value;
}
function textField(bytes) {
  const nul = bytes.indexOf(0);
  if (nul >= 0 && !zero(bytes.subarray(nul))) fail("invalid header string");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      nul < 0 ? bytes : bytes.subarray(0, nul),
    );
  } catch {
    fail("invalid header UTF-8");
  }
}
function header(bytes) {
  if (
    !bytes.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
    !bytes.subarray(263, 265).equals(Buffer.from("00"))
  )
    fail("unsupported tar format");
  const checksum = octal(bytes.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : bytes[i];
  if (checksum !== sum) fail("header checksum mismatch");
  const mode = octal(bytes.subarray(100, 108));
  const size = octal(bytes.subarray(124, 136));
  for (const [start, end] of [
    [108, 116],
    [116, 124],
    [136, 148],
  ])
    octal(bytes.subarray(start, end));
  if (
    octal(bytes.subarray(329, 337), true) !== 0 ||
    octal(bytes.subarray(337, 345), true) !== 0 ||
    !zero(bytes.subarray(500))
  )
    fail("unsupported device or reserved fields");
  if (mode > 0o777 || size > LIMIT) fail("unsafe mode or entry size");
  const kind = bytes[156];
  if (![0, 48, 53].includes(kind) || !zero(bytes.subarray(157, 257)))
    fail("unsupported entry type or link");
  const directory = kind === 53;
  if (directory && size !== 0) fail("directory has payload");
  const name = textField(bytes.subarray(0, 100)),
    prefix = textField(bytes.subarray(345, 500));
  let path = prefix ? `${prefix}/${name}` : name;
  if (directory && path.endsWith("/")) path = path.slice(0, -1);
  if (
    !path ||
    /[^\x20-\x7e]|\\/u.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    (path !== ROOT && !path.startsWith(ROOT + "/")) ||
    (path === ROOT && !directory)
  )
    fail("unsafe entry path");
  return { path, directory, mode, size };
}
const sameDirectory = (a, b) =>
  b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
const sameArchive = (a, b) =>
  b.isFile() &&
  b.nlink === 1 &&
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
async function privateRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === "/")
    fail("invalid destination");
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    fail("invalid destination");
  return info;
}
export async function extractArchive(options) {
  let asset;
  try {
    asset = verifyManifest(options.manifestBytes, options.signature, options.policy);
  } catch {
    fail("authentication or manifest validation failed");
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    fail("invalid cancellation signal");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120000);
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const check = () => {
    if (controller.signal.aborted) fail(timedOut ? "deadline exceeded" : "cancelled");
  };
  let archive,
    archiveIdentity,
    rootIdentity,
    stagingRoot,
    stagingIdentity,
    currentFile,
    gunzip,
    source,
    completed;
  let result;
  const errors = [];
  try {
    check();
    rootIdentity = await privateRoot(options.destinationRoot);
    if (typeof options.archivePath !== "string" || !isAbsolute(options.archivePath))
      fail("invalid archive path");
    archive = await open(
      options.archivePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    archiveIdentity = await archive.stat();
    if (
      !archiveIdentity.isFile() ||
      archiveIdentity.nlink !== 1 ||
      archiveIdentity.size !== asset.size
    )
      fail("invalid compressed archive");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < asset.size) {
      check();
      const { bytesRead } = await archive.read(
        buffer,
        0,
        Math.min(buffer.length, asset.size - offset),
        offset,
      );
      if (!bytesRead) fail("compressed archive truncated");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (hash.digest("hex") !== asset.sha256 || !sameArchive(archiveIdentity, await archive.stat()))
      fail("compressed archive digest or identity mismatch");
    check();
    // No extraction tree or file exists until the complete compressed digest passes.
    stagingRoot = await mkdtemp(join(options.destinationRoot, "gpui-extract-"));
    stagingIdentity = await lstat(stagingRoot);
    if (!sameDirectory(rootIdentity, await lstat(options.destinationRoot)))
      fail("destination changed");
    const secondHash = createHash("sha256");
    let compressed = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        compressed += chunk.length;
        if (compressed > asset.size) return callback(new ExtractError("compressed size exceeded"));
        secondHash.update(chunk);
        callback(null, chunk);
      },
    });
    gunzip = createGunzip({ chunkSize: 65536 });
    source = archive.createReadStream({
      start: 0,
      end: asset.size - 1,
      autoClose: false,
      highWaterMark: 65536,
    });
    completed = pipeline(source, meter, gunzip, { signal: controller.signal });
    // Observe immediately; the parser below is the final readable consumer.
    completed.catch(() => {});
    const iterator = gunzip[Symbol.asyncIterator]();
    let pending = Buffer.alloc(0),
      expanded = 0,
      eof = false;
    const next = async () => {
      check();
      const step = await iterator.next();
      if (step.done) {
        eof = true;
        return;
      }
      expanded += step.value.length;
      if (expanded > LIMIT) fail("expanded size exceeded");
      pending = step.value;
    };
    const take = async (size) => {
      const pieces = [];
      let remaining = size;
      while (remaining) {
        if (!pending.length) {
          if (eof) fail("truncated tar");
          await next();
          if (eof) fail("truncated tar");
        }
        const n = Math.min(remaining, pending.length);
        pieces.push(pending.subarray(0, n));
        pending = pending.subarray(n);
        remaining -= n;
      }
      return pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size);
    };
    const paths = new Set(),
      aliases = new Set(),
      directories = new Set();
    let count = 0;
    for (;;) {
      check();
      const block = await take(512);
      if (zero(block)) {
        if (!zero(await take(512))) fail("missing second end block");
        break;
      }
      if (++count > 10000) fail("entry limit exceeded");
      const entry = header(block);
      if (paths.has(entry.path) || aliases.has(entry.path.toLowerCase()))
        fail("duplicate or aliased entry");
      if (count === 1 && entry.path !== ROOT) fail("missing explicit app root");
      if (entry.path !== ROOT && !directories.has(dirname(entry.path)))
        fail("missing or unsafe parent directory");
      paths.add(entry.path);
      aliases.add(entry.path.toLowerCase());
      const destination = join(stagingRoot, entry.path);
      if (entry.directory) {
        await mkdir(destination, { mode: 0o700 });
        directories.add(entry.path);
      } else {
        currentFile = await open(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        let remaining = entry.size;
        while (remaining) {
          check();
          const chunk = await take(Math.min(65536, remaining));
          let written = 0;
          while (written < chunk.length) {
            check();
            const part = await currentFile.write(chunk, written, chunk.length - written);
            if (!part.bytesWritten) fail("file write failed");
            written += part.bytesWritten;
          }
          remaining -= chunk.length;
        }
        const padding = (512 - (entry.size % 512)) % 512;
        if (padding && !zero(await take(padding))) fail("nonzero entry padding");
        await currentFile.chmod(entry.mode & 0o111 ? 0o755 : 0o644);
        await currentFile.close();
        currentFile = undefined;
      }
    }
    if (!count) fail("empty archive");
    for (;;) {
      check();
      if (!zero(pending)) fail("trailing tar data");
      pending = Buffer.alloc(0);
      if (eof) break;
      await next();
    }
    await completed;
    if (
      compressed !== asset.size ||
      secondHash.digest("hex") !== asset.sha256 ||
      !sameArchive(archiveIdentity, await archive.stat())
    )
      fail("compressed archive changed");
    for (const path of directories) {
      check();
      await chmod(join(stagingRoot, path), 0o755);
    }
    if (
      !sameDirectory(rootIdentity, await lstat(options.destinationRoot)) ||
      !sameDirectory(stagingIdentity, await lstat(stagingRoot))
    )
      fail("destination changed");
    check();
    result = Object.freeze({ stagingRoot, appPath: join(stagingRoot, ROOT) });
  } catch (error) {
    errors.push(
      error instanceof ExtractError
        ? error
        : new ExtractError(
            controller.signal.aborted ? (timedOut ? "deadline exceeded" : "cancelled") : "failed",
          ),
    );
  } finally {
    controller.abort();
    gunzip?.destroy();
    source?.destroy();
    if (completed) await completed.catch(() => {});
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    for (const handle of [currentFile, archive])
      if (handle) {
        try {
          await handle.close();
        } catch {
          errors.push(new ExtractError("file cleanup failed"));
        }
      }
    if (errors.length && stagingRoot) {
      try {
        if (
          !stagingIdentity ||
          !sameDirectory(rootIdentity, await lstat(options.destinationRoot)) ||
          !sameDirectory(stagingIdentity, await lstat(stagingRoot))
        )
          fail("cleanup ownership uncertain");
        await rm(stagingRoot, { recursive: true });
      } catch {
        errors.push(new ExtractError("staging cleanup failed; retained for owner inspection"));
      }
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, "Archive extraction and cleanup failed");
  if (errors.length) throw errors[0];
  return result;
}
