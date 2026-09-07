import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Validate a complete platform bundle before selecting it as daemon authority. */
export function validateBundledTmux(
  directory: string,
  platform = process.platform,
  arch = process.arch,
): string {
  const root = realpathSync(directory);
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    manifest.extension !== "tmux-ide-native-grid-v1" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    typeof manifest.files.tmux !== "string"
  )
    throw new Error("Invalid bundled tmux manifest");
  if (platform === "darwin") parseMacOSVersion(manifest.minimumMacOS);
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (isAbsolute(name) || name.split(/[\\/]/u).includes(".."))
      throw new Error("Invalid bundled tmux file path");
    const path = realpathSync(join(root, name));
    const local = relative(root, path);
    if (local.startsWith(`..${sep}`) || local === ".." || isAbsolute(local))
      throw new Error("Bundled tmux file escapes its distribution");
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== expected) throw new Error(`Bundled tmux checksum mismatch: ${name}`);
  }
  const executable = realpathSync(join(root, "tmux"));
  // npm normalizes non-bin payloads to 0644. Restore execution only after the
  // complete bundle has passed integrity checks (also supports --ignore-scripts).
  try {
    accessSync(executable, constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    chmodSync(executable, 0o755);
  }
  accessSync(executable, constants.X_OK);
  return executable;
}

/** Locate installed assets from source, the Node bundle, or the CLI-forwarded Bun host. */
export function resolveBundledTmux(
  anchors: readonly string[] = [
    ...(process.env.TMUX_IDE_CLI ? [process.env.TMUX_IDE_CLI] : []),
    fileURLToPath(import.meta.url),
  ],
  currentMacOSVersion: () => string = () =>
    execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
): string | null {
  const visited = new Set<string>();
  for (const anchor of anchors) {
    if (!isAbsolute(anchor)) continue;
    let directory = dirname(resolve(anchor));
    while (!visited.has(directory)) {
      visited.add(directory);
      const bundle = join(
        directory,
        "packages/daemon/dist/native/tmux",
        `${process.platform}-${process.arch}`,
      );
      if (existsSync(join(bundle, "manifest.json"))) {
        const executable = validateBundledTmux(bundle);
        if (process.platform === "darwin") {
          const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
          if (!isMacOSVersionCompatible(currentMacOSVersion(), manifest.minimumMacOS)) return null;
        }
        return executable;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return null;
}

function parseMacOSVersion(value: unknown): readonly number[] {
  if (typeof value !== "string" || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/u.test(value))
    throw new Error("Invalid bundled tmux macOS version metadata");
  return value.split(".").map(Number);
}

/** Compare numeric OS components, including old 10.x and patch-level floors. */
export function isMacOSVersionCompatible(current: string, minimum: string): boolean {
  const actual = parseMacOSVersion(current);
  const required = parseMacOSVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (required[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}
