// Private runtime cache for the payload shipped inside the signed tmux-ide app.
// The caller supplies metadata from that bundle, never downloaded metadata.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { extractBrowserRuntime } from "./browser-runtime-extract.mjs";
const execute = promisify(execFile);
const requirement =
  '=anchor apple generic and identifier "com.tmux-ide.browser" and certificate leaf[subject.OU] = "7HWMF997US"';

async function directory(path, privateMode = false) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    info.uid !== process.getuid() ||
    (privateMode && info.mode & 0o077)
  ) {
    throw new Error("Browser runtime cache is not an owned directory");
  }
}
async function verify(appPath, signal) {
  await directory(appPath);
  await execute(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "-R", requirement, appPath],
    {
      timeout: 60000,
      maxBuffer: 65536,
      signal,
    },
  );
}

export async function loadBrowserRuntime(options) {
  if (process.platform !== "darwin") throw new Error("The bundled browser runtime requires macOS");
  const { destinationRoot, metadata, signal } = options;
  if (
    typeof destinationRoot !== "string" ||
    !isAbsolute(destinationRoot) ||
    resolve(destinationRoot) !== destinationRoot ||
    !/^[a-f0-9]{64}$/.test(metadata?.sha256)
  ) {
    throw new Error("Invalid browser runtime cache request");
  }
  signal?.throwIfAborted();
  await directory(destinationRoot, true);
  const cache = join(destinationRoot, metadata.sha256);
  const appPath = join(cache, "terminal-browser.app");
  let exists = true;
  try {
    await lstat(cache);
  } catch (error) {
    if (error.code === "ENOENT") exists = false;
    else throw error;
  }
  if (exists) {
    await directory(cache, true);
    await verify(appPath, signal);
    return appPath;
  }
  const staged = await extractBrowserRuntime(options);
  try {
    await verify(staged.appPath, signal);
    signal?.throwIfAborted();
    // A complete verified tree becomes visible atomically. Concurrent launches
    // may install the same digest; verify the winner before using it.
    try {
      await rename(staged.stagingRoot, cache);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    }
    await directory(cache, true);
    await verify(appPath, signal);
    return appPath;
  } finally {
    await rm(staged.stagingRoot, { recursive: true, force: true });
  }
}
