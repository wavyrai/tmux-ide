import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { cliBundlePlugins } from "./cli-bundle-policy.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("owner evidence bundle uses the supported narrow core entry without terminal initialization", async () => {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        export { OwnerInteractionObservation } from "./owner-interaction-observation.ts";
        export { AuthoredNativeReceiptEnricher } from "./authored-native-receipt-staging.ts";
      `,
      resolveDir: resolve(root, "packages/daemon/src/lib"),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    write: false,
    metafile: true,
    plugins: cliBundlePlugins(),
  });
  const inputs = Object.keys(result.metafile.inputs);
  const auditedContractsRoot = realpathSync(resolve(root, "packages/contracts/src"));
  for (const input of inputs.filter((path) => path.includes("/contracts/src/"))) {
    assert.equal(
      realpathSync(resolve(root, input)).split("/contracts/src/")[0] + "/contracts/src",
      auditedContractsRoot,
      "owner qualification must apply the contract transform to its actual inputs",
    );
  }
  assert.ok(inputs.some((path) => path.endsWith("/core/src/interaction-evidence.ts")));
  assert.ok(!inputs.some((path) => /\/core\/src\/(?:index|terminal-|navigator)/u.test(path)));
  const output = result.outputFiles[0].text;
  for (const marker of [
    "TERMINAL_CONFORMANCE_FIXTURES",
    "XTERM_PALETTE",
    "TERMINAL_FNV64_WASM_BYTES",
  ])
    assert.ok(!output.includes(marker), `unused initialization retained: ${marker}`);
  assert.ok(output.includes("canEnrichInteractionEvidence"));
  assert.ok(output.includes("safeParse"), "evidence validation must remain in the owner bundle");
});
