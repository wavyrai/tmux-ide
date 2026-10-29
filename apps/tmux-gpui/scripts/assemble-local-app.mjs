#!/usr/bin/env node
// Local assembly only; optional explicit metadata is a pre-signing input. Release signing and complete license qualification are separate gates.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, copyFile, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { verifyNativeBuildReceipt } from "./native-build-receipt.mjs";
import { readBundleMetadata, bundlePlist } from "./app-bundle-metadata.mjs";
import { copyBrowserPayload } from "./browser-payload.mjs";
const run = promisify(execFile);
const flags = process.argv.slice(5);
const options = new Map();
for (let i = 0; i < flags.length; i += 2) {
  if (
    !["--metadata", "--browser-payload", "--node", "--node-license"].includes(flags[i]) ||
    !flags[i + 1] ||
    options.has(flags[i])
  )
    throw new Error("Invalid or duplicate app assembly option");
  options.set(flags[i], resolve(flags[i + 1]));
}
if (process.platform !== "darwin" || process.argv.length < 5)
  throw new Error(
    "macOS only: assemble-local-app.mjs NATIVE_BINARY BUILD_RECEIPT.json NEW_APP.app [--metadata METADATA.json] [--node NODE24_BINARY --node-license NODE_LICENSE] [--browser-payload PREPARED_DIRECTORY]",
  );
// The default bundle has no Node: the native app never starts it. --node opts a
// development bundle into the legacy helper routes and the Node-run browser payload.
if (options.has("--node") !== options.has("--node-license"))
  throw new Error("--node and --node-license must be given together");
if (options.has("--browser-payload") && !options.has("--node"))
  throw new Error("The browser payload runs on the bundled Node: add --node and --node-license");
const node = options.get("--node"),
  nodeLicense = options.get("--node-license");
const [native, receipt, output] = process.argv.slice(2, 5).map((p) => resolve(p));
if (!output.endsWith(".app")) throw new Error("Output must be a new .app directory");
const metadata = options.has("--metadata")
  ? await readBundleMetadata(options.get("--metadata"))
  : undefined;
const project = fileURLToPath(new URL("../", import.meta.url));
// Verify source/binary consistency before executing either supplied binary.
await verifyNativeBuildReceipt(receipt, native, join(project, "upstream"));
// Check build-time palette parity without starting a runtime metadata helper.
await run(
  process.execPath,
  ["--import", "tsx", join(project, "scripts/generate-native-appearance.ts"), "--check"],
  { cwd: join(project, "../..") },
);
const version = node && (await run(node, ["--version"])).stdout.trim();
if (node && !/^v24\./.test(version)) throw new Error("Node 24 is required");
const identity = (await run(native, ["--version"])).stdout.trim();
if (!identity.startsWith("tmux-ide-gpui "))
  throw new Error("Expected dedicated tmux-ide executable");
if (
  node &&
  !(await readFile(nodeLicense, "utf8")).includes("Node.js is licensed for use as follows:")
)
  throw new Error("Supply Node's complete LICENSE file");
for (const binary of node ? [native, node] : [native]) {
  if ((await run("/usr/bin/lipo", ["-archs", binary])).stdout.trim() !== "arm64")
    throw new Error("Local preview requires ARM64 binaries");
  const libraries = (await run("/usr/bin/otool", ["-L", binary])).stdout
    .split("\n")
    .slice(1)
    .filter((line) => line.trim());
  if (libraries.some((line) => !/^\s+(\/System\/Library\/|\/usr\/lib\/)/.test(line)))
    throw new Error("Binary depends on an unbundled non-system library");
}
await mkdir(output); // Refuse existing apps; cleanup only this creation-owned directory.
try {
  const macos = join(output, "Contents/MacOS"),
    resources = join(output, "Contents/Resources");
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await copyFile(join(project, "assets/AppIcon.icns"), join(resources, "AppIcon.icns"));
  await copyFile(native, join(macos, "tmux-ide-gpui"));
  await copyFile(receipt, join(resources, "native-build-receipt.json"));
  await verifyNativeBuildReceipt(
    join(resources, "native-build-receipt.json"),
    join(macos, "tmux-ide-gpui"),
    join(project, "upstream"),
  );
  await chmod(join(macos, "tmux-ide-gpui"), 0o755);
  if (node) {
    await copyFile(node, join(resources, "node"));
    await chmod(join(resources, "node"), 0o755);
    await copyFile(nodeLicense, join(resources, "NODE-LICENSE"));
  }
  await copyFile(join(project, "BEZEL-NOTICE.md"), join(resources, "BEZEL-NOTICE.md"));
  await copyFile(join(project, "upstream/LICENSE"), join(resources, "HERDR-LICENSE"));
  await copyFile(join(project, "upstream/NOTICE"), join(resources, "HERDR-NOTICE"));
  await copyFile(resolve(project, "../../LICENSE"), join(resources, "TMUX-IDE-LICENSE"));
  // Preserve upstream's supplemental attribution even when a feature is not exposed.
  const supplementalNotices = {
    "APPEARANCE-LICENSE": "crates/tmux-ide-gpui/src/tmux_snapshot/appearance/catalog.LICENSE",
    "HERDR-PROTOCOL-LICENSE": "crates/herdr-protocol/LICENSE-APACHE",
    "HERDR-PROTOCOL-NOTICE": "crates/herdr-protocol/NOTICE.md",
    "HERDR-SOUND-NOTICE": "crates/tmux-ide-gpui/SOUND-NOTICE.md",
    "HERDR-GITHUB-NOTICE": "crates/tmux-ide-gpui/GITHUB-NOTICE.md",
    "OCTICONS-LICENSE": "assets/icons/LICENSE-octicons",
    "HEROICONS-LICENSE": "assets/icons/LICENSE-heroicons",
    "HEROICONS-PROVENANCE.json": "assets/icons/heroicons-provenance.json",
  };
  for (const [name, source] of Object.entries(supplementalNotices)) {
    await copyFile(join(project, "upstream", source), join(resources, name));
  }
  // Generate from the checkout lockfile; never reuse a potentially stale report.
  await run("python3", [
    join(project, "upstream/scripts/release/generate-notices.py"),
    join(resources, "RUST-THIRD-PARTY-NOTICES.txt"),
  ]);
  // The bridge payload runs only on Node, so it ships only beside it.
  if (node)
    await run(process.execPath, [
      join(project, "scripts/build-bridge.mjs"),
      join(resources, "bridge"),
    ]);
  await writeFile(
    join(macos, "tmux-ide-launcher"),
    `#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH
app_macos=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
resources="$app_macos/../Resources"
if [ "$#" -gt 1 ]; then
  echo 'Usage: tmux-ide-launcher [private-host.json]' >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  exec "$app_macos/tmux-ide-gpui" --tmux-native-local
fi
exec "$app_macos/tmux-ide-gpui" --tmux-browser-helper "$resources/node" "$resources/bridge/browser.bundle.mjs" "\${1:---local}"
`,
    { mode: 0o755 },
  );
  const browserFiles = options.has("--browser-payload")
    ? await copyBrowserPayload(options.get("--browser-payload"), join(resources, "browser"))
    : undefined;
  await writeFile(join(output, "Contents/Info.plist"), bundlePlist(metadata));
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  await writeFile(
    join(resources, metadata ? "assembly-manifest.json" : "development-manifest.json"),
    JSON.stringify(
      {
        version: 1,
        distribution: false,
        ...(browserFiles
          ? {
              browser: {
                files: browserFiles,
                scope: "development payload; separate browser qualification required",
              },
            }
          : {}),
        ...(metadata ? { metadata, scope: "pre-signing assembly; not a qualified release" } : {}),
        signing: "not-qualified",
        nativeIdentity: identity,
        ...(node ? { nodeVersion: version } : {}),
        nativeSha256: await digest(join(macos, "tmux-ide-gpui")),
        nativeBuild: {
          file: "native-build-receipt.json",
          sha256: await digest(join(resources, "native-build-receipt.json")),
          scope: "local source/binary consistency; not trusted build attestation",
        },
        icon: { file: "AppIcon.icns", sha256: await digest(join(resources, "AppIcon.icns")) },
        ...(node
          ? {
              nodeSha256: await digest(join(resources, "node")),
              nodeLicenseSha256: await digest(join(resources, "NODE-LICENSE")),
            }
          : {}),
        rustNotices: {
          file: "RUST-THIRD-PARTY-NOTICES.txt",
          sha256: await digest(join(resources, "RUST-THIRD-PARTY-NOTICES.txt")),
          scope: "locked workspace, all features, multi-platform superset",
        },
        remaining: [
          "complete third-party notices",
          "source commit provenance",
          "clean-machine qualification",
          "signing/notarization",
          "install/update",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await run("/usr/bin/plutil", ["-lint", join(output, "Contents/Info.plist")]);
  // Notice/bridge generation must not silently leave a stale source receipt.
  await verifyNativeBuildReceipt(
    join(resources, "native-build-receipt.json"),
    join(macos, "tmux-ide-gpui"),
    join(project, "upstream"),
  );
  console.log(`${metadata ? "Pre-signing preview" : "Local development"} app assembled: ${output}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
