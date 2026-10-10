import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createManifest, verifyManifest } from "./preview-release-manifest.mjs";
const keys = generateKeyPairSync("ed25519"); // Ephemeral test keys only, never production policy.
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const version = "2.9.5-preview_1";
const input = { version, archiveSize: 12345, sha256: "ab".repeat(32) };
const policy = { publicKey, expectedVersion: version };
const signed = (bytes, override = {}) =>
  verifyManifest(bytes, sign(null, bytes, keys.privateKey), { ...policy, ...override });
const changed = (edit) => {
  const value = JSON.parse(createManifest(input));
  edit(value);
  return Buffer.from(JSON.stringify(value));
};
test("exact signed roundtrip returns an independent frozen asset", () => {
  const bytes = createManifest(input);
  assert.ok(Buffer.isBuffer(bytes));
  const asset = signed(bytes);
  assert.deepEqual(asset, {
    target: "aarch64-apple-darwin",
    name: `tmux-ide-gpui-${version}-macos-arm64.app.tar.gz`,
    size: 12345,
    sha256: input.sha256,
  });
  assert.ok(Object.isFrozen(asset));
  bytes.fill(0);
  assert.equal(asset.size, 12345);
});
test("tampered body/whitespace, wrong key and unsigned malformed JSON fail authentication first", () => {
  const bytes = createManifest(input),
    signature = sign(null, bytes, keys.privateKey);
  for (const altered of [
    Buffer.concat([bytes, Buffer.from("\n")]),
    changed((v) => {
      v.assets[0].size++;
    }),
    Buffer.from("not JSON PRIVATE_CONTENT"),
  ])
    assert.throws(() => verifyManifest(altered, signature, policy), /authentication failed/);
  const wrong = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  assert.throws(
    () => verifyManifest(bytes, signature, { ...policy, publicKey: wrong }),
    /authentication failed/,
  );
  assert.throws(
    () => verifyManifest(Buffer.from("{"), Buffer.alloc(64), policy),
    /authentication failed/,
  );
  // Whitespace is legal only when included in the authenticated exact byte stream.
  assert.equal(signed(Buffer.concat([bytes, Buffer.from("\n")])).size, input.archiveSize);
});
test("authenticated payloads still require exact schema, target, name, digest and expected version", () => {
  for (const edit of [
    (v) => {
      v.schema = 2;
    },
    (v) => {
      v.extra = "secret";
    },
    (v) => {
      v.version = "2.9.6";
    },
    (v) => {
      v.assets = [];
    },
    (v) => {
      v.assets.push(v.assets[0]);
    },
    (v) => {
      v.assets[0].extra = true;
    },
    (v) => {
      v.assets[0].target = "x86_64-apple-darwin";
    },
    (v) => {
      v.assets[0].name = "../arbitrary.tar.gz";
    },
    (v) => {
      v.assets[0].sha256 = "AB".repeat(32);
    },
    (v) => {
      v.assets[0].sha256 = "a".repeat(63);
    },
    (v) => {
      delete v.assets[0].size;
    },
  ])
    assert.throws(() => signed(changed(edit)), /schema or version/);
  assert.throws(
    () => signed(createManifest(input), { expectedVersion: "2.9.6" }),
    /schema or version/,
  );
  assert.throws(() => signed(Buffer.from("{")), /JSON/);
  assert.throws(() => signed(Buffer.from([0xff])), /JSON/);
});
test("archive and manifest byte bounds are inclusive and types strict", () => {
  for (const archiveSize of [1, 256 * 1024 * 1024])
    assert.equal(signed(createManifest({ ...input, archiveSize })).size, archiveSize);
  for (const archiveSize of [0, -1, 256 * 1024 * 1024 + 1, 1.5, NaN, Infinity, "1"]) {
    assert.throws(() => createManifest({ ...input, archiveSize }), /input/);
    if (Number.isFinite(archiveSize) || typeof archiveSize === "string")
      assert.throws(
        () =>
          signed(
            changed((v) => {
              v.assets[0].size = archiveSize;
            }),
          ),
        /schema/,
      );
  }
  const bytes = createManifest(input);
  const atLimit = Buffer.concat([bytes, Buffer.alloc(65536 - bytes.length, 32)]);
  assert.equal(signed(atLimit).size, input.archiveSize);
  assert.throws(() => signed(Buffer.concat([atLimit, Buffer.from(" ")])), /bounds/);
  assert.throws(() => verifyManifest("{}", Buffer.alloc(64), policy), /bounds/);
  for (const n of [0, 31, 33])
    assert.throws(() => signed(bytes, { publicKey: Buffer.alloc(n) }), /public key length/);
  for (const n of [0, 63, 65])
    assert.throws(() => verifyManifest(bytes, Buffer.alloc(n), policy), /signature length/);
});
test("versions use installer-safe identity, not calendar parsing or ordering", () => {
  for (const v of ["a", "A".repeat(64), "preview-v2_9.5"])
    assert.equal(
      signed(createManifest({ ...input, version: v }), { expectedVersion: v }).name,
      `tmux-ide-gpui-${v}-macos-arm64.app.tar.gz`,
    );
  for (const v of ["", ".hidden", "a..b", "../x", "a/b", "a\\b", "a\n", "A".repeat(65), 123]) {
    assert.throws(() => createManifest({ ...input, version: v }), /input/);
    assert.throws(() => signed(createManifest(input), { expectedVersion: v }), /bounds/);
  }
});
