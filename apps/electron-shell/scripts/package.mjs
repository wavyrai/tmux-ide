import { execFile } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { selectRenderer, verifyRendererManifest } from "./renderer-artifact.mjs";
import { stageNativeTmux, nativeTmuxDirectory } from "./native-tmux-package.mjs";
import { validateBundledTmux } from "../../../packages/daemon/src/lib/bundled-tmux.ts";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const staging = join(packageRoot, "dist", "package");
const release = join(packageRoot, "release");
const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const electronRoot = join(packageRoot, "node_modules", "electron");
const electronDist = join(electronRoot, "dist");
const renderer = selectRenderer(process.argv.slice(2));
await verifyRendererManifest(join(packageRoot, "dist"), renderer);

await rm(staging, { recursive: true, force: true });
await rm(release, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await Promise.all([
  cp(join(packageRoot, "dist", "main.cjs"), join(staging, "main.cjs")),
  cp(join(packageRoot, "dist", "preload.cjs"), join(staging, "preload.cjs")),
  cp(join(packageRoot, "dist", "renderer-manifest.json"), join(staging, "renderer-manifest.json")),
  cp(join(packageRoot, "dist", "daemon-child.cjs"), join(staging, "daemon-child.cjs")),
  cp(join(packageRoot, "dist", "renderer"), join(staging, "renderer"), { recursive: true }),
  cp(join(packageRoot, "dist", "templates"), join(staging, "templates"), { recursive: true }),
]);

// macOS packages must be self-contained when opened outside a login shell.
if (process.platform === "darwin") await stageNativeTmux(repoRoot, staging);

const nodePtyRoot = dirname(requireFromHere.resolve("node-pty/package.json"));
const nodePtyTarget = join(staging, "node_modules", "node-pty");
const honoNodeServerRoot = dirname(dirname(requireFromHere.resolve("@hono/node-server")));
const honoNodeServerTarget = join(staging, "node_modules", "@hono", "node-server");
// @hono/node-server loads hono/ws at runtime; copying only the adapter works
// inside a checkout but fails once the app is detached from node_modules.
const honoRoot = dirname(dirname(dirname(requireFromHere.resolve("hono"))));
const honoTarget = join(staging, "node_modules", "hono");
const nativePlatform = `${process.platform}-${process.arch}`;
const nativeSource = join(nodePtyRoot, "prebuilds", nativePlatform);
await access(join(nativeSource, "pty.node"));
await Promise.all([
  mkdir(nodePtyTarget, { recursive: true }),
  mkdir(honoNodeServerTarget, { recursive: true }),
  mkdir(honoTarget, { recursive: true }),
]);
await Promise.all([
  cp(join(nodePtyRoot, "LICENSE"), join(nodePtyTarget, "LICENSE")),
  cp(join(nodePtyRoot, "package.json"), join(nodePtyTarget, "package.json")),
  cp(join(nodePtyRoot, "lib"), join(nodePtyTarget, "lib"), { recursive: true }),
  cp(nativeSource, join(nodePtyTarget, "prebuilds", nativePlatform), { recursive: true }),
  cp(join(honoNodeServerRoot, "LICENSE"), join(honoNodeServerTarget, "LICENSE")),
  cp(join(honoNodeServerRoot, "package.json"), join(honoNodeServerTarget, "package.json")),
  cp(join(honoNodeServerRoot, "dist"), join(honoNodeServerTarget, "dist"), {
    recursive: true,
  }),
  cp(join(honoRoot, "package.json"), join(honoTarget, "package.json")),
  cp(join(honoRoot, "LICENSE"), join(honoTarget, "LICENSE")),
  cp(join(honoRoot, "dist"), join(honoTarget, "dist"), { recursive: true }),
]);
if (process.platform !== "win32") {
  await chmod(join(nodePtyTarget, "prebuilds", nativePlatform, "spawn-helper"), 0o755);
}
await writeFile(
  join(staging, "package.json"),
  `${JSON.stringify(
    {
      name: "tmux-ide-desktop",
      productName: "tmux-ide",
      version: rootPackage.version,
      private: true,
      main: "main.cjs",
    },
    null,
    2,
  )}\n`,
);

const output = join(release, `tmux-ide-${process.platform}-${process.arch}`);
let appPath = output;
let executablePath;
let resourcesPath;

await mkdir(output, { recursive: true });
if (process.platform === "darwin") {
  appPath = join(output, "tmux-ide.app");
  await cp(join(electronDist, "Electron.app"), appPath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  executablePath = join(appPath, "Contents", "MacOS", "Electron");
  resourcesPath = join(appPath, "Contents", "Resources");
  const plistPath = join(appPath, "Contents", "Info.plist");
  const plist = (await readFile(plistPath, "utf8"))
    .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]+/u, "$1tmux-ide")
    .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+/u, "$1dev.tmux-ide.desktop")
    .replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+/u,
      `$1${rootPackage.version}`,
    )
    .replace(/(<key>CFBundleVersion<\/key>\s*<string>)[^<]+/u, `$1${rootPackage.version}`);
  await writeFile(plistPath, plist);
} else {
  await cp(electronDist, appPath, { recursive: true, verbatimSymlinks: true });
  const executableName = process.platform === "win32" ? "electron.exe" : "electron";
  executablePath = join(appPath, executableName);
  resourcesPath = join(appPath, "resources");
}

await rm(join(resourcesPath, "app"), { recursive: true, force: true });
await cp(staging, join(resourcesPath, "app"), { recursive: true });

// This is a local smoke-capable package. Distribution identities/notarization
// belong to release engineering, but the modified macOS bundle must still have
// a coherent ad-hoc signature.
if (process.platform === "darwin") {
  await execFileAsync("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  await execFileAsync("codesign", ["--verify", "--deep", "--strict", appPath]);
  // Signing must not invalidate the native distribution integrity contract.
  validateBundledTmux(nativeTmuxDirectory(join(resourcesPath, "app")));
}

await writeFile(
  join(release, "package-path.json"),
  `${JSON.stringify({ appPath, executablePath, renderer }, null, 2)}\n`,
);
console.log(`Packaged desktop app: ${appPath}`);
