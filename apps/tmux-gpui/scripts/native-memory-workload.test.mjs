import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PHASES,
  LIMITS,
  limitsFor,
  phaseAt,
  workloadTick,
  imageBytes,
} from "./native-memory-workload.mjs";
import { sampleOwnedRss, sampleOwnedMemory } from "./native-memory-sampling.mjs";
test("bounded phases, image identities and data; reuse/idle do not retransmit pixels", () => {
  assert.equal(
    PHASES.reduce((n, p) => n + p.seconds, 0),
    191,
  );
  const identities = new Set();
  let bytes = 0;
  for (let t = 0; t < 191; t++) {
    const p = phaseAt(t),
      op = workloadTick(p.name, p.tick);
    if (op.image) {
      identities.add(`${op.image.id}:${op.image.variant}`);
      bytes += op.image.bytes;
    }
    if (["baseline", "idle"].includes(p.name)) assert.equal(op.chunks.length, 0);
    if (p.name === "reuse") assert.ok(op.chunks.every((c) => !c.includes("f=32")));
  }
  assert.equal(identities.size, 36);
  assert.equal(bytes, 60 * 64 * 64 * 4);
  assert.equal(phaseAt(191).name, "complete");
  assert.equal(workloadTick("delete", 0).chunks.length, LIMITS.images);
  assert.throws(() => imageBytes(13, 0));
  assert.throws(() => workloadTick("reuse", 601));
});
test("Kitty multipart payload reconstructs exact bounded RGBA bytes", () => {
  const chunks = workloadTick("images-and-history", 0).chunks.filter(
    (c) => c.startsWith("\x1b_G") && c.includes(";"),
  );
  const data = chunks.map((c) => c.slice(c.indexOf(";") + 1, -2)).join("");
  assert.deepEqual(Buffer.from(data, "base64"), imageBytes(1, 0));
  assert.ok(chunks.every((c) => c.slice(c.indexOf(";") + 1, -2).length <= 4096));
  assert.ok(chunks.at(-1).includes("m=0;"));
});
test("full-HD profile reconstructs complete multipart images and bounds retained variants", () => {
  const limits = limitsFor("hd");
  assert.equal(limits.images * limits.variants * limits.width * limits.height * 4, 49_766_400);
  const op = workloadTick("images-and-history", 59, "hd");
  assert.deepEqual(op.image, { id: 3, variant: 1, bytes: 8_294_400 });
  const chunks = op.chunks.filter((c) => c.startsWith("\x1b_G") && c.includes(";"));
  const payload = chunks.map((c) => c.slice(c.indexOf(";") + 1, -2)).join("");
  assert.deepEqual(Buffer.from(payload, "base64"), imageBytes(3, 1, "hd"));
  assert.ok(chunks[0].includes("s=1920,v=1080"));
  assert.ok(chunks.at(-1).includes("m=0;"));
  assert.equal(workloadTick("delete", 0, "hd").chunks.length, 3);
  assert.throws(() => imageBytes(4, 0, "hd"));
  assert.throws(() => limitsFor("unbounded"));
});
test("RSS never reads replaced PID and refuses replacement during read", async () => {
  let reads = 0,
    calls = 0;
  const rows = await sampleOwnedRss(
    [
      { name: "gui", pid: 123, identity: "old" },
      { name: "daemon", pid: 456, identity: "stable" },
    ],
    {
      identify: async (pid) =>
        pid === 123 ? "replacement" : ++calls === 1 ? "stable" : "replacement",
      readRss: async () => {
        reads++;
        return 2048;
      },
      now: () => 7,
    },
  );
  assert.equal(reads, 1);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["identity-unavailable", "invalidated"],
  );
  assert.ok(rows.every((r) => r.rssKiB === undefined));
});
test("successful RSS samples retain exact role PID and KiB units", async () => {
  assert.deepEqual(
    await sampleOwnedRss([{ name: "broker", pid: 3, identity: "a" }], {
      identify: async () => "a",
      readRss: async () => 1024,
      now: () => 8,
    }),
    [{ name: "broker", pid: 3, time: 8, status: "ok", rssKiB: 1024 }],
  );
});

test("daemon memory retains only byte counters for the exact owned instance", async () => {
  const memory = { rss: 100, heapTotal: 80, heapUsed: 50, external: 20, arrayBuffers: 10 };
  const target = { name: "daemon", pid: 12, identity: "owned", instanceId: "instance" };
  const sample = await sampleOwnedMemory(target, {
    identify: async () => "owned",
    readDiagnostics: async () => ({
      pid: 12,
      daemon: { instanceId: "instance" },
      memory,
      private: "excluded",
    }),
    now: () => 9,
  });
  assert.deepEqual(sample, { name: "daemon", pid: 12, time: 9, status: "ok", memoryBytes: memory });
  for (const change of [
    { pid: 13 },
    { daemon: { instanceId: "replacement" } },
    { memory: { ...memory, heapUsed: -1 } },
    { memory: { ...memory, external: NaN } },
  ]) {
    const result = await sampleOwnedMemory(target, {
      identify: async () => "owned",
      readDiagnostics: async () => ({
        pid: 12,
        daemon: { instanceId: "instance" },
        memory,
        ...change,
      }),
    });
    assert.equal(result.status, "invalidated");
    assert.equal(result.memoryBytes, undefined);
  }
});

test("daemon memory rejects PID reuse before and during the diagnostic request", async () => {
  let reads = 0;
  const target = { name: "daemon", pid: 12, identity: "owned", instanceId: "instance" };
  const readDiagnostics = async () => {
    reads++;
    return {
      pid: 12,
      daemon: { instanceId: "instance" },
      memory: { rss: 1, heapTotal: 1, heapUsed: 1, external: 1, arrayBuffers: 1 },
    };
  };
  assert.equal(
    (await sampleOwnedMemory(target, { identify: async () => "replacement", readDiagnostics }))
      .status,
    "identity-unavailable",
  );
  assert.equal(reads, 0);
  let identities = 0;
  assert.equal(
    (
      await sampleOwnedMemory(target, {
        identify: async () => (++identities === 1 ? "owned" : "replacement"),
        readDiagnostics,
      })
    ).status,
    "invalidated",
  );
  assert.equal(reads, 1);
});
