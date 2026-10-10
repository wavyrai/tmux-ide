import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  readdir,
  lstat,
  rm,
  chmod,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createManifest } from "./preview-release-manifest.mjs";
import { downloadArchive } from "./preview-release-download.mjs";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const bytes = Buffer.from("synthetic-archive-bytes-only");
const version = "test-1";
const manifestBytes = createManifest({
  version,
  archiveSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const base = {
  manifestBytes,
  signature: sign(null, manifestBytes, keys.privateKey),
  policy: { publicKey, expectedVersion: version },
  baseUrl: "https://fixture.invalid/releases/",
  redirectOrigins: [],
};
async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gpui-download-test-")));
  await writeFile(join(root, "unrelated"), "keep", { mode: 0o600 });
  try {
    await run(root);
    assert.equal(await readFile(join(root, "unrelated"), "utf8"), "keep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const empty = async (root) => assert.deepEqual(await readdir(root), ["unrelated"]);
const reject = async (root, fetchImpl, overrides = {}, pattern = /Archive download/) => {
  await assert.rejects(
    downloadArchive({ ...base, destinationRoot: root, ...overrides }, { fetchImpl }),
    pattern,
  );
  await empty(root);
};
test("authentication precedes all fetch and directory mutation", async () => {
  await fixture(async (root) => {
    let calls = 0;
    await reject(
      root,
      async () => {
        calls++;
        throw new Error("PRIVATE_TOKEN");
      },
      { signature: Buffer.alloc(64) },
      /authentication/,
    );
    assert.equal(calls, 0);
    await assert.rejects(
      downloadArchive({ ...base, signature: Buffer.alloc(64), destinationRoot: "/nonexistent" }),
      /authentication/,
    );
  });
});
test("actual HTTP stream via exact test-origin rewrite verifies bytes and private staging", async () => {
  await fixture(async (root) => {
    let calls = 0;
    const expectedPath = `/releases/tmux-ide-gpui-${version}-macos-arm64.app.tar.gz`;
    const server = createServer((req, res) => {
      calls++;
      assert.equal(req.url, expectedPath);
      assert.equal(req.headers["accept-encoding"], "identity");
      res.writeHead(200, { "Content-Length": bytes.length, "Content-Encoding": "identity" });
      res.write(bytes.subarray(0, 7));
      res.end(bytes.subarray(7));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      const fetchImpl = (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://fixture.invalid");
        assert.equal(init.redirect, "manual");
        return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
      };
      const result = await downloadArchive({ ...base, destinationRoot: root }, { fetchImpl });
      assert.deepEqual(await readFile(result.archivePath), bytes);
      assert.equal(result.version, version);
      assert.ok(Object.isFrozen(result.asset));
      assert.equal((await lstat(result.archivePath)).mode & 0o777, 0o600);
      assert.equal((await lstat(result.stagingRoot)).mode & 0o077, 0);
      assert.equal(calls, 1);
      await rm(result.stagingRoot, { recursive: true }); // Successful staging belongs to caller.
      await empty(root);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });
});
test("truncated, excess, corrupt, encoded and HTTP failure bodies never survive", async () => {
  await fixture(async (root) => {
    for (const [body, init, pattern] of [
      [bytes.subarray(1), {}, /truncated/],
      [Buffer.concat([bytes, Buffer.from("x")]), {}, /exceeded/],
      [Buffer.alloc(bytes.length), {}, /digest/],
      [bytes, { headers: { "content-encoding": "gzip" } }, /encoded/],
      [bytes, { headers: { "content-length": "999" } }, /declared/],
      ["PRIVATE_TOKEN", { status: 403 }, /HTTP/],
    ])
      await reject(root, async () => new Response(body, init), {}, pattern);
    await reject(root, async () => new Response(null), {}, /missing/);
    await reject(
      root,
      async () => {
        throw new Error("PRIVATE_TOKEN https://secret.invalid/key");
      },
      {},
      /^Error: Archive download failed$/,
    );
  });
});
test("manual redirects cancel bodies, obey origin/HTTPS policy and stop after three", async () => {
  await fixture(async (root) => {
    let calls = 0,
      cancelled = 0;
    const redirect = (location) =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        { status: 302, headers: { location } },
      );
    const result = await downloadArchive(
      { ...base, destinationRoot: root, redirectOrigins: ["https://cdn.invalid"] },
      {
        fetchImpl: async (url) => {
          calls++;
          if (calls === 1) return redirect("https://cdn.invalid/archive?signature=test-only-token");
          assert.equal(cancelled, 1);
          assert.equal(url, "https://cdn.invalid/archive?signature=test-only-token");
          return new Response(bytes);
        },
      },
    );
    await rm(result.stagingRoot, { recursive: true });
    for (const location of [
      "http://fixture.invalid/no",
      "https://foreign.invalid/no",
      "https://user:secret@fixture.invalid/no",
      "https://fixture.invalid/no#fragment",
    ])
      await reject(root, async () => redirect(location));
    calls = 0;
    await reject(
      root,
      async () => {
        calls++;
        return redirect("/again");
      },
      {},
      /limit/,
    );
    assert.equal(calls, 4);
    let non200Cancelled = false;
    await reject(
      root,
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              non200Cancelled = true;
            },
          }),
          { status: 500 },
        ),
    );
    assert.equal(non200Cancelled, true);
  });
});
test("caller abort bounds stalled headers/body and removes partial files", async () => {
  await fixture(async (root) => {
    for (const bodyStage of [false, true]) {
      const abort = new AbortController();
      let cancelled = false;
      const fetchImpl = async () => {
        setTimeout(() => abort.abort(), 10);
        if (!bodyStage) return new Promise(() => {}); // Deliberately ignores signal.
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes.subarray(0, 3));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      };
      await reject(root, fetchImpl, { signal: abort.signal }, /cancelled/);
      if (bodyStage) assert.equal(cancelled, true);
    }
    const aborted = AbortSignal.abort();
    await reject(
      root,
      async () => {
        assert.fail("pre-aborted fetch must not run");
      },
      { signal: aborted },
      /cancelled/,
    );
    await reject(
      root,
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("PRIVATE_BODY"));
            },
          }),
        ),
      {},
      /^Error: Archive download failed$/,
    );
  });
});
test("unsafe destination and URL policy fail closed without network", async () => {
  await fixture(async (root) => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      assert.fail("invalid policy/root must not fetch");
    };
    for (const baseUrl of [
      "http://fixture.invalid/",
      "https://fixture.invalid/not-directory",
      "https://u:p@fixture.invalid/",
      "https://fixture.invalid/?secret=x",
    ])
      await reject(root, fetchImpl, { baseUrl });
    await reject(root, fetchImpl, { redirectOrigins: ["https://cdn.invalid/path"] });
    await reject(root, fetchImpl, { signal: {} }, /invalid cancellation signal/);
    await chmod(root, 0o755);
    await reject(root, fetchImpl, {}, /destination/);
    await chmod(root, 0o700);
    const link = root + "-link";
    await symlink(root, link);
    try {
      await assert.rejects(
        downloadArchive({ ...base, destinationRoot: link }, { fetchImpl }),
        /destination/,
      );
    } finally {
      await rm(link);
    }
    assert.equal(calls, 0);
  });
});
test("fixed 120-second deadline also rejects a transport ignoring its signal", async (t) => {
  await fixture(async (root) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const result = downloadArchive(
      { ...base, destinationRoot: root },
      {
        fetchImpl: () => {
          entered();
          return new Promise(() => {});
        },
      },
    );
    const rejected = assert.rejects(result, /deadline exceeded/);
    await ready;
    t.mock.timers.tick(120000);
    await rejected;
    t.mock.timers.reset();
    await empty(root);
  });
});
