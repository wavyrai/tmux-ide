import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const root = process.cwd(),
  base = resolve(import.meta.dirname),
  head = "6b7cff16";
const overrides = [
  "apps/tmux-gpui/bridge/browser.ts",
  "apps/tmux-gpui/bridge/retained-frame-cache.ts",
];
const candidateOnly = "apps/tmux-gpui/bridge/browser-publication.ts";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const git = (p) =>
  execFileSync("git", ["show", `${head}:${p}`], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const protectedBefore = sha(await readFile(join(root, "bin/cli.js")));
const receipt = {
  baselineSource: execFileSync("git", ["rev-parse", head], { encoding: "utf8" }).trim(),
  cli: {
    sourceReceipt:
      "nr01-current-payload at873ef58e; unchanged bin/packages/buildCLI source through6b7cff16",
    path: join(root, ".tasks/native-reliability-mission/nr07-guidance-runtime/cli.mjs"),
  },
  variants: {},
};
receipt.cli.sha256 = sha(await readFile(receipt.cli.path));
assert.equal(
  receipt.cli.sha256,
  "d4252e328292012da246bc086833c3720b0e55365e50e5da86826a4f2c31b1f5",
);
assert.equal(
  execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "873ef58e",
      "6b7cff16",
      "--",
      "bin",
      "packages",
      "scripts/build-cli.mjs",
      "scripts/lib/cli-bundle-policy.mjs",
    ],
    { encoding: "utf8" },
  ),
  "",
);
for (const variant of ["baseline", "candidate"]) {
  const out = join(base, variant);
  await mkdir(out);
  const result = await build({
    entryPoints: ["browser", "live"].map((n) => join(root, `apps/tmux-gpui/bridge/${n}.ts`)),
    outdir: out,
    entryNames: "[name].bundle",
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    metafile: true,
    sourcemap: false,
    legalComments: "eof",
    define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
    banner: {
      js: 'import { createRequire as __gpuiCreateRequire } from "node:module"; const require = __gpuiCreateRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "exact-baseline",
        setup(b) {
          if (variant === "baseline")
            b.onLoad({ filter: /\.ts$/ }, async (a) => {
              const p = relative(root, a.path);
              if (overrides.includes(p))
                return { contents: git(p).toString(), loader: "ts", resolveDir: dirname(a.path) };
            });
        },
      },
    ],
  });
  const inputs = {};
  for (const input of Object.keys(result.metafile.inputs)) {
    const p = resolve(root, input);
    let bytes = await readFile(p);
    const name = relative(root, p);
    if (variant === "baseline" && overrides.includes(name)) bytes = git(name);
    const dependency = name.split("/").includes("node_modules");
    if (!dependency && !(variant === "candidate" && [...overrides, candidateOnly].includes(name)))
      assert.deepEqual(bytes, git(name), `unexpected source delta ${name}`);
    inputs[name] = { sha256: sha(bytes), dependency };
  }
  receipt.variants[variant] = { inputs, files: {} };
  for (const n of ["browser", "live"])
    receipt.variants[variant].files[n] = sha(await readFile(join(out, `${n}.bundle.mjs`)));
  await writeFile(join(out, "metafile.json"), JSON.stringify(result.metafile, null, 2) + "\n");
}
assert.equal(receipt.variants.baseline.files.live, receipt.variants.candidate.files.live);
assert.ok(!receipt.variants.baseline.inputs[candidateOnly]);
assert.deepEqual(
  Object.keys(receipt.variants.candidate.inputs).filter(
    (p) => !receipt.variants.baseline.inputs[p],
  ),
  [candidateOnly],
);
for (const [p, v] of Object.entries(receipt.variants.baseline.inputs))
  if (!overrides.includes(p))
    assert.equal(v.sha256, receipt.variants.candidate.inputs[p]?.sha256, p);
receipt.protectedCliUnchanged = sha(await readFile(join(root, "bin/cli.js"))) === protectedBefore;
assert.ok(receipt.protectedCliUnchanged);
await writeFile(join(base, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
