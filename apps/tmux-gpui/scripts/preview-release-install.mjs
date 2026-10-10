// Component API only; no runnable unsigned installer, endpoints or default trust policy.
// Test dependency injection is not exposed through a CLI. Production defaults always
// verify the transaction's copied app with the macOS verifier before activation.
import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve, dirname, basename, sep } from "node:path";
import { verifyManifest } from "./preview-release-manifest.mjs";
import { downloadArchive } from "./preview-release-download.mjs";
import { extractArchive } from "./preview-release-extract.mjs";
import { installApp } from "./install-transaction.mjs";
import { verifyMacApp } from "./mac-app-verifier.mjs";
const fail = (message) => {
  throw new Error(message);
};
function bytes(value, maximum) {
  if (!(value instanceof Uint8Array) || value.byteLength > maximum)
    fail("Invalid release authentication bytes");
  return Buffer.from(value);
}
function canonical(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path === sep || resolve(path) !== path)
    fail("Canonical absolute release paths required");
  return path;
}
const sameDirectory = (a, b) =>
  b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
async function paths(staging, installation) {
  canonical(staging);
  canonical(installation);
  const info = await lstat(staging);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (await realpath(staging)) !== staging
  )
    fail("Private canonical staging directory required");
  if (
    !(await lstat(dirname(installation))).isDirectory() ||
    (await realpath(dirname(installation))) !== dirname(installation)
  )
    fail("Canonical existing install parent required");
  try {
    const current = await lstat(installation);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (await realpath(installation)) !== installation
    )
      fail("Canonical install directory required");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    staging === installation ||
    staging.startsWith(installation + sep) ||
    installation.startsWith(staging + sep)
  )
    fail("Staging and installation must not overlap");
  return info;
}
export async function installRelease(
  options,
  { fetchImpl = fetch, verifyApp = verifyMacApp, platform = process.platform } = {},
) {
  // Capture caller policy/bytes once. No caller object is used after asynchronous work begins.
  const policy = Object.freeze({
    publicKey: bytes(options.policy?.publicKey, 32),
    expectedVersion: options.policy?.expectedVersion,
  });
  const manifestBytes = bytes(options.manifestBytes, 65536),
    signature = bytes(options.signature, 64);
  const asset = verifyManifest(manifestBytes, signature, policy);
  const version = policy.expectedVersion;
  if (platform !== "darwin") fail("Release installation requires macOS");
  const applePolicy = Object.freeze({
    teamId: options.applePolicy?.teamId,
    bundleId: options.applePolicy?.bundleId,
    architecture: options.applePolicy?.architecture,
    minimumMacOS: options.applePolicy?.minimumMacOS,
  });
  if (
    asset.target !== "aarch64-apple-darwin" ||
    applePolicy.architecture !== "arm64" ||
    typeof applePolicy.teamId !== "string" ||
    !/^[A-Z0-9]{10}$/.test(applePolicy.teamId) ||
    typeof applePolicy.bundleId !== "string" ||
    !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(applePolicy.bundleId) ||
    applePolicy.bundleId.length > 255 ||
    typeof applePolicy.minimumMacOS !== "string" ||
    !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(applePolicy.minimumMacOS)
  )
    fail("Explicit matching Apple release policy required");
  if (!Array.isArray(options.redirectOrigins) || options.redirectOrigins.length > 16)
    fail("Explicit redirect origin policy required");
  const destinationRoot = options.destinationRoot,
    installRoot = options.installRoot;
  const downloadOptions = Object.freeze({
    manifestBytes,
    signature,
    policy,
    baseUrl: options.baseUrl,
    redirectOrigins: Object.freeze([...options.redirectOrigins]),
    destinationRoot,
    signal: options.signal,
  });
  const parentIdentity = await paths(destinationRoot, installRoot);
  const owned = [];
  const errors = [];
  let activationState = "not-attempted",
    installed;
  async function remember(root) {
    if (dirname(root) !== destinationRoot || !basename(root).startsWith("gpui-"))
      fail("Unexpected release staging ownership");
    const entry = { root, identity: undefined };
    owned.push(entry);
    const identity = await lstat(root);
    if (!identity.isDirectory() || identity.isSymbolicLink())
      fail("Invalid release staging ownership");
    entry.identity = identity;
  }
  try {
    const downloaded = await downloadArchive(downloadOptions, { fetchImpl });
    await remember(downloaded.stagingRoot);
    const extracted = await extractArchive({
      archivePath: downloaded.archivePath,
      manifestBytes,
      signature,
      policy,
      destinationRoot,
      signal: downloadOptions.signal,
    });
    await remember(extracted.stagingRoot);
    if (downloadOptions.signal?.aborted) fail("Release installation cancelled before transaction");
    activationState = "unknown";
    installed = await installApp({
      installRoot,
      stagedApp: extracted.appPath,
      version,
      verify: async (copy) => {
        if (downloadOptions.signal?.aborted)
          fail("Release installation cancelled before verification");
        const verified = await verifyApp(copy, applePolicy, { expectedVersion: version });
        if (downloadOptions.signal?.aborted)
          fail("Release installation cancelled after verification");
        return verified;
      },
      beforeActivate: () => {
        if (downloadOptions.signal?.aborted)
          fail("Release installation cancelled before activation");
      },
    });
    activationState = "confirmed";
  } catch (error) {
    errors.push(error);
  } finally {
    for (const { root, identity } of owned.reverse()) {
      try {
        if (
          !identity ||
          !sameDirectory(parentIdentity, await lstat(destinationRoot)) ||
          !sameDirectory(identity, await lstat(root))
        )
          fail("Release staging ownership changed");
        await rm(root, { recursive: true });
      } catch (error) {
        errors.push(
          new Error("Release staging cleanup failed; owner inspection required", { cause: error }),
        );
      }
    }
  }
  if (errors.length) {
    const error = new AggregateError(
      errors,
      activationState === "confirmed"
        ? "Release is active; staging cleanup failed (activation was not rolled back)"
        : "Release installation failed; inspect errors and activation state",
    );
    error.activationState = activationState;
    error.installed = installed;
    throw error;
  }
  return Object.freeze({ ...installed });
}
