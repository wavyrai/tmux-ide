import { join, relative, isAbsolute, sep } from "node:path";
// The wrapper accepts only the repository's exact stable pin, never an ambient
// PATH compiler or a caller-provided RUSTC override.
export function pinnedToolchainPaths(root, source, architecture) {
  const matches = [...source.matchAll(/^channel\s*=\s*"([^"]+)"\s*$/gm)];
  if (!isAbsolute(root) || matches.length !== 1 || !/^\d+\.\d+\.\d+$/.test(matches[0][1]))
    throw new Error("Expected one exact stable Rust channel");
  const host =
    architecture === "arm64"
      ? "aarch64-apple-darwin"
      : architecture === "x64"
        ? "x86_64-apple-darwin"
        : null;
  if (!host) throw new Error("Unsupported native build architecture");
  const channel = matches[0][1];
  const bin = join(root, "toolchains", `${channel}-${host}`, "bin");
  return { channel, cargo: join(bin, "cargo"), rustc: join(bin, "rustc") };
}
export function localManifestAllowed(workspace, manifest, files) {
  const path = relative(workspace, manifest).split(sep).join("/");
  const declared =
    path === "Cargo.toml" ||
    (path.startsWith("crates/") && path.endsWith("/Cargo.toml")) ||
    path === "../vendor/bezel-gpui-apple/Cargo.toml";
  return declared && files.some((entry) => entry.path === path);
}
