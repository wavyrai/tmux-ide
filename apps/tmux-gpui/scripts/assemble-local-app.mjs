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
const run = promisify(execFile);
if (
  process.platform !== "darwin" ||
  ![7, 9].includes(process.argv.length) ||
  (process.argv.length === 9 && process.argv[7] !== "--metadata")
)
  throw new Error(
    "macOS only: assemble-local-app.mjs NATIVE_BINARY NODE24_BINARY NODE_LICENSE BUILD_RECEIPT.json NEW_APP.app [--metadata METADATA.json]",
  );
const [native, node, nodeLicense, receipt, output] = process.argv
  .slice(2, 7)
  .map((p) => resolve(p));
if (!output.endsWith(".app")) throw new Error("Output must be a new .app directory");
const metadata =
  process.argv.length === 9 ? await readBundleMetadata(resolve(process.argv[8])) : undefined;
const project = fileURLToPath(new URL("../", import.meta.url));
// Verify local source/binary consistency before executing the supplied native binary.
await verifyNativeBuildReceipt(receipt, native, join(project, "upstream"));
const version = (await run(node, ["--version"])).stdout.trim();
if (!/^v24\./.test(version)) throw new Error("Node 24 is required");
const identity = (await run(native, ["--version"])).stdout.trim();
if (!identity.startsWith("tmux-ide-gpui "))
  throw new Error("Expected dedicated tmux-ide executable");
const license = await readFile(nodeLicense, "utf8");
if (!license.includes("Node.js is licensed for use as follows:"))
  throw new Error("Supply Node's complete LICENSE file");
for (const binary of [native, node]) {
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
  await copyFile(native, join(macos, "tmux-ide-gpui"));
  await copyFile(receipt, join(resources, "native-build-receipt.json"));
  await verifyNativeBuildReceipt(
    join(resources, "native-build-receipt.json"),
    join(macos, "tmux-ide-gpui"),
    join(project, "upstream"),
  );
  await copyFile(node, join(resources, "node"));
  await chmod(join(macos, "tmux-ide-gpui"), 0o755);
  await chmod(join(resources, "node"), 0o755);
  await copyFile(nodeLicense, join(resources, "NODE-LICENSE"));
  await copyFile(join(project, "upstream/LICENSE"), join(resources, "HERDR-LICENSE"));
  await copyFile(join(project, "upstream/NOTICE"), join(resources, "HERDR-NOTICE"));
  await copyFile(resolve(project, "../../LICENSE"), join(resources, "TMUX-IDE-LICENSE"));
  // Preserve upstream's supplemental attribution even when a feature is not exposed.
  const supplementalNotices = {
    "HERDR-PROTOCOL-LICENSE": "crates/herdr-protocol/LICENSE-APACHE",
    "HERDR-PROTOCOL-NOTICE": "crates/herdr-protocol/NOTICE.md",
    "HERDR-SOUND-NOTICE": "crates/herdr-gpui/SOUND-NOTICE.md",
    "HERDR-GITHUB-NOTICE": "crates/herdr-gpui/GITHUB-NOTICE.md",
    "OCTICONS-LICENSE": "assets/icons/LICENSE-octicons",
  };
  for (const [name, source] of Object.entries(supplementalNotices)) {
    await copyFile(join(project, "upstream", source), join(resources, name));
  }
  // Generate from the checkout lockfile; never reuse a potentially stale report.
  await run("python3", [
    join(project, "upstream/scripts/release/generate-notices.py"),
    join(resources, "RUST-THIRD-PARTY-NOTICES.txt"),
  ]);
  await run(process.execPath, [
    join(project, "scripts/build-bridge.mjs"),
    join(resources, "bridge"),
  ]);
  await writeFile(
    join(macos, "tmux-ide-launcher"),
    `#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH
app_macos=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
resources="$app_macos/../Resources"
if [ "$#" -gt 1 ]; then
  echo 'Usage: tmux-ide-launcher [private-host.json]' >&2
  exit 2
fi
exec "$resources/node" "$resources/bridge/preview-launcher.bundle.mjs" "$app_macos/tmux-ide-gpui" "\${1:---local}" --browse
`,
    { mode: 0o755 },
  );
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
        ...(metadata ? { metadata, scope: "pre-signing assembly; not a qualified release" } : {}),
        signing: "not-qualified",
        nativeIdentity: identity,
        nodeVersion: version,
        nativeSha256: await digest(join(macos, "tmux-ide-gpui")),
        nativeBuild: {
          file: "native-build-receipt.json",
          sha256: await digest(join(resources, "native-build-receipt.json")),
          scope: "local source/binary consistency; not trusted build attestation",
        },
        nodeSha256: await digest(join(resources, "node")),
        nodeLicenseSha256: await digest(join(resources, "NODE-LICENSE")),
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
