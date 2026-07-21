import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const staging = join(packageRoot, "dist", "package");
const release = join(packageRoot, "release");
const rootPackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
const electronRoot = join(packageRoot, "node_modules", "electron");
const electronDist = join(electronRoot, "dist");

await rm(staging, { recursive: true, force: true });
await rm(release, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await Promise.all([
  cp(join(packageRoot, "dist", "main.cjs"), join(staging, "main.cjs")),
  cp(join(packageRoot, "dist", "preload.cjs"), join(staging, "preload.cjs")),
  cp(join(packageRoot, "dist", "renderer"), join(staging, "renderer"), { recursive: true }),
]);
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
}

await writeFile(
  join(release, "package-path.json"),
  `${JSON.stringify({ appPath, executablePath }, null, 2)}\n`,
);
console.log(`Packaged desktop app: ${appPath}`);
