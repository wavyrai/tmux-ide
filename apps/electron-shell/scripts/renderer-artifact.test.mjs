import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  selectRenderer,
  verifyRendererManifest,
  writeRendererManifest,
} from "./renderer-artifact.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "renderer-artifact-"));
  roots.push(root);
  await mkdir(join(root, "renderer", "assets"), { recursive: true });
  await writeFile(join(root, "renderer", "index.html"), '<script src="assets/app.js"></script>');
  await writeFile(join(root, "renderer", "assets", "app.js"), "workspace()");
  await writeRendererManifest(root, "desktop");
  return root;
}

it("selects desktop explicitly and rejects ambiguous renderer requests", () => {
  expect(selectRenderer([])).toBe("desktop");
  expect(selectRenderer(["--renderer=desktop"])).toBe("desktop");
  expect(() => selectRenderer(["--renderer=workspace"])).toThrow();
  expect(() => selectRenderer(["--renderer=other"])).toThrow();
  expect(() => selectRenderer(["--renderer=desktop", "--renderer=workspace"])).toThrow();
});
it("rejects packaging or reusing the wrong renderer", async () => {
  const root = await fixture();
  await expect(verifyRendererManifest(root, "desktop")).resolves.toMatchObject({
    renderer: "desktop",
  });
  await expect(verifyRendererManifest(root, "workspace")).rejects.toThrow("mismatch");
});
it("rejects changed or extra assets after the build", async () => {
  const root = await fixture();
  await writeFile(join(root, "renderer", "assets", "app.js"), "legacy()");
  await expect(verifyRendererManifest(root, "desktop")).rejects.toThrow("contents differ");
  await writeFile(join(root, "renderer", "assets", "app.js"), "workspace()");
  await writeFile(join(root, "renderer", "assets", "stale.js"), "old()");
  await expect(verifyRendererManifest(root, "desktop")).rejects.toThrow("contents differ");
});
