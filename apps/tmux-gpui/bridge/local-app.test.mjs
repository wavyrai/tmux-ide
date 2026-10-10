import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyNativeBuildReceipt } from "../scripts/native-build-receipt.mjs";
import { validateBundleMetadata, developmentMetadata } from "../scripts/app-bundle-metadata.mjs";
const run = promisify(execFile);
const app = process.env.TMUX_GPUI_TEST_APP;
test("local app retains binary identity and refuses replacement", { skip: !app }, async () => {
  const root = resolve(app);
  const resources = join(root, "Contents/Resources");
  const manifests = (await readdir(resources)).filter((name) =>
    ["development-manifest.json", "assembly-manifest.json"].includes(name),
  );
  assert.equal(manifests.length, 1);
  const manifestPath = join(resources, manifests[0]);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.distribution, false);
  assert.equal(manifest.signing, "not-qualified");
  const expected =
    manifests[0] === "assembly-manifest.json"
      ? validateBundleMetadata(manifest.metadata)
      : developmentMetadata;
  for (const [key, value] of Object.entries({
    CFBundleIdentifier: expected.bundleId,
    CFBundleShortVersionString: expected.version,
    CFBundleVersion: expected.buildNumber,
    CFBundleName:
      manifests[0] === "assembly-manifest.json" ? "tmux-ide Preview" : "tmux-ide Development",
    LSMinimumSystemVersion: "14.2",
  })) {
    assert.equal(
      (
        await run("/usr/bin/plutil", [
          "-extract",
          key,
          "raw",
          "-o",
          "-",
          join(root, "Contents/Info.plist"),
        ])
      ).stdout.trim(),
      value,
    );
  }
  const upstream = fileURLToPath(new URL("../upstream/", import.meta.url));
  assert.equal(manifest.nativeBuild.file, "native-build-receipt.json");
  await verifyNativeBuildReceipt(
    join(resources, manifest.nativeBuild.file),
    join(root, "Contents/MacOS/tmux-ide-gpui"),
    upstream,
  );
  for (const [name, source] of Object.entries({
    "HERDR-PROTOCOL-LICENSE": "crates/herdr-protocol/LICENSE-APACHE",
    "HERDR-PROTOCOL-NOTICE": "crates/herdr-protocol/NOTICE.md",
    "HERDR-SOUND-NOTICE": "crates/herdr-gpui/SOUND-NOTICE.md",
    "HERDR-GITHUB-NOTICE": "crates/herdr-gpui/GITHUB-NOTICE.md",
    "OCTICONS-LICENSE": "assets/icons/LICENSE-octicons",
  })) {
    assert.deepEqual(await readFile(join(resources, name)), await readFile(join(upstream, source)));
  }
  assert.equal(manifest.rustNotices.file, "RUST-THIRD-PARTY-NOTICES.txt");
  const rustReport = await readFile(join(resources, manifest.rustNotices.file), "utf8");
  const lockHash = createHash("sha256")
    .update(await readFile(join(upstream, "Cargo.lock")))
    .digest("hex");
  assert.ok(rustReport.includes(`Cargo.lock SHA-256: ${lockHash}`));
  assert.match(rustReport, /Packages \(including workspace\): [1-9][0-9]*/);
  for (const [path, hash] of [
    [join(root, "Contents/MacOS/tmux-ide-gpui"), manifest.nativeSha256],
    [join(resources, "node"), manifest.nodeSha256],
    [join(resources, manifest.nativeBuild.file), manifest.nativeBuild.sha256],
    [join(resources, manifest.rustNotices.file), manifest.rustNotices.sha256],
  ]) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      hash,
    );
  }
  const builder = fileURLToPath(new URL("../scripts/assemble-local-app.mjs", import.meta.url));
  await assert.rejects(
    run(process.execPath, [
      builder,
      join(root, "Contents/MacOS/tmux-ide-gpui"),
      join(resources, "node"),
      join(resources, "NODE-LICENSE"),
      join(resources, manifest.nativeBuild.file),
      root,
    ]),
    /EEXIST/,
  );
  assert.equal(await readFile(manifestPath, "utf8"), manifestText);
});
test("local launcher never resolves dirname through caller PATH", { skip: !app }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "gpui-hostile-path-"));
  try {
    await writeFile(
      join(temp, "dirname"),
      '#!/bin/sh\nprintf attacked > "$PROOF_MARKER"\nexit 99\n',
      { mode: 0o755 },
    );
    const marker = join(temp, "unexpected");
    await assert.rejects(
      run(join(resolve(app), "Contents/MacOS/tmux-ide-launcher"), ["one", "two"], {
        cwd: temp,
        env: { ...process.env, PATH: temp, PROOF_MARKER: marker },
      }),
      (error) => error.code === 2 && error.stderr.includes("Usage:"),
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test(
  "assembler rejects a mismatched executable before running supplied tools",
  { skip: !app },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "gpui-receipt-rejection-"));
    try {
      const marker = join(temp, "unexpected-execution");
      const candidate = join(temp, "candidate");
      await writeFile(candidate, '#!/bin/sh\nprintf executed > "$GPUI_RECEIPT_MARKER"\n', {
        mode: 0o755,
      });
      const builder = fileURLToPath(new URL("../scripts/assemble-local-app.mjs", import.meta.url));
      await assert.rejects(
        run(
          process.execPath,
          [
            builder,
            candidate,
            candidate,
            join(resolve(app), "Contents/Resources/NODE-LICENSE"),
            join(resolve(app), "Contents/Resources/native-build-receipt.json"),
            join(temp, "Rejected.app"),
          ],
          { env: { ...process.env, GPUI_RECEIPT_MARKER: marker }, timeout: 15000 },
        ),
        /Native binary receipt mismatch/,
      );
      await assert.rejects(access(marker), { code: "ENOENT" });
      await assert.rejects(access(join(temp, "Rejected.app")), { code: "ENOENT" });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
