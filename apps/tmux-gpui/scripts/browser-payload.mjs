// Copy development browser resources without importing framework symlinks into the outer app.
import { lstat, readdir, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
export async function browserPayloadInventory(root) {
  const files = {};
  let total = 0;
  async function visit(relative) {
    const path = join(root, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw Error("Browser payload links are unsupported");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    } else if (info.isFile() && info.nlink === 1) {
      total += info.size;
      if (total > 512 * 1024 * 1024 || Object.keys(files).length >= 10000)
        throw Error("Browser payload exceeds limits");
      files[relative] = {
        bytes: info.size,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      };
    } else throw Error("Unsupported browser payload entry");
  }
  await visit("");
  for (const required of [
    "terminal-browser",
    "browser-launch.mjs",
    "runtime.json",
    "browser-runtime.tar.gz",
    "cli/dist/main.js",
    "browser/dist/main.js",
    "ASSEMBLY.json",
  ])
    if (!files[required]) throw Error(`Missing browser payload file: ${required}`);
  return files;
}
export async function copyBrowserPayload(source, destination) {
  const before = await browserPayloadInventory(source);
  await mkdir(destination);
  try {
    for (const path of Object.keys(before)) {
      const parts = path.split("/");
      parts.pop();
      if (parts.length) await mkdir(join(destination, ...parts), { recursive: true });
      await copyFile(join(source, path), join(destination, path));
    }
    const after = await browserPayloadInventory(destination);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error("Browser payload changed during assembly");
    return after;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
