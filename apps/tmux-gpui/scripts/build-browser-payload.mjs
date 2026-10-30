#!/usr/bin/env node
// Development assembly. Signing, complete notices and live qualification remain release gates.
import { createRequire } from "node:module";
import { bridgeNotices } from "./bridge-notices.mjs";
import { TERMINAL_BROWSER_LAUNCHER } from "./browser-payload.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile, readdir, lstat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64" || process.argv.length !== 5)
  throw Error("Usage: build-browser-payload.mjs PREPARED_SOURCE ENGINE_PAYLOAD NEW_OUTPUT");
const [source, engine, output] = process.argv.slice(2).map((p) => resolve(p));
const scripts = fileURLToPath(new URL("./", import.meta.url));
const metadata = JSON.parse(await readFile(join(engine, "candidate.json"), "utf8"));
const archive = await readFile(join(engine, "browser-runtime.tar.gz"));
if (
  metadata.platform !== "darwin-arm64" ||
  metadata.cookieEncryption !== true ||
  metadata.bytes !== archive.length ||
  createHash("sha256").update(archive).digest("hex") !== metadata.sha256
)
  throw Error("Engine payload metadata mismatch");
const pinned = JSON.parse(
  await readFile(join(scripts, "../integrations/pixel/provenance.json"), "utf8"),
);
if (
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() !==
  pinned.commit
)
  throw Error("Browser source revision mismatch");
const rawPatch = await readFile(join(scripts, "../integrations/pixel", pinned.patch), "utf8");
if (createHash("sha256").update(rawPatch).digest("hex") !== pinned.patchSha256)
  throw Error("Browser patch checksum mismatch");
const repository = resolve(scripts, "../../..");
const expectedPatch = rawPatch.replaceAll(
  "@TMUX_IDE_ROOT@",
  JSON.stringify(repository).slice(1, -1),
);
let actualPatch = execFileSync("git", ["diff", "HEAD", "--binary"], {
  cwd: source,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
  cwd: source,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
for (const path of untracked) {
  const diff = spawnSync("git", ["diff", "--no-index", "--binary", "/dev/null", path], {
    cwd: source,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (diff.error || ![0, 1].includes(diff.status))
    throw Error(`Cannot verify browser source: ${path}`);
  actualPatch += diff.stdout;
}
if (actualPatch !== expectedPatch)
  throw Error("Prepared browser source does not match the pinned integration patch");
async function copyTree(from, to) {
  const info = await lstat(from);
  if (info.isSymbolicLink()) throw Error(`Unexpected source link: ${from}`);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name));
  } else if (info.isFile()) await copyFile(from, to);
  else throw Error(`Unsupported source entry: ${from}`);
}
await mkdir(output); // Refuse replacement; cleanup is limited to this new directory.
try {
  const inputs = new Set();
  for (const part of ["cli", "browser"]) {
    await mkdir(join(output, part, "dist"), { recursive: true });
    const bundle = join(output, part, "dist/main.js");
    const metafile = join(output, part, "dist/inputs.json");
    execFileSync(
      join(source, "node_modules/.bin/esbuild"),
      [
        join(source, part, "src", part === "cli" ? "main.ts" : "main.tsx"),
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--external:electron",
        "--external:*.node",
        `--alias:shared=${join(source, "shared/src/index.ts")}`,
        '--define:process.env.NODE_ENV="production"',
        `--outfile=${bundle}`,
        `--metafile=${metafile}`,
        "--legal-comments=eof",
        "--log-level=warning",
      ],
      { cwd: source, stdio: "inherit" },
    );
    const meta = JSON.parse(await readFile(metafile, "utf8"));
    for (const input of Object.keys(meta.inputs)) inputs.add(resolve(source, input));
    await writeFile(join(output, part, "dist/package.json"), '{"type":"commonjs"}\n');
  }
  const browserRequire = createRequire(join(source, "browser/package.json"));
  const grab = browserRequire.resolve("react-grab/dist/index.global.js");
  inputs.add(grab);
  const supplemental = {};
  const licenseRoot = join(scripts, "../integrations/pixel/licenses");
  const licenseManifest = JSON.parse(await readFile(join(licenseRoot, "sources.json"), "utf8"));
  for (const [identity, entry] of Object.entries(licenseManifest)) {
    const bytes = await readFile(join(licenseRoot, entry.file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw Error(`Supplemental license changed: ${identity}`);
    if (entry.asset) {
      const asset = await readFile(join(source, entry.asset));
      if (createHash("sha256").update(asset).digest("hex") !== entry.assetSha256)
        throw Error(`Noticed browser asset changed: ${entry.asset}`);
      await copyFile(join(licenseRoot, entry.file), join(output, entry.file));
    }
    supplemental[identity] = {
      name: `${entry.file} (${entry.source})`,
      text: bytes.toString("utf8"),
    };
  }
  const notices = await bridgeNotices([...inputs], supplemental);
  await writeFile(
    join(output, "JAVASCRIPT-THIRD-PARTY-NOTICES.txt"),
    notices.text.replace("tmux-ide GPUI JavaScript bridge", "tmux-ide terminal browser"),
  );

  execFileSync(
    "python3",
    [
      join(scripts, "browser-rust-notices.py"),
      source,
      join(output, "RUST-THIRD-PARTY-NOTICES.txt"),
    ],
    { stdio: "inherit" },
  );
  await copyFile(join(scripts, "../upstream/LICENSE"), join(output, "NATIVE-SDK-LICENSE"));
  await copyFile(join(scripts, "../upstream/NOTICE"), join(output, "NATIVE-SDK-NOTICE"));
  const native = join(source, "pixel/packages/native/darwin-arm64");
  const nativeOutput = join(output, "browser/node_modules/@zenbu-labs/pixel-native-darwin-arm64");
  await mkdir(nativeOutput, { recursive: true });
  for (const name of ["package.json", "pixel.node"])
    await copyFile(join(native, name), join(nativeOutput, name));
  await mkdir(join(output, "bin"));
  await copyFile(join(native, "native-scroll-helper"), join(output, "bin/native-scroll-helper"));
  await copyTree(join(source, "assets"), join(output, "assets"));
  await copyFile(grab, join(output, "assets/react-grab/index.global.js"));
  await copyFile(join(source, "pixel/LICENSE"), join(output, "PIXEL-LICENSE"));
  for (const name of [
    "browser-launch.mjs",
    "browser-runtime-load.mjs",
    "browser-runtime-extract.mjs",
  ])
    await copyFile(join(scripts, name), join(output, name));
  await copyFile(join(engine, "browser-runtime.tar.gz"), join(output, "browser-runtime.tar.gz"));
  await writeFile(join(output, "runtime.json"), JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(join(output, "terminal-browser"), TERMINAL_BROWSER_LAUNCHER, { mode: 0o755 });
  await writeFile(
    join(output, "bin/terminal-browser"),
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")/.." && pwd -P)\nexec "$root/terminal-browser" "$@"\n',
    { mode: 0o755 },
  );
  await writeFile(join(output, "VERSION"), "tmux-ide-development\n");
  await writeFile(join(output, "CHANNEL"), "managed\n");
  await copyFile(join(source, "LICENSE"), join(output, "TERMINAL-BROWSER-LICENSE"));
  await writeFile(
    join(output, "ASSEMBLY.json"),
    JSON.stringify(
      {
        distribution: false,
        source: pinned.commit,
        javascriptDependencies: notices.packages,
        patch: pinned.patchSha256,
        pending: [
          "remaining asset and optional action-helper qualification",
          "sign native helpers",
          "live persistent-profile and controls qualification",
        ],
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
