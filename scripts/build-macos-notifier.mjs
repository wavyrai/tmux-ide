#!/usr/bin/env node
/** Build the universal, appearance-aware native macOS notification helper. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("build-macos-notifier must run on macOS with Xcode 26 or newer");
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sourceDir = join(root, "native", "macos", "notifier");
const outputFlag = process.argv.indexOf("--output");
const versionFlag = process.argv.indexOf("--version");
const appPath = resolve(
  outputFlag === -1
    ? join(root, "packages", "daemon", "dist", "native", "TmuxIdeNotifier.app")
    : process.argv[outputFlag + 1],
);
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = String(
  versionFlag === -1 ? packageJson.version || "1.0.0" : process.argv[versionFlag + 1],
);
const buildVersion = /^\d+(?:\.\d+){0,2}/.exec(version)?.[0] ?? "1";
const signingIdentity = process.env.TMUX_IDE_CODESIGN_IDENTITY?.trim() || "-";
const scratch = mkdtempSync(join(tmpdir(), "tmux-ide-notifier-"));

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

try {
  const contents = join(appPath, "Contents");
  const macosDir = join(contents, "MacOS");
  const resourcesDir = join(contents, "Resources");
  const stagedIcon = join(scratch, "AppIcon.icon");
  const armBinary = join(scratch, "tmux-ide-notifier-arm64");
  const x64Binary = join(scratch, "tmux-ide-notifier-x86_64");
  const universalBinary = join(macosDir, "tmux-ide-notifier");

  rmSync(appPath, { recursive: true, force: true });
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });
  cpSync(join(sourceDir, "AppIcon.icon"), stagedIcon, { recursive: true });

  const swiftArgs = (target, output) => [
    "swiftc",
    "-O",
    "-parse-as-library",
    "-swift-version",
    "5",
    "-target",
    target,
    "-framework",
    "AppKit",
    "-framework",
    "UserNotifications",
    "-framework",
    "Security",
    join(sourceDir, "TmuxIdeNotifier.swift"),
    "-o",
    output,
  ];
  run("xcrun", swiftArgs("arm64-apple-macos11.0", armBinary));
  run("xcrun", swiftArgs("x86_64-apple-macos11.0", x64Binary));
  run("xcrun", ["lipo", "-create", armBinary, x64Binary, "-output", universalBinary]);
  chmodSync(universalBinary, 0o755);

  run("xcrun", [
    "actool",
    stagedIcon,
    "--compile",
    resourcesDir,
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    "11.0",
    "--target-device",
    "mac",
    "--app-icon",
    "AppIcon",
    "--standalone-icon-behavior",
    "all",
    "--output-partial-info-plist",
    join(scratch, "icon-partial.plist"),
    "--warnings",
    "--notices",
    "--errors",
    "--output-format",
    "human-readable-text",
  ]);

  const plist = readFileSync(join(sourceDir, "Info.plist"), "utf8")
    // Apple bundle versions are numeric even when the npm release carries a
    // prerelease suffix (for example 2.8.0-beta.1).
    .replaceAll("__VERSION__", buildVersion)
    .replaceAll("__BUILD_VERSION__", buildVersion);
  writeFileSync(join(contents, "Info.plist"), plist);
  writeFileSync(join(contents, "PkgInfo"), "APPL????");

  // Portable release artifacts use an ad-hoc signature plus the helper's
  // native compatibility delivery. A release environment can provide a
  // Developer ID identity as part of a signed + notarized distribution; that
  // makes the modern UNUserNotificationCenter path eligible at runtime.
  const signArgs =
    signingIdentity === "-"
      ? ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]
      : [
          "--force",
          "--deep",
          "--options",
          "runtime",
          "--sign",
          signingIdentity,
          "--timestamp",
          appPath,
        ];
  run("codesign", signArgs);
  run("codesign", ["--verify", "--deep", "--strict", appPath]);

  const architectures = new Set(output("xcrun", ["lipo", "-archs", universalBinary]).split(/\s+/));
  for (const architecture of ["arm64", "x86_64"]) {
    if (!architectures.has(architecture)) {
      throw new Error(`native notifier is missing ${architecture}`);
    }
  }

  const assetInfo = JSON.parse(
    output("xcrun", ["assetutil", "--info", join(resourcesDir, "Assets.car")]),
  );
  const iconAppearances = new Set(
    assetInfo.filter((entry) => entry.AssetType === "IconGroup").map((entry) => entry.Appearance),
  );
  for (const appearance of ["NSAppearanceNameAqua", "NSAppearanceNameDarkAqua"]) {
    if (!iconAppearances.has(appearance)) {
      throw new Error(`native notifier icon is missing ${appearance}`);
    }
  }

  console.log(
    `[build-macos-notifier] wrote ${appPath} (${[...architectures].join("+")}; Aqua+DarkAqua)`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
