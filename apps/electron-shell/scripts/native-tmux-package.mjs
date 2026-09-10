import { cp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateBundledTmux } from "../../../packages/daemon/src/lib/bundled-tmux.ts";

// Keep the daemon's existing resolver layout inside Resources/app, so a Finder
// launch resolves its own verified runtime without a checkout or shell PATH.
export function nativeTmuxDirectory(root, platform = process.platform, arch = process.arch) {
  return join(root, "packages/daemon/dist/native/tmux", `${platform}-${arch}`);
}

export async function stageNativeTmux(
  repoRoot,
  appRoot,
  platform = process.platform,
  arch = process.arch,
) {
  const source = nativeTmuxDirectory(repoRoot, platform, arch);
  validateBundledTmux(source, platform, arch);
  const expected = JSON.parse(
    await readFile(join(repoRoot, "native/tmux/provenance.json"), "utf8"),
  );
  const actual = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
  for (const field of ["repository", "commit", "version", "extension", "patch", "patchSha256"]) {
    if (
      typeof expected[field] !== "string" ||
      !expected[field] ||
      actual[field] !== expected[field]
    ) {
      throw new Error(
        `Bundled tmux provenance mismatch: ${field}. Rebuild or download the current native distribution.`,
      );
    }
  }
  // COPYING is deliberately included even for historical manifests which only
  // list dependency licenses. Copy the complete distribution unchanged.
  await readFile(join(source, "COPYING"));
  const target = nativeTmuxDirectory(appRoot, platform, arch);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  validateBundledTmux(target, platform, arch);
  return target;
}
