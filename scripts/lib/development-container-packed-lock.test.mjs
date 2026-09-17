import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ti-packed-lock-"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(
    readFileSync(join(root, "docker/development/packed-package-lock.json"), "utf8"),
  );
  const save = () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    writeFileSync(join(dir, "lock.json"), JSON.stringify(lock));
  };
  save();
  writeFileSync(join(dir, "artifact.tgz"), "synthetic artifact bytes");
  return {
    dir,
    pkg,
    lock,
    save,
    run: () =>
      execFileSync(
        process.execPath,
        [
          join(root, "docker/development/prepare-packed-lock.mjs"),
          join(dir, "package.json"),
          join(dir, "artifact.tgz"),
          join(dir, "lock.json"),
          join(dir, "output"),
        ],
        { stdio: "pipe" },
      ),
  };
}
test("packed lock rebinding preserves every external package", () => {
  const f = fixture();
  try {
    f.pkg.version = "99.0.0-fixture.1";
    f.save();
    f.run();
    const actual = JSON.parse(readFileSync(join(f.dir, "output/package-lock.json"), "utf8"));
    for (const [key, value] of Object.entries(f.lock.packages))
      if (key !== "node_modules/tmux-ide") assert.deepEqual(actual.packages[key], value);
    assert.equal(actual.packages["node_modules/tmux-ide"].version, f.pkg.version);
    assert.notEqual(
      actual.packages["node_modules/tmux-ide"].integrity,
      f.lock.packages["node_modules/tmux-ide"].integrity,
    );
    assert.equal(
      readFileSync(join(f.dir, "output/tmux-ide.tgz"), "utf8"),
      "synthetic artifact bytes",
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("dependency and metadata drift require explicit fixture lock refresh", () => {
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "engines",
    "bin",
  ]) {
    const f = fixture();
    try {
      f.pkg[key] = { ...f.pkg[key], unexpected: "*" };
      f.save();
      assert.throws(f.run, /refresh/);
      assert(!existsSync(join(f.dir, "output")));
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});
