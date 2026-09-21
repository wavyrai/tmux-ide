import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const NATIVE_SCROLL_RELEASE_PINS = Object.freeze({
  sourceCommit: "ad9a818d7a9d73f3386e92a445d0feb4b395c69e",
  zigVersion: "0.15.2",
  coreVersion: "0.5.1",
});
export const nativeScrollSha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export function nativeScrollHostLibc(platform = process.platform) {
  if (platform !== "linux") return null;
  return process.report?.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
}

// This manifest authenticates build inputs and local artifacts against the
// checked-out recipe. CI still supplies trust in the builder and release SHA.
export function validateNativeScrollReleaseManifest(path, options) {
  const { repository, target, sourceState, coreVersion } = options;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const libc = options.libc === undefined ? nativeScrollHostLibc(platform) : options.libc;
  const fail = (message) => {
    throw new Error(`Native renderer release: ${message}`);
  };
  if (!["clean", "version-aligned"].includes(sourceState)) fail("application source is dirty");
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch))
    fail("unsupported host");
  if (target !== `bun-${platform}-${arch}`) fail("host-target mismatch");
  if (platform === "linux" && libc !== "glibc") fail("musl is not qualified");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.version !== 1 || manifest.status !== "passed") fail("manifest did not pass");
  for (const [key, value] of Object.entries(NATIVE_SCROLL_RELEASE_PINS))
    if (manifest[key] !== value) fail(`unexpected ${key}`);
  if (coreVersion !== manifest.coreVersion) fail("OpenTUI JavaScript ABI mismatch");
  if (manifest.platform !== platform || manifest.arch !== arch || manifest.libc !== libc)
    fail("manifest platform or libc mismatch");
  if (
    manifest.patchSha256 !==
    nativeScrollSha256(resolve(repository, "patches/opentui-native-scroll-ad9a818.patch"))
  )
    fail("patch digest mismatch");
  if (
    manifest.recipeSha256 !==
    nativeScrollSha256(resolve(repository, "scripts/native/build-opentui-scroll.mjs"))
  )
    fail("build recipe digest mismatch");
  const root = realpathSync(dirname(path));
  const artifact = (record, name) => {
    if (
      !record ||
      typeof record.path !== "string" ||
      isAbsolute(record.path) ||
      !/^[a-f0-9]{64}$/.test(record.sha256 ?? "")
    )
      fail(`invalid ${name} artifact`);
    const full = realpathSync(resolve(root, record.path));
    const rel = relative(root, full);
    if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      fail(`${name} escapes build output`);
    if (nativeScrollSha256(full) !== record.sha256) fail(`${name} digest mismatch`);
    return full;
  };
  artifact(manifest.tests, "native tests");
  artifact(manifest.build, "native build");
  const library = artifact(manifest.library, "library");
  const expectedSuffix = platform === "darwin" ? ".dylib" : ".so";
  if (!library.endsWith(expectedSuffix)) fail("library extension mismatch");
  return Object.freeze({ library, manifest });
}
