// Authenticated archive staging only: no extraction, installation or candidate execution.
// Caller supplies trusted origins/key policy and owns cleanup of a successful stagingRoot.
// Private-root permissions exclude other users; hostile same-user filesystem races and
// uninterruptible filesystem syscalls are not a sandbox or hard wall-clock guarantee.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath, mkdtemp, open, rm } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { verifyManifest } from "./preview-release-manifest.mjs";
class DownloadError extends Error {
  constructor(code) {
    super(`Archive download ${code}`);
  }
}
const fail = (code) => {
  throw new DownloadError(code);
};
function httpsUrl(value, allowQuery = false) {
  if (typeof value !== "string" || value.length > 4096) fail("invalid URL policy");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid URL policy");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (!allowQuery && url.search) ||
    url.hash
  )
    fail("invalid URL policy");
  return url;
}
function sameDirectory(a, b) {
  return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
}
async function privateRoot(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === "/")
    fail("invalid destination root");
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (await realpath(path)) !== path
  )
    fail("invalid destination root");
  return info;
}
export async function downloadArchive(options, { fetchImpl = fetch } = {}) {
  // Authentication is deliberately first: no fetch or filesystem operation precedes it.
  let asset;
  try {
    asset = verifyManifest(options.manifestBytes, options.signature, options.policy);
  } catch {
    fail("authentication or manifest validation failed");
  }
  const version = options.policy.expectedVersion;
  const base = httpsUrl(options.baseUrl);
  if (
    !base.pathname.endsWith("/") ||
    !Array.isArray(options.redirectOrigins) ||
    options.redirectOrigins.length > 16
  )
    fail("invalid URL policy");
  const origins = new Set([base.origin]);
  for (const value of options.redirectOrigins) {
    const origin = httpsUrl(value);
    if (origin.pathname !== "/") fail("invalid redirect origin");
    origins.add(origin.origin);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    fail("invalid cancellation signal");
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 120000);
  const callerAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", callerAbort, { once: true });
  const check = () => {
    if (controller.signal.aborted) fail(timedOut ? "deadline exceeded" : "cancelled");
  };
  // Race headers and each body read even if an injected transport ignores AbortSignal.
  const bounded = async (operation) => {
    check();
    let onAbort;
    const abort = new Promise((_, reject) => {
      onAbort = () => reject(new DownloadError(timedOut ? "deadline exceeded" : "cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation(), abort]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
  };
  const discard = async (response) => {
    if (response.body) await bounded(() => response.body.cancel());
  };
  let rootIdentity, stagingRoot, stagingIdentity, file, reader, result;
  const errors = [];
  try {
    check();
    rootIdentity = await privateRoot(options.destinationRoot);
    check();
    stagingRoot = await mkdtemp(join(options.destinationRoot, "gpui-download-"));
    stagingIdentity = await lstat(stagingRoot);
    if (!sameDirectory(rootIdentity, await lstat(options.destinationRoot)))
      fail("destination changed");
    const archivePath = join(stagingRoot, asset.name);
    file = await open(
      archivePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let url = new URL(asset.name, base),
      response;
    for (let redirects = 0; ; redirects++) {
      response = await bounded(async () => {
        const received = await fetchImpl(url.href, {
          method: "GET",
          redirect: "manual",
          headers: { "Accept-Encoding": "identity" },
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void received.body?.cancel().catch(() => {});
          check();
        }
        return received;
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await discard(response);
      if (redirects >= 3) fail("redirect limit exceeded");
      const location = response.headers.get("location");
      if (!location || location.length > 4096) fail("invalid redirect");
      url = httpsUrl(new URL(location, url).href, true);
      if (!origins.has(url.origin)) fail("untrusted redirect origin");
    }
    if (response.status !== 200) {
      await discard(response);
      fail("HTTP response refused");
    }
    if (
      (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase() !== "identity"
    ) {
      await discard(response);
      fail("encoded response refused");
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^[0-9]{1,12}$/.test(declared) || Number(declared) !== asset.size)) {
      await discard(response);
      fail("declared size mismatch");
    }
    if (!response.body) fail("missing response body");
    reader = response.body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    for (;;) {
      const { done, value } = await bounded(() => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > asset.size - size)
        fail("body size exceeded");
      size += value.byteLength;
      hash.update(value);
      let written = 0;
      while (written < value.byteLength) {
        check();
        const { bytesWritten } = await file.write(value, written, value.byteLength - written);
        if (bytesWritten === 0) fail("archive write failed");
        written += bytesWritten;
      }
    }
    check();
    if (size !== asset.size) fail("body truncated");
    if (hash.digest("hex") !== asset.sha256) fail("digest mismatch");
    await file.close();
    file = undefined;
    if (
      !sameDirectory(rootIdentity, await lstat(options.destinationRoot)) ||
      !sameDirectory(stagingIdentity, await lstat(stagingRoot))
    )
      fail("destination changed");
    check();
    result = Object.freeze({ archivePath, stagingRoot, asset, version });
  } catch (error) {
    errors.push(error instanceof DownloadError ? error : new DownloadError("failed"));
  } finally {
    controller.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", callerAbort);
    if (reader) void reader.cancel().catch(() => {});
    if (file) {
      try {
        await file.close();
      } catch {
        errors.push(new DownloadError("file cleanup failed"));
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
        errors.push(new DownloadError("staging cleanup failed; retained for owner inspection"));
      }
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, "Archive download and cleanup failed");
  if (errors.length) throw errors[0];
  return result;
}
