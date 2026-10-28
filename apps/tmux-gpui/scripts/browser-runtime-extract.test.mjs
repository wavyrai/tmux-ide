import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractBrowserRuntime } from "./browser-runtime-extract.mjs";

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "browser-extract-test-")));
  const input = join(root, "input");
  const app = join(input, "terminal-browser.app");
  const destinationRoot = join(root, "cache");
  await mkdir(join(app, "Contents/Versions/A"), { recursive: true });
  await mkdir(destinationRoot, { mode: 0o700 });
  await writeFile(join(app, "Contents/Versions/A/runtime"), "runtime", { mode: 0o755 });
  const internalLinks = {
    "Contents/Versions/Current": "A",
    "Contents/runtime": "Versions/Current/runtime",
  };
  for (const [path, target] of Object.entries(internalLinks))
    await symlink(target, join(app, path));
  const archive = async () => {
    const archivePath = join(root, "runtime.tar.gz");
    execFileSync(
      "/usr/bin/tar",
      ["--format=ustar", "-czf", archivePath, "-C", input, "terminal-browser.app"],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        timeout: 5000,
      },
    );
    const bytes = await readFile(archivePath);
    return {
      archivePath,
      destinationRoot,
      metadata: {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        internalLinks,
      },
    };
  };
  try {
    await run({ root, app, destinationRoot, archive, internalLinks });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("extracts real files before approved framework link chains", () =>
  fixture(async ({ archive }) => {
    const result = await extractBrowserRuntime(await archive());
    assert.equal(await readFile(join(result.appPath, "Contents/runtime"), "utf8"), "runtime");
    assert.equal(
      await realpath(join(result.appPath, "Contents/runtime")),
      join(result.appPath, "Contents/Versions/A/runtime"),
    );
  }));

for (const kind of ["digest", "unapproved", "missing", "escape", "cycle", "hardlink", "cancel"]) {
  test(`rejects ${kind} and leaves no partial cache`, () =>
    fixture(async ({ archive, app, destinationRoot, internalLinks }) => {
      if (kind === "escape") {
        await symlink("../../../outside", join(app, "Contents/escape"));
        internalLinks["Contents/escape"] = "../../../outside";
      }
      if (kind === "cycle") {
        await symlink("cycle", join(app, "Contents/cycle"));
        internalLinks["Contents/cycle"] = "cycle";
      }
      if (kind === "hardlink")
        await link(join(app, "Contents/Versions/A/runtime"), join(app, "Contents/hard"));
      const options = await archive();
      if (kind === "digest") options.metadata.sha256 = "0".repeat(64);
      if (kind === "unapproved") delete internalLinks["Contents/runtime"];
      if (kind === "missing") internalLinks["Contents/missing"] = "Versions/A/runtime";
      if (kind === "cancel") options.signal = AbortSignal.abort();
      await assert.rejects(extractBrowserRuntime(options));
      assert.deepEqual(await readdir(destinationRoot), []);
    }));
}
