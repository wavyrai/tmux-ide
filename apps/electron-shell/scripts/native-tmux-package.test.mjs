import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  resolveBundledTmux,
  validateBundledTmux,
} from "../../../packages/daemon/src/lib/bundled-tmux.ts";
import { nativeTmuxDirectory, stageNativeTmux } from "./native-tmux-package.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-tmux-package-"));
  roots.push(root);
  const source = nativeTmuxDirectory(join(root, "source"));
  await mkdir(join(source, "licenses"), { recursive: true });
  const files = { tmux: "#!/bin/sh\nexit 0\n", "licenses/dependency.txt": "Dependency license" };
  for (const [name, value] of Object.entries(files)) await writeFile(join(source, name), value);
  await writeFile(join(source, "COPYING"), "tmux license");
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      extension: "tmux-ide-native-grid-v2",
      minimumMacOS: "10.15",
      files: Object.fromEntries(
        Object.entries(files).map(([name, value]) => [
          name,
          createHash("sha256").update(value).digest("hex"),
        ]),
      ),
    }),
  );
  return { root, source, app: join(root, "detached", "Resources", "app") };
}

it("preserves licenses and manifest and resolves from a detached daemon entry", async () => {
  const { root, source, app } = await fixture();
  const target = await stageNativeTmux(join(root, "source"), app);
  expect(await readFile(join(target, "manifest.json"), "utf8")).toBe(
    await readFile(join(source, "manifest.json"), "utf8"),
  );
  expect(await readFile(join(target, "COPYING"), "utf8")).toBe("tmux license");
  expect(await readFile(join(target, "licenses/dependency.txt"), "utf8")).toBe(
    "Dependency license",
  );
  expect(resolveBundledTmux([join(app, "daemon-child.cjs")], () => "26.0")).toBe(
    validateBundledTmux(target),
  );
});
it("refuses missing or corrupt distributions rather than shipping a PATH-dependent app", async () => {
  const { root, source, app } = await fixture();
  await writeFile(join(source, "tmux"), "modified");
  await expect(stageNativeTmux(join(root, "source"), app)).rejects.toThrow("checksum mismatch");
  await expect(stageNativeTmux(join(root, "missing"), app)).rejects.toThrow();
});
it("detects post-packaging payload changes", async () => {
  const { root, app } = await fixture();
  const target = await stageNativeTmux(join(root, "source"), app);
  await writeFile(join(target, "licenses/dependency.txt"), "changed");
  expect(() => validateBundledTmux(target)).toThrow("checksum mismatch");
});
