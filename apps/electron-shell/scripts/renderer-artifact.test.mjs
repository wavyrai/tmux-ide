import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
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
  await writeRendererManifest(root, "workspace");
  return root;
}

it("selects workspace explicitly and rejects ambiguous renderer requests", () => {
  expect(selectRenderer([])).toBe("desktop");
  expect(selectRenderer(["--renderer=workspace"])).toBe("workspace");
  expect(() => selectRenderer(["--renderer=other"])).toThrow();
  expect(() => selectRenderer(["--renderer=desktop", "--renderer=workspace"])).toThrow();
});
it("rejects packaging or reusing the wrong renderer", async () => {
  const root = await fixture();
  await expect(verifyRendererManifest(root, "workspace")).resolves.toMatchObject({
    renderer: "workspace",
  });
  await expect(verifyRendererManifest(root, "desktop")).rejects.toThrow("mismatch");
});
it("rejects changed or extra assets after the build", async () => {
  const root = await fixture();
  await writeFile(join(root, "renderer", "assets", "app.js"), "legacy()");
  await expect(verifyRendererManifest(root, "workspace")).rejects.toThrow("contents differ");
  await writeFile(join(root, "renderer", "assets", "app.js"), "workspace()");
  await writeFile(join(root, "renderer", "assets", "stale.js"), "old()");
  await expect(verifyRendererManifest(root, "workspace")).rejects.toThrow("contents differ");
});
it("keeps workspace selection through the package and smoke commands", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg.scripts["package:workspace"]).toBe(
    "pnpm build:workspace && node scripts/package.mjs --renderer=workspace",
  );
  expect(pkg.scripts["package:smoke:workspace"]).toBe(
    "pnpm package:workspace && node scripts/smoke.mjs --renderer=workspace",
  );
  expect(pkg.scripts["smoke:workspace"]).toContain("--renderer=workspace");
});
