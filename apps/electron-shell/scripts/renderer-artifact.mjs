import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function selectRenderer(args) {
  const flags = args.filter((arg) => arg.startsWith("--renderer="));
  if (
    flags.length > 1 ||
    (flags.length && !["--renderer=workspace", "--renderer=desktop"].includes(flags[0]))
  ) {
    throw new Error("Select exactly one renderer: workspace or desktop");
  }
  return flags[0] === "--renderer=workspace" ? "workspace" : "desktop";
}

async function rendererFiles(root, prefix = "") {
  const files = {};
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await rendererFiles(root, name));
    else if (entry.isFile())
      files[name] = createHash("sha256")
        .update(await readFile(join(root, name)))
        .digest("hex");
    else throw new Error(`Unsupported renderer artifact: ${name}`);
  }
  return files;
}

export async function writeRendererManifest(dist, renderer) {
  const files = await rendererFiles(join(dist, "renderer"));
  if (!files["index.html"]) throw new Error("Renderer index.html is missing");
  await writeFile(
    join(dist, "renderer-manifest.json"),
    `${JSON.stringify({ version: 1, renderer, files }, null, 2)}\n`,
  );
}

export async function verifyRendererManifest(dist, renderer) {
  const manifest = JSON.parse(await readFile(join(dist, "renderer-manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.renderer !== renderer) {
    throw new Error(`Renderer artifact mismatch: expected ${renderer}, found ${manifest.renderer}`);
  }
  const actual = await rendererFiles(join(dist, "renderer"));
  if (!actual["index.html"] || JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error("Renderer artifact contents differ from the build manifest");
  }
  return manifest;
}
