import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export type InstallOrigin =
  | "npm"
  | "pnpm"
  | "bun"
  | "homebrew"
  | "yarn"
  | "npx"
  | "dev"
  | "unknown";
/** Conservative layout evidence; an arbitrary node_modules directory is not a global install. */
export function detectPackageManager(path: string): Exclude<InstallOrigin, "dev"> {
  if (/\/(?:Cellar|Caskroom)\//.test(path)) return "homebrew";
  if (/\/_npx\//.test(path)) return "npx";
  if (/\/(?:\.yarn|yarn)\//.test(path)) return "yarn";
  if (/\/(?:\.bun|bun)\/install\/global\//.test(path)) return "bun";
  if (/\/pnpm\/global\/[^/]+\//.test(path)) return "pnpm";
  if (/\/lib\/node_modules\/tmux-ide(?:\/|$)/.test(path)) return "npm";
  return "unknown";
}
export function findGitCheckoutRoot(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    // Do not mistake a package installed inside somebody else's repository for this checkout.
    if (dir.endsWith("/node_modules")) return null;
    if (existsSync(join(dir, ".git"))) {
      try {
        if (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name === "tmux-ide")
          return dir;
      } catch {
        /* no verified package root */
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
export function installOrigin(cliDir = dirname(fileURLToPath(import.meta.url))): {
  origin: InstallOrigin;
  path: string;
  gitRoot: string | null;
} {
  let path: string;
  try {
    path = realpathSync(cliDir);
  } catch {
    return { origin: "unknown", path: cliDir, gitRoot: null };
  }
  let detected = detectPackageManager(path);
  if (detected === "npm" || detected === "pnpm" || detected === "bun") {
    try {
      if (JSON.parse(readFileSync(join(path, "../package.json"), "utf8")).name !== "tmux-ide")
        detected = "unknown";
    } catch {
      detected = "unknown";
    }
  }
  const gitRoot = detected === "unknown" ? findGitCheckoutRoot(path) : null;
  return { origin: gitRoot ? "dev" : detected, path, gitRoot };
}
