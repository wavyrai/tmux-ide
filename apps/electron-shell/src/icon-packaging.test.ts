import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("bundles shared icons for the web without any native provider, Apple image, or symbol map", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../../web-workspace/src/icons.tsx", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    write: false,
    metafile: true,
  });
  const source = result.outputFiles[0]!.text;
  expect(Object.keys(result.metafile.inputs).some((path) => path.includes("electron-shell/"))).toBe(
    false,
  );
  expect(source).not.toContain("createFromNamedImage");
  expect(source).not.toContain("rectangle.split.2x1");
  expect(source).not.toMatch(/data:image\/png;base64,[A-Za-z0-9+/]{30}/u);
  expect(source).toContain("HugeiconsIcon");
});
