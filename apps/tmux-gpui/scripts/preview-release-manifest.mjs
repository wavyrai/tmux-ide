// Adapted authentication pattern from penso/herdr-gpui (Apache-2.0), pinned at
// 302700e1486977092e4a9165bc083ecdc9236227:
// crates/herdr-gpui/src/updater/release.rs (verify_manifest) and
// scripts/update-manifest.py (create / ED25519_SPKI). See upstream/LICENSE and NOTICE.
// Local component only: no endpoints, signing keys, version ordering, download,
// archive extraction, Apple signature policy or installation is implemented here.
import { createPublicKey, verify } from "node:crypto";
const MANIFEST_LIMIT = 64 * 1024;
const ARCHIVE_LIMIT = 256 * 1024 * 1024;
const TARGET = "aarch64-apple-darwin";
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const validVersion = (v) =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) && !v.includes("..");
const nameFor = (version) => `tmux-ide-gpui-${version}-macos-arm64.app.tar.gz`;
function exactFields(value, fields) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}
function assetValid(asset, version) {
  return (
    exactFields(asset, ["target", "name", "size", "sha256"]) &&
    asset.target === TARGET &&
    asset.name === nameFor(version) &&
    Number.isSafeInteger(asset.size) &&
    asset.size >= 1 &&
    asset.size <= ARCHIVE_LIMIT &&
    typeof asset.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(asset.sha256)
  );
}
export function createManifest({ version, archiveSize, sha256 }) {
  if (!validVersion(version)) throw new Error("Invalid release manifest input");
  const asset = { target: TARGET, name: nameFor(version), size: archiveSize, sha256 };
  if (!assetValid(asset, version)) throw new Error("Invalid release manifest input");
  return Buffer.from(JSON.stringify({ schema: 1, version, assets: [asset] }), "utf8");
}
function rawBytes(value, length, label) {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new Error(`Invalid ${label} length`);
  return Buffer.from(value);
}
/** publicKey must come from independent trusted caller policy, never the manifest/archive. */
export function verifyManifest(bytes, signature, { publicKey, expectedVersion }) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MANIFEST_LIMIT ||
    !validVersion(expectedVersion)
  )
    throw new Error("Invalid release manifest bounds or expected version");
  // Own one immutable-in-this-call byte copy for authentication AND parsing.
  const payload = Buffer.from(bytes);
  const rawKey = rawBytes(publicKey, 32, "public key");
  const rawSignature = rawBytes(signature, 64, "signature");
  const key = createPublicKey({ key: Buffer.concat([SPKI, rawKey]), format: "der", type: "spki" });
  if (!verify(null, payload, key, rawSignature))
    throw new Error("Release manifest authentication failed");
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new Error("Invalid authenticated release manifest JSON");
  }
  if (
    !exactFields(manifest, ["schema", "version", "assets"]) ||
    manifest.schema !== 1 ||
    !validVersion(manifest.version) ||
    manifest.version !== expectedVersion ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== 1 ||
    !assetValid(manifest.assets[0], manifest.version)
  )
    throw new Error("Invalid authenticated release manifest schema or version");
  return Object.freeze({ ...manifest.assets[0] });
}
