// Explicit native research inputs; no download, vendoring or production build hook.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const archive = process.env.GHOSTTY_ARCHIVE;
const include = process.env.GHOSTTY_INCLUDE;
const nodeInclude = process.env.NODE_INCLUDE;
const output = process.env.GHOSTTY_ADDON_OUTPUT || "/tmp/tmi-ghostty-electron/addon.node";
if (process.platform !== "darwin") throw new Error("This experiment requires macOS");
for (const [name, path] of Object.entries({
  GHOSTTY_ARCHIVE: archive,
  GHOSTTY_INCLUDE: include,
  NODE_INCLUDE: nodeInclude,
})) {
  if (!path || !existsSync(path))
    throw new Error(`${name} must explicitly name an existing local input`);
}
if (!existsSync(resolve(include, "ghostty.h")) || !existsSync(resolve(nodeInclude, "node_api.h")))
  throw new Error("Missing headers");
mkdirSync(dirname(output), { recursive: true });
const args = [
  "clang++",
  "-std=c++17",
  "-fobjc-arc",
  "-fblocks",
  "-O2",
  "-g",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-mmacosx-version-min=13.0",
  "-I",
  nodeInclude,
  "-I",
  include,
  fileURLToPath(new URL("./addon.mm", import.meta.url)),
  archive,
  ...[
    "AppKit",
    "Foundation",
    "Metal",
    "QuartzCore",
    "CoreText",
    "CoreGraphics",
    "CoreFoundation",
    "IOSurface",
    "Carbon",
  ].flatMap((x) => ["-framework", x]),
  "-lc++",
  "-lz",
  "-o",
  output,
];
const result = spawnSync("xcrun", args, { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status || 1);
console.log(output);
