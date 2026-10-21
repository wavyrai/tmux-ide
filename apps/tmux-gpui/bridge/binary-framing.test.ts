import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBinaryFrameParser,
  encodeBinaryFrame,
  encodeBinaryJson,
  decodeBinaryJson,
  encodeBinaryImage,
  decodeBinaryImage,
  MAX_BINARY_BODY,
} from "./binary-framing.ts";
const image = {
  digest: "a".repeat(32),
  format: "png" as const,
  width: 1,
  height: 1,
  total: 3,
  offset: 0,
};
test("every header/body split and one-byte input preserve exact frames", () => {
  const bytes = encodeBinaryJson({ text: "😀\n\ufeff" });
  for (let split = 0; split <= bytes.length; split++) {
    const frames: unknown[] = [];
    const parser = createBinaryFrameParser((f) => {
      frames.push(decodeBinaryJson(f.payload));
      return true;
    });
    parser.push(bytes.subarray(0, split));
    parser.push(bytes.subarray(split));
    parser.end();
    assert.deepEqual(frames, [{ text: "😀\n\ufeff" }]);
  }
  const frames: unknown[] = [];
  const parser = createBinaryFrameParser((f) => {
    frames.push(decodeBinaryJson(f.payload));
    return true;
  });
  for (const byte of Buffer.concat([bytes, bytes])) parser.push(Uint8Array.of(byte));
  parser.end();
  assert.equal(frames.length, 2);
});
test("backpressure accepts completed frame and never retains or replays caller remainder", () => {
  const a = encodeBinaryJson({ a: 1 }),
    b = encodeBinaryJson({ b: 2 });
  const input = Buffer.concat([a, b]);
  const frames: unknown[] = [];
  const parser = createBinaryFrameParser((f) => {
    frames.push(decodeBinaryJson(f.payload));
    return false;
  });
  const first = parser.push(input);
  assert.deepEqual(first, { consumed: a.length, blocked: true });
  assert.equal(parser.bufferedBytes, 0);
  assert.deepEqual(parser.push(input.subarray(first.consumed)), { consumed: 0, blocked: true });
  parser.resume();
  assert.equal(parser.push(input.subarray(first.consumed)).consumed, b.length);
  parser.end();
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
});
for (const [name, mutate] of [
  [
    "magic",
    (b: Buffer) => {
      b[0] = 0;
    },
  ],
  [
    "version",
    (b: Buffer) => {
      b[4] = 2;
    },
  ],
  [
    "type",
    (b: Buffer) => {
      b[5] = 255;
    },
  ],
  [
    "flags",
    (b: Buffer) => {
      b[7] = 1;
    },
  ],
  [
    "zero length",
    (b: Buffer) => {
      b.writeUInt32BE(0, 8);
    },
  ],
  [
    "oversize",
    (b: Buffer) => {
      b.writeUInt32BE(MAX_BINARY_BODY + 1, 8);
    },
  ],
] as const)
  test(`rejects ${name} before payload admission and retires`, () => {
    const data = encodeBinaryJson({ a: 1 });
    mutate(data);
    let calls = 0;
    const p = createBinaryFrameParser(() => {
      calls++;
      return true;
    });
    assert.throws(() => p.push(data.subarray(0, 12)));
    assert.equal(calls, 0);
    assert.throws(() => p.push(encodeBinaryJson({})), /retired/);
  });
test("every partial EOF rejects without delivering a partial frame", () => {
  const data = encodeBinaryJson({ text: "hello" });
  for (let n = 1; n < data.length; n++) {
    let calls = 0;
    const p = createBinaryFrameParser(() => {
      calls++;
      return true;
    });
    p.push(data.subarray(0, n));
    assert.throws(() => p.end(), /Truncated/);
    assert.equal(calls, 0);
  }
});
test("callback failure retires parser; input mutation cannot alter already-owned partial payload", () => {
  const p = createBinaryFrameParser(() => {
    throw new Error("sink failed");
  });
  assert.throws(() => p.push(encodeBinaryJson({})), /sink failed/);
  assert.throws(() => p.resume(), /retired/);
  const data = encodeBinaryJson({ text: "abc" }),
    expected = Buffer.from(data.subarray(12));
  let received: Uint8Array | undefined;
  const owned = createBinaryFrameParser((f) => {
    received = f.payload;
    return true;
  });
  owned.push(data.subarray(0, data.length - 1));
  data.fill(0, 12, data.length - 1);
  owned.push(data.subarray(data.length - 1));
  assert.deepEqual(received, expected);
});
test("image raw bytes and metadata preserve compressed formats without base64", () => {
  const bytes = encodeBinaryImage(
    { ...image, format: "rgba-zlib", image: "pane#1" },
    Uint8Array.of(0, 10, 255),
  );
  const parser = createBinaryFrameParser((f) => {
    assert.equal(f.type, 3);
    assert.deepEqual(decodeBinaryImage(f.payload), {
      metadata: { ...image, format: "rgba-zlib", image: "pane#1" },
      data: Buffer.from([0, 10, 255]),
    });
    return true;
  });
  parser.push(bytes);
  parser.end();
  assert.throws(() => encodeBinaryImage({ ...image, offset: 1 }, Uint8Array.of(1, 2, 3)));
  assert.throws(() => encodeBinaryImage(image, new Uint8Array(0)));
  const body = bytes.subarray(12);
  const bad = Buffer.from(body);
  bad.writeUInt32BE(4097);
  assert.throws(() => decodeBinaryImage(bad));
  assert.throws(() => decodeBinaryJson(Uint8Array.of(0xff)));
  assert.throws(() => decodeBinaryJson(Buffer.from("\ufeff{}")));
});
test("deterministic random fragmentation and corruption stay bounded and make progress", () => {
  let seed = 0x12345678;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let trial = 0; trial < 200; trial++) {
    const frames = Array.from({ length: 1 + (random() % 5) }, (_, i) =>
      encodeBinaryFrame(1, Buffer.from(JSON.stringify({ trial, i }))),
    );
    const data = Buffer.concat(frames);
    let seen = 0;
    const parser = createBinaryFrameParser(() => {
      seen++;
      return true;
    });
    for (let off = 0; off < data.length; ) {
      const n = Math.min(1 + (random() % 31), data.length - off);
      const result = parser.push(data.subarray(off, off + n));
      assert.equal(result.consumed, n);
      off += n;
      assert.ok(parser.bufferedBytes <= MAX_BINARY_BODY + 12);
    }
    parser.end();
    assert.equal(seen, frames.length);
    const junk = Buffer.alloc(64);
    for (let i = 0; i < junk.length; i++) junk[i] = random() & 255;
    const bad = createBinaryFrameParser(() => true);
    try {
      bad.push(junk);
      bad.end();
    } catch {
      /* deterministic malformed input is rejected */
    }
  }
});

test("shared framed JSON/image/publication vectors match transport headers", async () => {
  const { readFileSync } = await import("node:fs");
  const { decodeBinaryCellPublication } = await import("./binary-cell-rows.ts");
  const vectors = JSON.parse(
    readFileSync(new URL("./binary-vectors.json", import.meta.url), "utf8"),
  );
  for (const [kind, entries] of [
    [1, vectors.json],
    [2, vectors.publications],
    [3, vectors.images],
  ] as const) {
    for (const entry of entries) {
      const parser = createBinaryFrameParser((frame) => {
        assert.equal(frame.type, kind);
        if (kind === 1) assert.deepEqual(decodeBinaryJson(frame.payload), entry.value);
        else if (kind === 2)
          assert.deepEqual(decodeBinaryCellPublication(frame.payload), {
            publication: entry.publication,
            frame: entry.frame,
          });
        else {
          const image = decodeBinaryImage(frame.payload);
          assert.deepEqual(image.metadata, entry.metadata);
          assert.equal(Buffer.from(image.data).toString("hex"), entry.dataHex);
        }
        return true;
      });
      parser.push(Buffer.from(entry.hex, "hex"));
      parser.end();
    }
  }
});

test("image chunk maximum and exact frame boundary are enforced", () => {
  const data = Buffer.alloc(512 * 1024, 255),
    metadata = { ...image, total: data.length };
  const encoded = encodeBinaryImage(metadata, data);
  const parser = createBinaryFrameParser((frame) => {
    assert.equal(decodeBinaryImage(frame.payload).data.length, data.length);
    return true;
  });
  parser.push(encoded);
  parser.end();
  assert.throws(() =>
    encodeBinaryImage({ ...metadata, total: data.length + 1 }, Buffer.alloc(data.length + 1)),
  );
  const bytes = encodeBinaryFrame(1, Buffer.alloc(MAX_BINARY_BODY, 32));
  const bound = createBinaryFrameParser((frame) => {
    assert.equal(frame.payload.length, MAX_BINARY_BODY);
    return true;
  });
  bound.push(bytes);
  bound.end();
  assert.throws(() => encodeBinaryFrame(1, Buffer.alloc(MAX_BINARY_BODY + 1)));
});
