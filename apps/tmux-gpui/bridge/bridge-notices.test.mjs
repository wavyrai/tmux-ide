import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bridgeNotices } from "../scripts/bridge-notices.mjs";

test("dependency notices retain exact text and deduplicate input files", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpui-notices-"));
  try {
    const pkg = join(root, "node_modules", "example");
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "example", version: "1.2.3", license: "MIT" }),
    );
    const text = "Copyright Example\nAll license clauses stay here.\n";
    await writeFile(join(pkg, "LICENSE"), text);
    const result = await bridgeNotices([join(pkg, "dist/a.js"), join(pkg, "dist/b.js")]);
    assert.deepEqual(result.packages, [{ name: "example", version: "1.2.3", license: "MIT" }]);
    assert.ok(result.text.includes(text));
    assert.equal(result.text.split(text).length, 2);
    await rm(join(pkg, "LICENSE"));
    await assert.rejects(bridgeNotices([join(pkg, "dist/a.js")]), /Missing dependency notice/);
    await rm(join(pkg, "package.json"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "enclosing-project", version: "1" }),
    );
    await writeFile(join(root, "LICENSE"), "Must not substitute the host license");
    await assert.rejects(bridgeNotices([join(pkg, "dist/a.js")]), /no package identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
