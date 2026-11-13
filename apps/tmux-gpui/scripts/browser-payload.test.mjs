import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { copyBrowserPayload, sameIntegrationPatch } from "./browser-payload.mjs";

test("copies a complete regular payload and rejects links without replacing existing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-payload-test-"));
  try {
    const source = join(root, "source"),
      dest = join(root, "destination");
    for (const file of [
      "terminal-browser",
      "browser-launch.mjs",
      "runtime.json",
      "browser-runtime.tar.gz",
      "cli/dist/main.js",
      "browser/dist/main.js",
      "ASSEMBLY.json",
    ]) {
      await mkdir(dirname(join(source, file)), { recursive: true });
      await writeFile(join(source, file), file);
    }
    const inventory = await copyBrowserPayload(source, dest);
    assert.equal(Object.keys(inventory).length, 7);
    assert.equal(await readFile(join(dest, "cli/dist/main.js"), "utf8"), "cli/dist/main.js");
    await assert.rejects(copyBrowserPayload(source, dest), { code: "EEXIST" });
    await symlink("/tmp", join(source, "unsafe"));
    await assert.rejects(copyBrowserPayload(source, join(root, "other")), /links/);
    assert.equal(await readFile(join(dest, "terminal-browser"), "utf8"), "terminal-browser");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the pinned patch matches a source prepared from any checkout path", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-patch-test-"));
  const git = (cwd, args, input) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      cwd,
      input,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
  try {
    // An upstream source, and a patch whose one file names the checkout path.
    const upstream = join(root, "upstream");
    await mkdir(upstream);
    git(upstream, ["init", "-q"]);
    await writeFile(join(upstream, "Cargo.toml"), '[dependencies]\nserde = "1"\n');
    await writeFile(join(upstream, "main.rs"), "fn main() {}\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-q", "-m", "base"]);
    await writeFile(
      join(upstream, "Cargo.toml"),
      '[dependencies]\nserde = "1"\nsdk = { path = "@TMUX_IDE_ROOT@/crates/sdk" }\n',
    );
    await writeFile(join(upstream, "main.rs"), "fn main() { sdk::run() }\n");
    const pinned = git(upstream, ["diff", "HEAD", "--binary"]);
    assert.match(pinned, /^index [0-9a-f]+\.\.[0-9a-f]+ 100644$/mu);
    git(upstream, ["checkout", "-q", "."]);
    const prepared = async (checkout) => {
      const source = join(root, `source-${checkout.length}`);
      git(root, ["clone", "-q", upstream, source]);
      const patch = pinned.replaceAll("@TMUX_IDE_ROOT@", checkout);
      git(source, ["apply", "-"], patch);
      return { expected: patch, actual: git(source, ["diff", "HEAD", "--binary"]), source };
    };
    for (const checkout of ["/Volumes/T5/Developer/rel-2916", "/Users/someone/src/tmux-ide"]) {
      const { expected, actual, source } = await prepared(checkout);
      assert.notEqual(actual, expected, "the index line carries this checkout's path");
      assert.equal(sameIntegrationPatch(expected, actual), true, checkout);
      // Any other edit to the prepared source is still a mismatch.
      await writeFile(join(source, "main.rs"), "fn main() { sdk::run(); other() }\n");
      assert.equal(
        sameIntegrationPatch(expected, git(source, ["diff", "HEAD", "--binary"])),
        false,
      );
    }
    assert.equal(sameIntegrationPatch(pinned, pinned.replace("sdk::run()", "sdk::walk()")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
