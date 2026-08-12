import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

test("keeps fire-and-forget preload disposal handled under strict Bun", () => {
  const moduleUrl = new URL("./optional-feature-registry.ts", import.meta.url).href;
  const script = `
    import { OptionalFeatureRegistry } from ${JSON.stringify(moduleUrl)};
    let resolve;
    const physicalLoad = new Promise((accept) => { resolve = accept; });
    const registry = new OptionalFeatureRegistry({ files: () => physicalLoad });
    registry.admit();
    registry.preload("files");
    registry.dispose();
    resolve({ names: [] });
    await new Promise((accept) => setTimeout(accept, 10));
    if (registry.getMetrics().lateResultsDiscarded !== 1) process.exitCode = 2;
  `;
  const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--eval", script], {
    cwd: fileURLToPath(new URL("../../../../../../", import.meta.url)),
    encoding: "utf8",
  });
  expect(
    result.status,
    `${result.error?.message ?? "subprocess exited"}\n${result.stdout}\n${result.stderr}`,
  ).toBe(0);
});
