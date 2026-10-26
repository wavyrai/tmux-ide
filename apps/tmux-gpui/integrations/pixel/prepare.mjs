import { readFile, realpath, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const [sourceArg, rootArg, ...extra] = process.argv.slice(2);
if (!sourceArg || !rootArg || extra.length) {
  throw new Error("Usage: node prepare.mjs CLEAN_TERMINAL_BROWSER_CHECKOUT TMUX_IDE_CHECKOUT");
}
const source = await realpath(sourceArg);
const root = await realpath(rootArg);
await access(join(root, "apps/tmux-gpui/upstream/crates/tmux-native-surface-sdk/Cargo.toml"));
const here = dirname(fileURLToPath(import.meta.url));
const provenance = JSON.parse(await readFile(join(here, "provenance.json"), "utf8"));
const run = (args, input) => {
  const result = spawnSync("git", args, {
    cwd: source,
    input,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || "Git operation failed");
  return result.stdout.trim();
};
if (run(["rev-parse", "HEAD"]) !== provenance.commit)
  throw new Error("Unexpected terminal-browser revision");
if (run(["status", "--porcelain"]))
  throw new Error("Terminal-browser checkout must be clean; existing edits are preserved");
const raw = await readFile(join(here, provenance.patch), "utf8");
if (createHash("sha256").update(raw).digest("hex") !== provenance.patchSha256) {
  throw new Error("Pixel integration patch checksum mismatch");
}
const patch = raw.replaceAll("@TMUX_IDE_ROOT@", JSON.stringify(root).slice(1, -1));
run(["apply", "--check", "-"], patch);
run(["apply", "-"], patch);
console.log("Applied native-surface development integration to pinned terminal-browser checkout.");
