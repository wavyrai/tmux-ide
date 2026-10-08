import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

// Qualification itself remains owned by build-tui's existing manifest verifier.
export function packedRendererSelection(manifest) {
  if (manifest === undefined) return { nativeRenderer: "stock", manifest: null };
  if (typeof manifest !== "string" || !isAbsolute(manifest) || !statSync(manifest).isFile())
    throw new Error("TMUX_IDE_PACK_RELEASE_SCROLL_MANIFEST requires an absolute manifest file");
  const bytes = readFileSync(manifest);
  JSON.parse(bytes.toString("utf8"));
  return {
    nativeRenderer: "qualified-native-scroll",
    manifest: { path: manifest, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

export function packedRendererBuildArgs(selection, outfile) {
  if (
    !["stock", "qualified-native-scroll"].includes(selection.nativeRenderer) ||
    (selection.nativeRenderer === "stock") !== (selection.manifest === null)
  )
    throw new Error("Inconsistent packed renderer selection");
  return [
    "scripts/build-tui.mjs",
    ...(selection.manifest ? ["--release-scroll-manifest", selection.manifest.path] : []),
    "--outfile",
    outfile,
  ];
}

export function assertPackedRendererSelectionUnchanged(selection) {
  if (
    selection.manifest &&
    packedRendererSelection(selection.manifest.path).manifest.sha256 !== selection.manifest.sha256
  )
    throw new Error("Packed renderer manifest changed after selection");
}
