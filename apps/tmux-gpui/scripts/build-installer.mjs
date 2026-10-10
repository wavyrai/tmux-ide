#!/usr/bin/env node
// Bundle the existing installer; Node24 and independently trusted policy remain prerequisites.
import { build } from "esbuild";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import { createHash } from "node:crypto";

if (process.argv.length !== 3) throw new Error("Usage: build-installer.mjs NEW_OUTPUT_DIRECTORY");
const output = resolve(process.argv[2]);
await mkdir(output); // Never replace an existing directory.
try {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./install-cli.mjs", import.meta.url))],
    outfile: join(output, "tmux-ide-install.mjs"),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    metafile: true,
    legalComments: "eof",
  });
  for (const item of Object.values(result.metafile.outputs)) {
    for (const dependency of item.imports) {
      if (!dependency.external || !isBuiltin(dependency.path))
        throw new Error(`Unexpected installer dependency: ${dependency.path}`);
    }
  }
  // The installer currently contains only tmux-ide source and Node builtins.
  for (const input of Object.keys(result.metafile.inputs)) {
    if (input.split(/[\\/]/).includes("node_modules"))
      throw new Error("Installer dependency needs license review");
  }
  await writeFile(
    join(output, "LICENSE"),
    await readFile(new URL("../../../LICENSE", import.meta.url)),
  );
  const files = {};
  for (const name of ["tmux-ide-install.mjs", "LICENSE"]) {
    const data = await readFile(join(output, name));
    files[name] = { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }
  await writeFile(
    join(output, "installer-manifest.json"),
    JSON.stringify({ version: 1, nodeMajor: 24, files }, null, 2) + "\n",
  );
  console.log(`Built standalone installer: ${output}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
}
