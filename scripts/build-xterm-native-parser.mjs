#!/usr/bin/env node
/** Build the vendored parser from a verified fork commit and our source patch. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, "packages/daemon/native/xterm");
const provenance = JSON.parse(readFileSync(join(destination, "provenance.json"), "utf8"));
const sourceFlag = process.argv.indexOf("--source");
if (sourceFlag < 0 || !process.argv[sourceFlag + 1])
  throw new Error("Pass --source with a local checkout of the pinned xterm fork");
const source = resolve(process.argv[sourceFlag + 1]);
const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (commit !== provenance.commit) throw new Error("Parser source commit does not match provenance");
if (esbuildVersion !== provenance.esbuild) throw new Error("Parser compiler version mismatch");
const patch = readFileSync(join(destination, provenance.patch));
if (createHash("sha256").update(patch).digest("hex") !== provenance.patchSha256)
  throw new Error("Parser source patch checksum mismatch");
const scratch = mkdtempSync(join(tmpdir(), "tmux-ide-parser-build-"));
try {
  // Archive the commit, never uncommitted changes in the supplied checkout.
  const archive = execFileSync("git", ["-C", source, "archive", commit], {
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archive });
  execFileSync("git", ["apply", "-"], { cwd: scratch, input: patch });
  const packageRoot = join(scratch, "package");
  mkdirSync(join(packageRoot, "lib-headless"), { recursive: true });
  mkdirSync(join(packageRoot, "typings"));
  for (const format of ["esm", "cjs"]) {
    await build({
      absWorkingDir: scratch,
      entryPoints: [join(scratch, "src/headless/public/Terminal.ts")],
      bundle: true,
      platform: "node",
      format,
      target: "es2021",
      outfile: join(
        packageRoot,
        "lib-headless",
        `xterm-headless.${format === "esm" ? "mjs" : "js"}`,
      ),
      alias: Object.fromEntries(
        ["common", "headless", "vs"].map((name) => [name, join(scratch, "src", name)]),
      ),
      tsconfig: join(scratch, "src/tsconfig-base.json"),
    });
  }
  execFileSync(
    process.execPath,
    [join(destination, "verify-ed2.mjs"), join(packageRoot, "lib-headless/xterm-headless.mjs")],
    { stdio: "inherit" },
  );
  const types = readFileSync(join(scratch, "typings/xterm-headless.d.ts"), "utf8");
  writeFileSync(
    join(packageRoot, "typings/xterm-headless.d.ts"),
    types.replace("declare module '@xterm/headless'", "declare module '@tmux-ide/xterm-headless'"),
  );
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    copyFileSync(join(scratch, name), join(packageRoot, name));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify(
      {
        name: provenance.package,
        version: provenance.version,
        description:
          "tmux-ide headless parser with native one-column geometry and tmux ED2 history",
        license: "MIT",
        main: "lib-headless/xterm-headless.js",
        module: "lib-headless/xterm-headless.mjs",
        types: "typings/xterm-headless.d.ts",
        exports: {
          ".": {
            types: "./typings/xterm-headless.d.ts",
            import: "./lib-headless/xterm-headless.mjs",
            require: "./lib-headless/xterm-headless.js",
          },
        },
        tmuxIdeSource: provenance,
      },
      null,
      2,
    ) + "\n",
  );
  execFileSync("npm", ["pack", packageRoot, "--pack-destination", destination], {
    stdio: "inherit",
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
