import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
const run = promisify(execFile);
const builder = fileURLToPath(new URL("../scripts/build-bridge.mjs", import.meta.url));
test("bridge payload hashes match and rebuilding never overwrites an existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpui-bridge-build-"));
  const output = join(root, "payload");
  try {
    await run(process.execPath, [builder, output], { cwd: root });
    const original = await readFile(join(output, "bridge-manifest.json"), "utf8");
    const manifest = JSON.parse(original);
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      "browser.bundle.mjs",
      "live.bundle.mjs",
      "preview-launcher.bundle.mjs",
    ]);
    for (const [name, expected] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(output, name));
      assert.equal(bytes.length, expected.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
      await run(process.execPath, ["--check", join(output, name)], { cwd: root });
    }
    const noticeBytes = await readFile(join(output, manifest.notices.file));
    assert.equal(createHash("sha256").update(noticeBytes).digest("hex"), manifest.notices.sha256);
    assert.ok(manifest.notices.packages.some((p) => p.name === "ws"));
    assert.ok(manifest.notices.packages.some((p) => p.name === "zod"));
    assert.match(noticeBytes.toString(), /Copyright/);
    const browser = await readFile(join(output, "browser.bundle.mjs"), "utf8");
    assert.match(browser, /Copyright \(c\) 2026 Gloomberb Contributors/);
    assert.match(browser, /Permission is hereby granted, free of charge/);
    await assert.rejects(run(process.execPath, [builder, output], { cwd: root }));
    assert.equal(await readFile(join(output, "bridge-manifest.json"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
