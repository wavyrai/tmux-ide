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
  // COPYING is deliberately included even for historical manifests which only
  // list dependency licenses. Copy the complete distribution unchanged.
  await readFile(join(source, "COPYING"));
  const target = nativeTmuxDirectory(appRoot, platform, arch);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  validateBundledTmux(target, platform, arch);
  return target;
}
