import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  readlink,
  rm,
  rename,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createManifest } from "./preview-release-manifest.mjs";
import { installRelease } from "./preview-release-install.mjs";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const applePolicy = {
  teamId: "ABCDE12345",
  bundleId: "com.example.preview",
  architecture: "arm64",
  minimumMacOS: "14.2",
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-release-install-")));
  const destinationRoot = join(root, "staging"),
    installRoot = join(root, "installed"),
    input = join(root, "input");
  await mkdir(destinationRoot, { mode: 0o700 });
  await writeFile(join(destinationRoot, "unrelated"), "keep");
  await mkdir(join(input, "TmuxIDE.app/Contents"), { recursive: true });
  const release = async (version, embeddedVersion = version) => {
    await writeFile(join(input, "TmuxIDE.app/Contents/version"), embeddedVersion);
    const tar = join(root, "input.tar");
    execFileSync("/usr/bin/tar", ["--format=ustar", "-cf", tar, "-C", input, "TmuxIDE.app"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      timeout: 5000,
      maxBuffer: 65536,
    });
    const archive = gzipSync(await readFile(tar));
    const manifestBytes = createManifest({
      version,
      archiveSize: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
    });
    return {
      options: {
        manifestBytes,
        signature: sign(null, manifestBytes, keys.privateKey),
        policy: { publicKey, expectedVersion: version },
        baseUrl: "https://fixture.invalid/releases/",
        redirectOrigins: [],
        destinationRoot,
        installRoot,
        applePolicy: { ...applePolicy },
      },
      archive,
    };
  };
  const calls = [];
  const deps = (r, verifyApp) => ({
    platform: "darwin",
    fetchImpl: async (url, init) => {
      assert.equal(
        url,
        `https://fixture.invalid/releases/tmux-ide-gpui-${r.options.policy.expectedVersion}-macos-arm64.app.tar.gz`,
      );
      assert.equal(init.redirect, "manual");
      return new Response(r.archive);
    },
    verifyApp:
      verifyApp ??
      (async (copy, policy, options) => {
        assert.ok(copy.startsWith(installRoot + "/versions/.pending-"));
        assert.ok(copy.endsWith("/TmuxIDE.app"));
        assert.deepEqual(policy, applePolicy);
        assert.ok(Object.isFrozen(policy));
        assert.equal(
          await readFile(join(copy, "Contents/version"), "utf8"),
          options.expectedVersion,
        );
        calls.push({ copy, version: options.expectedVersion });
        return true;
      }),
  });
  try {
    await run({ root, input, destinationRoot, installRoot, release, deps, calls });
    assert.equal(await readFile(join(destinationRoot, "unrelated"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const clean = async (f) => assert.deepEqual(await readdir(f.destinationRoot), ["unrelated"]);
test("real download/extraction/transaction install, repeat and upgrade verify the private copy/version", async () => {
  await fixture(async (f) => {
    const a = await f.release("v1");
    const initial = await installRelease(a.options, f.deps(a));
    assert.equal(initial.version, "v1");
    assert.equal(initial.repeated, false);
    await clean(f);
    const repeat = await installRelease(a.options, f.deps(a));
    assert.equal(repeat.repeated, true);
    await clean(f);
    const b = await f.release("v2");
    const upgraded = await installRelease(b.options, f.deps(b));
    assert.equal(upgraded.previous, "v1");
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/v2/TmuxIDE.app");
    assert.equal(
      await readFile(join(f.installRoot, "versions/v1/TmuxIDE.app/Contents/version"), "utf8"),
      "v1",
    );
    assert.deepEqual(
      f.calls.map((c) => c.version),
      ["v1", "v1", "v2"],
    );
    await clean(f);
  });
});
test("authentication, platform, policy and path overlap refuse before fetching or creating installs", async () => {
  await fixture(async (f) => {
    const r = await f.release("v1");
    let calls = 0;
    const noFetch = async () => {
      calls++;
      throw new Error("unexpected fetch");
    };
    for (const [overrides, deps] of [
      [{ signature: Buffer.alloc(64) }, {}],
      [{}, { platform: "linux" }],
      [{ applePolicy: { ...applePolicy, architecture: "x86_64" } }, {}],
      [{ installRoot: f.destinationRoot }, {}],
      [{ installRoot: join(f.destinationRoot, "inside") }, {}],
      [{ destinationRoot: f.root, installRoot: f.installRoot }, {}],
      [{ installRoot: join(f.root, "missing", "child") }, {}],
    ])
      await assert.rejects(
        installRelease(
          { ...r.options, ...overrides },
          { ...f.deps(r), ...deps, fetchImpl: noFetch },
        ),
      );
    assert.equal(calls, 0);
    await clean(f);
    await assert.rejects(lstat(f.installRoot), { code: "ENOENT" });
  });
});
test("malformed archive, version mismatch, verifier denial and cancellation preserve prior current", async () => {
  await fixture(async (f) => {
    const initial = await f.release("v1");
    await installRelease(initial.options, f.deps(initial));
    const mismatch = await f.release("v2", "different");
    await assert.rejects(installRelease(mismatch.options, f.deps(mismatch)));
    const next = await f.release("v2");
    await assert.rejects(
      installRelease(
        next.options,
        f.deps(next, async () => false),
      ),
    );
    const controller = new AbortController();
    await assert.rejects(
      installRelease(
        { ...next.options, signal: controller.signal },
        f.deps(next, async () => {
          controller.abort();
          return true;
        }),
      ),
    );
    const malformed = Buffer.from("not gzip");
    const manifestBytes = createManifest({
      version: "v2",
      archiveSize: malformed.length,
      sha256: createHash("sha256").update(malformed).digest("hex"),
    });
    await assert.rejects(
      installRelease(
        { ...next.options, manifestBytes, signature: sign(null, manifestBytes, keys.privateKey) },
        { ...f.deps(next), fetchImpl: async () => new Response(malformed) },
      ),
    );
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/v1/TmuxIDE.app");
    assert.deepEqual((await readdir(join(f.installRoot, "versions"))).sort(), ["v1"]);
    await clean(f);
  });
});
test("caller mutation during fetch cannot change pinned version, Apple policy or paths", async () => {
  await fixture(async (f) => {
    const r = await f.release("v1"),
      original = f.deps(r);
    await installRelease(r.options, {
      ...original,
      fetchImpl: async (url, init) => {
        r.options.applePolicy.teamId = "WRONG00000";
        r.options.policy.expectedVersion = "v2";
        r.options.policy.publicKey = Buffer.alloc(32);
        r.options.installRoot = join(f.root, "other");
        r.options.manifestBytes.fill(0);
        r.options.signature.fill(0);
        return new Response(r.archive);
      },
    });
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/v1/TmuxIDE.app");
    await clean(f);
  });
});
test("cleanup failure after activation reports active release without implying rollback", async () => {
  await fixture(async (f) => {
    const r = await f.release("v1");
    let moved;
    await assert.rejects(
      installRelease(
        r.options,
        f.deps(r, async () => {
          const entry = (await readdir(f.destinationRoot)).find((n) =>
            n.startsWith("gpui-extract-"),
          );
          moved = join(f.root, "moved-owned-extraction");
          await rename(join(f.destinationRoot, entry), moved);
          return true;
        }),
      ),
      (error) => {
        assert.equal(error.activationState, "confirmed");
        assert.match(error.message, /not rolled back/);
        assert.ok(error instanceof AggregateError);
        assert.equal(error.installed.version, "v1");
        return true;
      },
    );
    assert.equal(await readlink(join(f.installRoot, "current")), "versions/v1/TmuxIDE.app");
    await rm(moved, { recursive: true });
    await clean(f);
  });
});
test("original verifier failure and independent cleanup failures are both retained", async () => {
  await fixture(async (f) => {
    const r = await f.release("v1");
    const sentinel = new Error("test verifier denial");
    let moved;
    await assert.rejects(
      installRelease(
        r.options,
        f.deps(r, async () => {
          const entry = (await readdir(f.destinationRoot)).find((n) =>
            n.startsWith("gpui-extract-"),
          );
          moved = join(f.root, "moved-failed-extraction");
          await rename(join(f.destinationRoot, entry), moved);
          throw sentinel;
        }),
      ),
      (error) => {
        assert.equal(error.activationState, "unknown");
        assert.equal(error.errors[0], sentinel);
        assert.ok(error.errors.length >= 2);
        return true;
      },
    );
    await assert.rejects(readlink(join(f.installRoot, "current")), { code: "ENOENT" });
    await rm(moved, { recursive: true });
    await clean(f);
  });
});
