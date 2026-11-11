import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  realpath,
  writeFile,
  readFile,
  rm,
  lstat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateBundleMetadata,
  readBundleMetadata,
  bundlePlist,
  infoPlistStrings,
  appName,
  bundleBaseName,
} from "./app-bundle-metadata.mjs";
const good = { bundleId: "com.tmux-ide.gpui.preview", version: "0.1.0", buildNumber: "1" };
test("strict preview metadata generates exact safe plist fields; development defaults remain", () => {
  const value = validateBundleMetadata(good);
  assert.ok(Object.isFrozen(value));
  const plist = bundlePlist(value);
  for (const text of [
    good.bundleId,
    good.version,
    ">1<",
    "<key>CFBundleName</key><string>Tmux IDE</string>",
    "<key>CFBundleDisplayName</key><string>TmuxIDE</string>",
    "<key>LSHasLocalizedDisplayName</key><true/>",
    "<key>CFBundleDevelopmentRegion</key><string>en</string>",
    "14.2",
    "tmux-ide-launcher",
    "CFBundleIconFile",
    "AppIcon.icns",
    "CFBundleIconName",
  ])
    assert.ok(plist.includes(text));
  assert.match(bundlePlist(), /com\.tmux-ide\.gpui\.development/);
  assert.match(bundlePlist(), /<key>CFBundleName<\/key><string>Tmux IDE Development<\/string>/);
  // A development bundle shows its own file name: no display-name localization.
  assert.doesNotMatch(bundlePlist(), /CFBundleDisplayName|LSHasLocalizedDisplayName/);
  assert.match(bundlePlist(), />0\.0\.0</);
  if (process.platform === "darwin")
    assert.doesNotThrow(() => execFileSync("/usr/bin/plutil", ["-lint", "-"], { input: plist }));
});
test("unknown fields, types, namespace, injection and noncanonical numbers reject", () => {
  for (const bad of [
    null,
    [],
    { ...good, extra: true },
    { ...good, bundleId: "com.evil.preview" },
    { ...good, bundleId: "com.tmux-ide.gpui.development" },
    { ...good, bundleId: "com.tmux-ide.gpui.preview.development" },
    { ...good, bundleId: 'com.tmux-ide.gpui.<x>&"' },
    { ...good, version: "01.2.3" },
    { ...good, version: "1.2" },
    { ...good, version: 123 },
    { ...good, buildNumber: 1 },
    { ...good, buildNumber: "01" },
    { ...good, buildNumber: "1.2" },
    { ...good, buildNumber: "9".repeat(19) },
  ])
    assert.throws(() => validateBundleMetadata(bad));
});
test("bounded metadata file rejects links/oversize; invalid explicit assembly metadata precedes binary execution/output", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-metadata-")));
  try {
    const path = join(root, "metadata.json"),
      link = join(root, "link"),
      output = join(root, "New.app");
    await writeFile(path, JSON.stringify(good));
    assert.deepEqual(await readBundleMetadata(path), good);
    await symlink(path, link);
    await assert.rejects(readBundleMetadata(link));
    await writeFile(path, " ".repeat(4097));
    await assert.rejects(readBundleMetadata(path));
    await writeFile(path, JSON.stringify({ ...good, version: "bad" }));
    if (process.platform === "darwin")
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              fileURLToPath(new URL("./assemble-local-app.mjs", import.meta.url)),
              "/nonexistent-native",
              "/nonexistent-receipt",
              output,
              "--metadata",
              path,
            ],
            { timeout: 5000, stdio: "pipe" },
          ),
        /Invalid preview bundle version/,
      );
    await assert.rejects(lstat(output), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged icon is bound to its source artwork and a complete ICNS container", async () => {
  const provenance = JSON.parse(
    await readFile(new URL("../assets/app-icon-source.json", import.meta.url), "utf8"),
  );
  assert.equal(provenance.source, "apps/tmux-gpui/assets/AppIcon-1024.png");
  assert.equal(provenance.output, "AppIcon.icns");
  const source = await readFile(new URL("../assets/AppIcon-1024.png", import.meta.url));
  const icon = await readFile(new URL("../assets/AppIcon.icns", import.meta.url));
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash(source), provenance.sourceSha256);
  assert.equal(hash(icon), provenance.outputSha256);
  const iconRoot = new URL("../../../native/macos/notifier/AppIcon.icon/", import.meta.url);
  const layers = (await readdir(new URL("Assets/", iconRoot)))
    .filter((name) => name.endsWith(".svg"))
    .map((name) => `Assets/${name}`);
  const catalogSource = createHash("sha256");
  for (const file of ["icon.json", ...layers.sort()])
    catalogSource.update(`${file}\0`).update(await readFile(new URL(file, iconRoot)));
  const catalog = await readFile(new URL("../assets/Assets.car", import.meta.url));
  assert.equal(provenance.catalog.output, "Assets.car");
  assert.equal(catalogSource.digest("hex"), provenance.catalog.sourceSha256);
  assert.equal(hash(catalog), provenance.catalog.outputSha256);
  assert.equal(icon.toString("ascii", 0, 4), "icns");
  assert.equal(icon.readUInt32BE(4), icon.length);
  const representations = new Set();
  let offset = 8;
  while (offset < icon.length) {
    assert.ok(offset + 8 <= icon.length);
    const length = icon.readUInt32BE(offset + 4);
    assert.ok(length >= 8 && offset + length <= icon.length);
    representations.add(icon.toString("ascii", offset, offset + 4));
    offset += length;
  }
  assert.equal(offset, icon.length);
  for (const type of ["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"])
    assert.ok(representations.has(type), `Missing icon representation ${type}`);
});

test("the display name localizes only because it equals the bundle file every installer uses", async () => {
  // macOS uses en.lproj's CFBundleDisplayName only while the unlocalized one
  // equals the file name; a mismatch silently shows the file name again.
  assert.equal(appName, "Tmux IDE");
  assert.equal(bundleBaseName, "TmuxIDE");
  const plist = bundlePlist(validateBundleMetadata(good));
  assert.match(
    plist,
    new RegExp(`<key>CFBundleDisplayName</key><string>${bundleBaseName}</string>`),
  );
  const file = `"${bundleBaseName}.app"`;
  for (const source of [
    "./install-transaction.mjs",
    "./preview-release-extract.mjs",
    "./sign-preview-app.mjs",
    "./preview-release-package.py",
  ])
    assert.ok(
      (await readFile(new URL(source, import.meta.url), "utf8")).includes(file),
      `${source} names the bundle ${file}`,
    );
  assert.equal(
    infoPlistStrings(),
    '"CFBundleDisplayName" = "Tmux IDE";\n"CFBundleName" = "Tmux IDE";\n',
  );
  if (process.platform === "darwin") {
    const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-strings-")));
    try {
      const path = join(root, "InfoPlist.strings");
      await writeFile(path, infoPlistStrings());
      assert.doesNotThrow(() => execFileSync("/usr/bin/plutil", ["-lint", path]));
      const json = execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path], {
        encoding: "utf8",
      });
      assert.deepEqual(JSON.parse(json), { CFBundleDisplayName: appName, CFBundleName: appName });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
