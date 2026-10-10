import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  symlink,
  link,
  chmod,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createManifest } from "./preview-release-manifest.mjs";
import { extractArchive } from "./preview-release-extract.mjs";
const script = fileURLToPath(new URL("./preview-release-package.py", import.meta.url));
const name = "tmux-ide-gpui-test-1-macos-arm64.app.tar.gz";
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-package-")));
  const app = join(root, "Input.app"),
    output = join(root, name);
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(join(app, "Contents/MacOS/native"), "synthetic native", { mode: 0o755 });
  await writeFile(join(app, "Contents/Info.plist"), "synthetic plist", { mode: 0o644 });
  const pack = (target = output, version = "test-1") =>
    execFileSync(
      "/usr/bin/python3",
      [script, "--app", app, "--output", target, "--version", version],
      { timeout: 10000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    await run({ root, app, output, pack });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("actual producer is deterministic and authenticated extractor restores bytes and executable mode", async () => {
  await fixture(async ({ root, app, output, pack }) => {
    pack();
    const bytes = await readFile(output);
    const second = join(root, "second");
    await mkdir(second);
    await utimes(join(app, "Contents/Info.plist"), new Date(1000), new Date(1000));
    pack(join(second, name));
    assert.deepEqual(await readFile(join(second, name)), bytes);
    const keys = generateKeyPairSync("ed25519");
    const manifestBytes = createManifest({
      version: "test-1",
      archiveSize: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const destination = join(root, "extract");
    await mkdir(destination, { mode: 0o700 });
    const result = await extractArchive({
      archivePath: output,
      manifestBytes,
      signature: sign(null, manifestBytes, keys.privateKey),
      policy: {
        publicKey: keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
        expectedVersion: "test-1",
      },
      destinationRoot: destination,
    });
    assert.equal(
      await readFile(join(result.appPath, "Contents/MacOS/native"), "utf8"),
      "synthetic native",
    );
    assert.equal((await lstat(join(result.appPath, "Contents/MacOS/native"))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(result.appPath, "Contents/Info.plist"))).mode & 0o777, 0o644);
    assert.equal(await readFile(join(app, "Contents/Info.plist"), "utf8"), "synthetic plist");
    assert.equal((await lstat(output)).mode & 0o777, 0o600);
  });
});
test("links, aliases, unsafe names and special permissions reject without output or source mutation", async () => {
  for (const kind of [
    "symlink",
    "hardlink",
    "case",
    "unicode",
    "backslash",
    "control",
    "special",
  ]) {
    await fixture(async ({ app, output, pack }) => {
      const bad = join(app, "bad");
      if (kind === "symlink") await symlink("Contents", bad);
      else if (kind === "hardlink") await link(join(app, "Contents/Info.plist"), bad);
      else if (kind === "case") {
        await writeFile(join(app, "foo"), "one");
        await writeFile(join(app, "FOO"), "two");
      } else if (kind === "special") {
        await writeFile(bad, "x");
        await chmod(bad, 0o4755);
      } else
        await writeFile(join(app, { unicode: "é", backslash: "a\\b", control: "a\nb" }[kind]), "x");
      if (kind === "case") {
        const { readdir } = await import("node:fs/promises");
        const names = await readdir(app);
        if (!names.includes("foo") || !names.includes("FOO")) return;
      }
      assert.throws(() => pack());
      await assert.rejects(lstat(output), { code: "ENOENT" });
      assert.equal(await readFile(join(app, "Contents/MacOS/native"), "utf8"), "synthetic native");
    });
  }
});
test("existing output and source-contained destinations are never overwritten; version/name is exact", async () => {
  await fixture(async ({ app, output, pack }) => {
    await writeFile(output, "unrelated");
    assert.throws(() => pack());
    assert.equal(await readFile(output, "utf8"), "unrelated");
    const inside = join(app, name);
    assert.throws(() => pack(inside));
    await assert.rejects(lstat(inside), { code: "ENOENT" });
    assert.throws(() => pack(output, "../escape"));
    assert.throws(() => pack(output, "different"));
  });
});
test("inventory rejects case aliases independent of filesystem and lower test limits fail safely", async () => {
  await fixture(async ({ app, output }) => {
    await writeFile(join(app, "foo"), "x");
    const program = `
import importlib.util, pathlib, sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('producer',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
app=pathlib.Path(sys.argv[2]); output=pathlib.Path(sys.argv[3])
original=pathlib.Path.iterdir
def aliases(path):
    return iter([app/'foo',app/'FOO']) if path==app else original(path)
with patch.object(pathlib.Path,'iterdir',aliases):
    try: m.inventory(app)
    except ValueError as e: assert 'case alias' in str(e)
    else: raise AssertionError('alias accepted')
for key,limit in [('ENTRIES',1),('EXPANDED',512),('COMPRESSED',16)]:
    old=getattr(m,key);setattr(m,key,limit)
    try:
        try: m.package(app,output,'test-1')
        except ValueError: pass
        else: raise AssertionError('limit accepted')
        assert not output.exists()
    finally: setattr(m,key,old)
`;
    execFileSync("/usr/bin/python3", ["-c", program, script, app, output], {
      timeout: 10000,
      maxBuffer: 65536,
    });
  });
});
