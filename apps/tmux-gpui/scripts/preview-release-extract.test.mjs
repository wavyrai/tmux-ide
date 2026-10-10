import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { createManifest } from "./preview-release-manifest.mjs";
import { extractArchive } from "./preview-release-extract.mjs";
const keys = generateKeyPairSync("ed25519");
const policy = {
  publicKey: keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32),
  expectedVersion: "test-1",
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-extract-test-")));
  const input = join(root, "input"),
    destination = join(root, "destination");
  await mkdir(join(input, "TmuxIDE.app/Contents/MacOS"), { recursive: true });
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, "unrelated"), "keep");
  await writeFile(join(input, "TmuxIDE.app/Contents/MacOS/test"), "synthetic executable bytes", {
    mode: 0o755,
  });
  await writeFile(join(input, "TmuxIDE.app/Contents/Info.plist"), "synthetic metadata", {
    mode: 0o644,
  });
  const tar = async () => {
    const path = join(root, "source.tar");
    execFileSync("/usr/bin/tar", ["--format=ustar", "-cf", path, "-C", input, "TmuxIDE.app"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      timeout: 5000,
      maxBuffer: 65536,
    });
    return readFile(path);
  };
  let sequence = 0;
  const archive = async (tarBytes, compressed = gzipSync(tarBytes)) => {
    const archivePath = join(root, `archive-${sequence++}.tar.gz`);
    await writeFile(archivePath, compressed, { mode: 0o600 });
    const manifestBytes = createManifest({
      version: policy.expectedVersion,
      archiveSize: compressed.length,
      sha256: createHash("sha256").update(compressed).digest("hex"),
    });
    return {
      archivePath,
      manifestBytes,
      signature: sign(null, manifestBytes, keys.privateKey),
      policy,
      destinationRoot: destination,
    };
  };
  try {
    await run({ root, input, destination, tar, archive });
    assert.equal(await readFile(join(destination, "unrelated"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const empty = async (destination) => assert.deepEqual(await readdir(destination), ["unrelated"]);
const headers = (tar) => {
  const result = [];
  let offset = 0;
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    result.push(offset);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return { entries: result, end: offset };
};
function checksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((a, b) => a + b, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return header;
}
function renamed(header, name) {
  header.fill(0, 0, 100);
  header.write(name, 0, "utf8");
  return checksum(header);
}
async function rejected(f, tar, pattern) {
  const options = await f.archive(tar);
  const before = await readFile(options.archivePath);
  await assert.rejects(extractArchive(options), pattern ?? /Archive extraction/);
  assert.deepEqual(await readFile(options.archivePath), before);
  await empty(f.destination);
}
test("system USTAR nested app extracts exact bytes and normalized permissions", async () => {
  await fixture(async (f) => {
    const options = await f.archive(await f.tar());
    const result = await extractArchive(options);
    assert.equal(
      await readFile(join(result.appPath, "Contents/MacOS/test"), "utf8"),
      "synthetic executable bytes",
    );
    assert.equal(
      await readFile(join(result.appPath, "Contents/Info.plist"), "utf8"),
      "synthetic metadata",
    );
    assert.equal((await lstat(result.stagingRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(result.appPath)).mode & 0o777, 0o755);
    assert.equal((await lstat(join(result.appPath, "Contents/MacOS/test"))).mode & 0o777, 0o755);
    assert.equal((await lstat(join(result.appPath, "Contents/Info.plist"))).mode & 0o777, 0o644);
    await rm(result.stagingRoot, { recursive: true });
  });
});
test("signature/digest failure happens before any extraction, preserving archive and unrelated data", async () => {
  await fixture(async (f) => {
    const options = await f.archive(await f.tar());
    await assert.rejects(
      extractArchive({ ...options, signature: Buffer.alloc(64), archivePath: "/nonexistent" }),
      /authentication/,
    );
    await empty(f.destination);
    const damaged = await readFile(options.archivePath);
    damaged[15] ^= 1;
    await writeFile(options.archivePath, damaged);
    await assert.rejects(extractArchive(options), /digest/);
    await empty(f.destination);
    const alias = join(f.root, "alias");
    await symlink(options.archivePath, alias);
    await assert.rejects(extractArchive({ ...options, archivePath: alias }));
    const hard = join(f.root, "hard");
    await link(options.archivePath, hard);
    await assert.rejects(extractArchive(options), /invalid compressed/);
    await empty(f.destination);
  });
});
test("unsafe names, duplicates, special modes, types and ancestor collisions are rejected", async () => {
  await fixture(async (f) => {
    const original = await f.tar(),
      root = original.subarray(0, 512);
    for (const name of [
      "Other.app/",
      "/TmuxIDE.app/",
      "TmuxIDE.app/../outside/",
      "TmuxIDE.app/./x/",
      "TmuxIDE.app//x/",
      "TmuxIDE.app\\x/",
      "TmuxIDE.app/line\n/",
      "TmuxIDE.app/line\u0085/",
      "TmuxIDE.app/café/",
      "TmuxIDE.app/cafe\u0301/",
    ]) {
      const copy = Buffer.from(original);
      renamed(copy.subarray(0, 512), name);
      await rejected(f, copy, /path/);
    }
    await rejected(f, Buffer.concat([root, root, Buffer.alloc(1024)]), /duplicate/);
    const upper = renamed(Buffer.from(root), "TmuxIDE.app/Foo/");
    const lower = renamed(Buffer.from(root), "TmuxIDE.app/foo/");
    await rejected(f, Buffer.concat([root, upper, lower, Buffer.alloc(1024)]), /aliased/);
    for (const type of ["1", "2", "3", "4", "6", "x", "g", "L", "K"]) {
      const copy = Buffer.from(original);
      copy[156] = type.charCodeAt(0);
      checksum(copy.subarray(0, 512));
      await rejected(f, copy, /type/);
    }
    const special = Buffer.from(original);
    special.write("0004755\0", 100, "ascii");
    checksum(special.subarray(0, 512));
    await rejected(f, special, /mode/);
    const file = renamed(Buffer.from(root), "TmuxIDE.app/file");
    file[156] = 48;
    checksum(file);
    const child = renamed(Buffer.from(root), "TmuxIDE.app/file/child/");
    await rejected(f, Buffer.concat([root, file, child, Buffer.alloc(1024)]), /parent/);
    await symlink("Info.plist", join(f.input, "TmuxIDE.app/Contents/link"));
    await rejected(f, await f.tar(), /type/); // Real system tar symlink representation.
  });
});
test("corrupt headers, unsupported formats/numbers, truncation and nonzero trailing data fail", async () => {
  await fixture(async (f) => {
    const tar = await f.tar(),
      { entries, end } = headers(tar);
    const badsum = Buffer.from(tar);
    badsum[10] ^= 1;
    await rejected(f, badsum, /checksum/);
    for (const edit of [
      (b) => {
        b[124] = 128;
      },
      (b) => {
        b.write("00000000009\0", 124, "ascii");
      },
      (b) => {
        b[257] = 88;
      },
      (b) => {
        b[263] = 49;
      },
    ]) {
      const b = Buffer.from(tar);
      edit(b);
      checksum(b.subarray(0, 512));
      await rejected(f, b);
    }
    await rejected(f, tar.subarray(0, 510), /truncated/);
    const fileOffset = entries.find(
      (offset) =>
        tar[offset + 156] === 48 &&
        Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8) > 0,
    );
    await rejected(f, tar.subarray(0, fileOffset + 514), /truncated/);
    await rejected(f, tar.subarray(0, end + 512), /truncated/);
    const trailing = Buffer.concat([tar.subarray(0, end + 1024), Buffer.from("nonzero")]);
    await rejected(f, trailing, /trailing/);
    const between = Buffer.from(tar);
    between[end + 512] = 1;
    await rejected(f, between, /second end/);
    const gzip = gzipSync(tar);
    const options = await f.archive(tar, gzip.subarray(0, gzip.length - 5));
    await assert.rejects(extractArchive(options));
    await empty(f.destination);
  });
});
test("cancellation before and during extraction removes only owned staging", async () => {
  await fixture(async (f) => {
    await writeFile(join(f.input, "TmuxIDE.app/large"), Buffer.alloc(8 * 1024 * 1024));
    const options = await f.archive(await f.tar());
    await assert.rejects(extractArchive({ ...options, signal: AbortSignal.abort() }), /cancelled/);
    const controller = new AbortController();
    let observed = false;
    const timer = setInterval(() => {
      const owned = readdirSync(f.destination).find((name) => name.startsWith("gpui-extract-"));
      if (owned) {
        try {
          if (statSync(join(f.destination, owned, "TmuxIDE.app/large")).size > 0) {
            observed = true;
            controller.abort();
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }, 1);
    try {
      await assert.rejects(extractArchive({ ...options, signal: controller.signal }), /cancelled/);
    } finally {
      clearInterval(timer);
    }
    assert.equal(observed, true);
    await empty(f.destination);
  });
});
