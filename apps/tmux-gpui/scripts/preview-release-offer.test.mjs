import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { createManifest } from "./preview-release-manifest.mjs";
import { fetchReleaseOffer } from "./preview-release-offer.mjs";
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
const version = "preview-1";
const manifest = createManifest({ version, archiveSize: 123, sha256: "a".repeat(64) });
const signature = sign(null, manifest, keys.privateKey);
const options = {
  publicKey,
  expectedVersion: version,
  baseUrl: "https://fixture.invalid/releases/",
  redirectOrigins: [],
};
const replies =
  (bytes = manifest, sig = signature) =>
  async (url) =>
    new Response(url.endsWith(".sig") ? sig : bytes);
test("real loopback metadata stream authenticates exact bytes and pinned version directory", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.headers["accept-encoding"], "identity");
    assert.ok(
      [
        `/releases/${version}/update-manifest.json`,
        `/releases/${version}/update-manifest.sig`,
      ].includes(req.url),
    );
    res.writeHead(200);
    const b = req.url.endsWith(".sig") ? signature : manifest;
    res.write(b.subarray(0, 5));
    res.end(b.subarray(5));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const offer = await fetchReleaseOffer(options, {
      fetchImpl: (input, init) => {
        const url = new URL(input);
        assert.equal(url.origin, "https://fixture.invalid");
        assert.equal(init.redirect, "manual");
        return fetch(`http://127.0.0.1:${server.address().port}${url.pathname}`, init);
      },
    });
    assert.deepEqual(offer.manifestBytes, manifest);
    assert.deepEqual(offer.signature, signature);
    assert.equal(offer.baseUrl, `https://fixture.invalid/releases/${version}/`);
    assert.equal(offer.policy.expectedVersion, version);
    assert.ok(Object.isFrozen(offer));
    assert.equal(calls, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
test("invalid, oversized, mismatched or unauthenticated offers never return", async () => {
  for (const [bytes, sig] of [
    [Buffer.from("PRIVATE_RESPONSE{"), Buffer.alloc(64)],
    [Buffer.alloc(65537), signature],
    [manifest, Buffer.alloc(65)],
    [manifest, Buffer.alloc(63)],
    [manifest, Buffer.alloc(64)],
  ])
    await assert.rejects(
      fetchReleaseOffer(options, { fetchImpl: replies(bytes, sig) }),
      /^Error: Release offer unavailable or authentication refused$/,
    );
  await assert.rejects(
    fetchReleaseOffer({ ...options, expectedVersion: "other" }, { fetchImpl: replies() }),
  );
  const wrong = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "der" })
    .subarray(-32);
  await assert.rejects(
    fetchReleaseOffer({ ...options, publicKey: wrong }, { fetchImpl: replies() }),
  );
  for (const response of [
    () => new Response("private", { status: 403 }),
    () => new Response(manifest, { headers: { "content-encoding": "gzip" } }),
    () => new Response(manifest, { headers: { "content-length": "99999" } }),
  ])
    await assert.rejects(fetchReleaseOffer(options, { fetchImpl: async () => response() }));
});
test("trusted redirects permit signed queries; unsafe redirects/caps refuse and bodies cancel", async () => {
  let cancelled = 0,
    calls = 0;
  const redir = (location) =>
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { status: 302, headers: { location } },
    );
  const offer = await fetchReleaseOffer(
    { ...options, redirectOrigins: ["https://cdn.invalid"] },
    {
      fetchImpl: async (url) => {
        calls++;
        if (url.startsWith("https://fixture.invalid"))
          return redir(
            "https://cdn.invalid/" + (url.endsWith(".sig") ? "sig" : "json") + "?token=PRIVATE",
          );
        assert.equal(cancelled, calls / 2);
        return new Response(url.includes("/sig?") ? signature : manifest);
      },
    },
  );
  assert.equal(offer.policy.expectedVersion, version);
  for (const location of [
    "http://fixture.invalid/no",
    "https://foreign.invalid/no",
    "https://u:p@fixture.invalid/no",
    "https://fixture.invalid/no#secret",
  ])
    await assert.rejects(fetchReleaseOffer(options, { fetchImpl: async () => redir(location) }));
  calls = 0;
  await assert.rejects(
    fetchReleaseOffer(options, {
      fetchImpl: async () => {
        calls++;
        return redir("/again");
      },
    }),
  );
  assert.equal(calls, 4);
});
test("caller cancellation bounds stalled headers/body; common deadline covers both metadata requests", async (t) => {
  for (const body of [false, true]) {
    const c = new AbortController();
    let cancelled = false;
    await assert.rejects(
      fetchReleaseOffer(
        { ...options, signal: c.signal },
        {
          fetchImpl: async () => {
            setTimeout(() => c.abort(), 10);
            if (!body) return new Promise(() => {});
            return new Response(
              new ReadableStream({
                start(s) {
                  s.enqueue(new Uint8Array([1]));
                },
                cancel() {
                  cancelled = true;
                },
              }),
            );
          },
        },
      ),
    );
    if (body) assert.equal(cancelled, true);
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let enter;
  const ready = new Promise((done) => {
    enter = done;
  });
  const pending = fetchReleaseOffer(options, {
    fetchImpl: async (url) => {
      if (url.endsWith(".sig")) {
        enter();
        return new Promise(() => {});
      }
      return new Response(manifest);
    },
  });
  const rejected = assert.rejects(pending);
  await ready;
  t.mock.timers.tick(30000);
  await rejected;
  t.mock.timers.reset();
});
