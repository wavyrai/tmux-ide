import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const exec = promisify(execFile);
const builder = fileURLToPath(new URL("./build-installer.mjs", import.meta.url));

test("standalone installer relocates, retains CLI behavior and refuses overwriting output", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpui-installer-bundle-"));
  const built = join(root, "built"),
    relocated = join(root, "relocated");
  try {
    await exec(process.execPath, [builder, built]);
    const manifest = JSON.parse(await readFile(join(built, "installer-manifest.json"), "utf8"));
    assert.equal(manifest.nodeMajor, 24);
    for (const [name, identity] of Object.entries(manifest.files)) {
      const data = await readFile(join(built, name));
      assert.equal(data.length, identity.bytes);
      assert.equal(createHash("sha256").update(data).digest("hex"), identity.sha256);
    }
    await assert.rejects(exec(process.execPath, [builder, built]));
    assert.equal(
      await readFile(join(built, "LICENSE"), "utf8"),
      await readFile(new URL("../../../LICENSE", import.meta.url), "utf8"),
    );
    await rename(built, relocated);
    const cli = join(relocated, "tmux-ide-install.mjs");
    const options = { cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin" } };
    const help = JSON.parse((await exec(process.execPath, [cli, "--help"], options)).stdout);
    assert.ok(JSON.stringify(help).includes("rollback"));
    await assert.rejects(
      exec(process.execPath, [cli, "install", "--skip-verification"], options),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(error.stdout.includes("arguments"));
        return true;
      },
    );
    assert.deepEqual(await readdir(root), ["relocated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
