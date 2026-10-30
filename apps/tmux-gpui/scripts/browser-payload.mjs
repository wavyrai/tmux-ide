// Copy development browser resources without importing framework symlinks into the outer app.
import { lstat, readdir, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
/** Resources/browser/terminal-browser. It runs on the engine's Node mode, never Resources/node. */
export const TERMINAL_BROWSER_LAUNCHER = [
  "#!/bin/sh",
  "# The app bundles no Node: browser-launch.mjs runs in the browser engine's own Node mode.",
  "set -eu",
  "unset NODE_OPTIONS NODE_PATH ELECTRON_RUN_AS_NODE",
  'root=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd -P)',
  'fail() { echo "tmux-ide browser: $1" >&2; exit 1; }',
  'requirement=\'=anchor apple generic and identifier "com.tmux-ide.browser" and certificate leaf[subject.OU] = "7HWMF997US"\'',
  'digest=$(/usr/bin/plutil -extract sha256 raw -o - "$root/runtime.json") || fail "invalid runtime metadata"',
  'case $digest in *[!0-9a-f]*) fail "invalid runtime metadata" ;; esac',
  '[ ${#digest} -eq 64 ] || fail "invalid runtime metadata"',
  'engine="$HOME/Library/Caches/tmux-ide-browser-engine/$digest/terminal-browser.app"',
  'if /usr/bin/codesign --verify --deep --strict -R "$requirement" "$engine" 2>/dev/null; then',
  '  ELECTRON_RUN_AS_NODE=1 exec "$engine/Contents/MacOS/terminal-browser" "$root/browser-launch.mjs" "$@"',
  "fi",
  "# First launch: unpack the bundled runtime privately to run the loader, which installs the cache.",
  'actual=$(/usr/bin/shasum -a 256 "$root/browser-runtime.tar.gz") || fail "unreadable browser runtime"',
  '[ "${actual%% *}" = "$digest" ] || fail "browser runtime does not match its metadata"',
  'staging=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/tmux-ide-browser.XXXXXX")',
  "trap '/bin/rm -rf \"$staging\"' EXIT",
  "trap 'exit 130' INT",
  "trap 'exit 143' TERM",
  '/usr/bin/tar -xzf "$root/browser-runtime.tar.gz" -C "$staging" || fail "browser runtime extraction failed"',
  '/usr/bin/codesign --verify --deep --strict -R "$requirement" "$staging/terminal-browser.app" ||',
  '  fail "browser runtime signature is not valid"',
  'ELECTRON_RUN_AS_NODE=1 "$staging/terminal-browser.app/Contents/MacOS/terminal-browser" "$root/browser-launch.mjs" "$@"',
  "",
].join("\n");
export async function browserPayloadInventory(root) {
  const files = {};
  let total = 0;
  async function visit(relative) {
    const path = join(root, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error("Browser payload links are unsupported");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile() && info.nlink === 1) {
      total += info.size;
      if (total > 512 * 1024 * 1024 || Object.keys(files).length >= 10000)
        throw Error("Browser payload exceeds limits");
      files[relative] = {
        bytes: info.size,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
    } else throw Error("Unsupported browser payload entry");
  }
  await visit("");
  for (const required of [
    "terminal-browser",
    "browser-launch.mjs",
    "runtime.json",
    "browser-runtime.tar.gz",
    "cli/dist/main.js",
    "browser/dist/main.js",
    "ASSEMBLY.json",
  ])
    if (!files[required]) throw Error(`Missing browser payload file: ${required}`);
  return files;
}
/** A payload built for the bundled Node would exec a Resources/node the app no longer has. */
export function assertCurrentBrowserLauncher(text) {
  if (text !== TERMINAL_BROWSER_LAUNCHER)
    throw Error("The browser payload's launcher is outdated: rebuild the payload");
}
export async function copyBrowserPayload(source, destination) {
  const before = await browserPayloadInventory(source);
  await mkdir(destination);
  try {
    for (const path of Object.keys(before)) {
      const parts = path.split("/");
      parts.pop();
      if (parts.length) await mkdir(join(destination, ...parts), { recursive: true });
      await copyFile(join(source, path), join(destination, path));
    }
    const after = await browserPayloadInventory(destination);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error("Browser payload changed during assembly");
    return after;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
