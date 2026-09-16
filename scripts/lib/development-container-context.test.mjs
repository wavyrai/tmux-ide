import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDevelopmentContainerContext } from "./development-container-context.mjs";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ti-container-context-")),
    root = join(dir, "tree");
  mkdirSync(root);
  const git = (args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git(["init"]);
  git(["config", "user.name", "fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(root, "keep"), "old");
  writeFileSync(join(root, "deleted"), "gone");
  git(["add", "."]);
  git(["commit", "-m", "fixture"]);
  return { dir, root, git };
}
test("owned export captures dirty/deleted/untracked inputs and modes, excludes host state", () => {
  const { dir, root } = fixture();
  try {
    writeFileSync(join(root, "keep"), "new");
    rmSync(join(root, "deleted"));
    writeFileSync(join(root, "script with spaces"), "#!/bin/sh\n", { mode: 0o755 });
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "host"), "never");
    writeFileSync(join(root, ".env"), "secret");
    const output = join(dir, "context"),
      m = exportDevelopmentContainerContext(root, output);
    assert(m.sourceDirty);
    assert.equal(readFileSync(join(output, "keep"), "utf8"), "new");
    assert(!existsSync(join(output, "deleted")));
    assert(!existsSync(join(output, "node_modules")));
    assert(!existsSync(join(output, ".git")));
    assert(!existsSync(join(output, ".env")));
    assert(statSync(join(output, "script with spaces")).mode & 0o111);
    assert.equal(
      exportDevelopmentContainerContext(root, join(dir, "second")).snapshotDigest,
      m.snapshotDigest,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("export refuses external symlinks and cannot overwrite existing or in-tree outputs", () => {
  const { dir, root } = fixture();
  try {
    assert.throws(() => exportDevelopmentContainerContext(root, join(root, "output")), /outside/);
    assert.throws(() => exportDevelopmentContainerContext(root, root));
    symlinkSync("/etc/passwd", join(root, "escape"));
    const output = join(dir, "context");
    assert.throws(() => exportDevelopmentContainerContext(root, output), /escapes/);
    assert(!existsSync(output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracked paths beneath an escaping directory symlink are rejected", () => {
  const { dir, root, git } = fixture();
  try {
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d/a"), "inside");
    git(["add", "d/a"]);
    git(["commit", "-m", "directory"]);
    rmSync(join(root, "d"), { recursive: true });
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside/a"), "outside");
    symlinkSync("../outside", join(root, "d"));
    assert.throws(() => exportDevelopmentContainerContext(root, join(dir, "context")), /escapes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("export metadata is reserved and environment-prefixed files are excluded", () => {
  const { dir, root } = fixture();
  try {
    writeFileSync(join(root, ".development-container-source.json"), "old metadata");
    writeFileSync(join(root, ".envrc"), "private environment");
    const result = exportDevelopmentContainerContext(root, join(dir, "context"));
    assert(
      !result.files.some(
        (file) => file.path === ".development-container-source.json" || file.path === ".envrc",
      ),
    );
    assert.equal(
      JSON.parse(readFileSync(join(dir, "context/.development-container-source.json"), "utf8"))
        .snapshotDigest,
      result.snapshotDigest,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
