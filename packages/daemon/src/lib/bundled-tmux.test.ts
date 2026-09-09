import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMacOSVersionCompatible,
  resolveBundledTmux,
  validateBundledTmux,
} from "./bundled-tmux.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tmux-bundle-test-"));
  directories.push(root);
  const bundle = join(
    root,
    "packages/daemon/dist/native/tmux",
    `${process.platform}-${process.arch}`,
  );
  mkdirSync(bundle, { recursive: true });
  const bytes = "#!/bin/sh\nexit 0\n";
  writeFileSync(join(bundle, "tmux"), bytes);
  chmodSync(join(bundle, "tmux"), 0o755);
  const manifest = {
    schemaVersion: 1,
    minimumMacOS: "10.0",
    platform: process.platform,
    arch: process.arch,
    extension: "tmux-ide-native-grid-v2",
    files: { tmux: createHash("sha256").update(bytes).digest("hex") },
  };
  const save = () => writeFileSync(join(bundle, "manifest.json"), JSON.stringify(manifest));
  save();
  return { root, bundle, manifest, save };
}
describe("bundled tmux authority", () => {
  it.each(["tmux-ide-native-grid-v1", "tmux-ide-native-grid-v2"])(
    "accepts known extension %s while retaining integrity validation",
    (extension) => {
      const { bundle, manifest, save } = fixture();
      manifest.extension = extension;
      save();
      expect(validateBundledTmux(bundle)).toBe(realpathSync(join(bundle, "tmux")));
      writeFileSync(join(bundle, "tmux"), "tampered");
      expect(() => validateBundledTmux(bundle)).toThrow("checksum mismatch");
    },
  );
  it.each([undefined, null, "", "tmux-ide-native-grid-v3", "tmux-ide-native-grid-v2-extra"])(
    "rejects unsupported extension %s",
    (extension) => {
      const { bundle, manifest, save } = fixture();
      Object.assign(manifest, { extension });
      save();
      expect(() => validateBundledTmux(bundle)).toThrow("manifest");
    },
  );
  it.each([
    ["26.0", "26.0.0", true],
    ["15.7", "26.0", false],
    ["26.1", "26.0", true],
    ["10.9", "10.10", false],
    ["10.15.6", "10.15.7", false],
    ["10.15.7", "10.15.7", true],
    ["11.0", "10.15.7", true],
  ])("compares macOS %s against minimum %s", (current, minimum, compatible) => {
    expect(isMacOSVersionCompatible(current, minimum)).toBe(compatible);
  });
  it.each(["", "26", "26.0-beta", "26.NaN", "26.0.0.1", "-1.0"])(
    "rejects invalid OS metadata %s",
    (version) => {
      expect(() => isMacOSVersionCompatible("26.0", version)).toThrow("version metadata");
      expect(() => isMacOSVersionCompatible(version, "26.0")).toThrow("version metadata");
    },
  );
  it.skipIf(process.platform !== "darwin")(
    "falls back only for a verified but newer macOS bundle",
    () => {
      const { root, bundle, manifest, save } = fixture();
      manifest.minimumMacOS = "26.0";
      save();
      const anchors = [join(root, "bin/cli.js")];
      expect(resolveBundledTmux(anchors, () => "15.7")).toBeNull();
      expect(resolveBundledTmux(anchors, () => "26.0")).toBe(validateBundledTmux(bundle));
      writeFileSync(join(bundle, "tmux"), "changed");
      expect(() => resolveBundledTmux(anchors, () => "15.7")).toThrow("checksum mismatch");
    },
  );
  it.skipIf(process.platform !== "darwin")("rejects missing or malformed OS metadata", () => {
    const { bundle, manifest, save } = fixture();
    for (const version of [undefined, "not-a-version", 26]) {
      Object.assign(manifest, { minimumMacOS: version });
      save();
      expect(() => validateBundledTmux(bundle)).toThrow("version metadata");
    }
  });
  it("resolves the same verified bundle from CLI and source entry points", () => {
    const { root, bundle } = fixture();
    expect(resolveBundledTmux([join(root, "bin/cli.js")])).toBe(validateBundledTmux(bundle));
    expect(resolveBundledTmux([join(root, "packages/daemon/src/lib/daemon-embed.ts")])).toBe(
      validateBundledTmux(bundle),
    );
  });
  it("returns no bundled authority when the installation has no bundle", () => {
    const { root } = fixture();
    rmSync(join(root, "packages"), { recursive: true });
    expect(resolveBundledTmux([join(root, "bin/cli.js")])).toBeNull();
  });
  it("restores npm-normalized executable permissions only for verified bytes", () => {
    const { bundle } = fixture();
    const executable = join(bundle, "tmux");
    chmodSync(executable, 0o644);
    validateBundledTmux(bundle);
    expect(statSync(executable).mode & 0o111).toBe(0o111);
    chmodSync(executable, 0o644);
    writeFileSync(executable, "tampered");
    expect(() => validateBundledTmux(bundle)).toThrow("checksum mismatch");
    expect(statSync(executable).mode & 0o111).toBe(0);
  });
  it("rejects a changed executable instead of silently starting a different server", () => {
    const { root, bundle } = fixture();
    writeFileSync(join(bundle, "tmux"), "changed");
    expect(() => resolveBundledTmux([join(root, "bin/cli.js")])).toThrow("checksum mismatch");
  });
  it("rejects architecture mismatches and files outside the bundle", () => {
    const { root, bundle } = fixture();
    expect(() =>
      validateBundledTmux(bundle, process.platform, "wrong" as NodeJS.Architecture),
    ).toThrow("manifest");
    rmSync(join(bundle, "tmux"));
    writeFileSync(join(root, "external"), "outside");
    symlinkSync(join(root, "external"), join(bundle, "tmux"));
    expect(() => validateBundledTmux(bundle)).toThrow("escapes");
  });
});
