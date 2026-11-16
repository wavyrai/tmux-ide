#!/usr/bin/env node
// The committed bin/cli.js must be the build of the committed sources.
// npm's tarball is rebuilt at publish (prepack), but a git install, a
// developer running ./bin/cli.js and the tagged tree all use the committed
// copy. v2.9.25 was tagged with a copy regenerated before #723's daemon half
// merged, so it lacked it. This builds the sources into a temporary file and
// compares it with bin/cli.js, byte for byte.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committedPath = process.argv[2] ? resolve(process.argv[2]) : join(root, "bin", "cli.js");
const scratch = mkdtempSync(join(tmpdir(), "tmux-ide-cli-bundle-"));
try {
  const fresh = join(scratch, "cli.js");
  const build = spawnSync(
    process.execPath,
    [join(root, "scripts", "build-cli.mjs"), "--outfile", fresh],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  if (build.status !== 0) {
    console.error("check-cli-bundle: the build failed");
    process.exit(build.status ?? 1);
  }
  const committed = readFileSync(committedPath);
  const built = readFileSync(fresh);
  if (Buffer.compare(committed, built) !== 0) {
    console.error(
      `check-cli-bundle: ${committedPath} is not the build of the committed sources ` +
        `(${committed.byteLength} bytes committed, ${built.byteLength} built). ` +
        "Run `pnpm build:cli` and commit bin/cli.js.",
    );
    process.exit(1);
  }
  console.log(
    `check-cli-bundle: ${committedPath} matches a fresh build (${built.byteLength} bytes).`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
