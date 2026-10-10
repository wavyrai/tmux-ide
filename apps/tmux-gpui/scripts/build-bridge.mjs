#!/usr/bin/env node
// Produce a bridge payload that needs Node, but no source tree, tsx or node_modules.
import { build } from "esbuild";
import { bridgeNotices } from "./bridge-notices.mjs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { createHash } from "node:crypto";

if (process.argv.length !== 3) throw new Error("Usage: build-bridge.mjs NEW_OUTPUT_DIRECTORY");
const output = resolve(process.argv[2]);
const bridge = fileURLToPath(new URL("../bridge/", import.meta.url));
await mkdir(output); // Never overwrite a previous payload or user directory.
try {
  const result = await build({
    entryPoints: ["browser", "live", "preview-launcher"].map((name) =>
      join(bridge, `${name}.${name === "preview-launcher" ? "mjs" : "ts"}`),
    ),
    outdir: output,
    entryNames: "[name].bundle",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    metafile: true,
    sourcemap: false,
    legalComments: "eof",
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: {
      js: 'import { createRequire as __gpuiCreateRequire } from "node:module"; const require = __gpuiCreateRequire(import.meta.url);',
    },
  });
  for (const item of Object.values(result.metafile.outputs)) {
    for (const dependency of item.imports) {
      if (dependency.external && !isBuiltin(dependency.path))
        throw new Error(`Unbundled bridge dependency: ${dependency.path}`);
    }
  }
  const notices = await bridgeNotices(Object.keys(result.metafile.inputs));
  await writeFile(join(output, "THIRD_PARTY_NOTICES.txt"), notices.text);
  const files = {};
  for (const name of ["browser", "live", "preview-launcher"]) {
    const filename = `${name}.bundle.mjs`;
    const bytes = await readFile(join(output, filename));
    files[filename] = {
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  await writeFile(
    join(output, "bridge-manifest.json"),
    JSON.stringify(
      {
        version: 1,
        nodeMajor: 24,
        files,
        notices: {
          file: "THIRD_PARTY_NOTICES.txt",
          sha256: createHash("sha256").update(notices.text).digest("hex"),
          packages: notices.packages,
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Built standalone bridge payload: ${output}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
