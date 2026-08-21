import assert from "node:assert/strict";
import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DIAGNOSTIC_TAIL_MAX_BYTES,
  readBoundedDiagnosticTail,
} from "./bounded-diagnostic-tail.mjs";

test("reads a normal diagnostic artifact through its bounded fd tail", () => {
  const root = mkdtempSync(join(tmpdir(), "bounded-diagnostic-tail-"));
  const path = join(root, "performance.jsonl");
  try {
    writeFileSync(path, '{"phase":"ready"}\n', { mode: 0o600 });
    const result = readBoundedDiagnosticTail(path);
    assert.equal(result.available, true);
    assert.equal(result.text, '{"phase":"ready"}\n');
    assert.equal(result.truncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a huge sparse diagnostic reads only one bounded tail and never allocates its full size", () => {
  const hugeSize = 2 ** 40;
  const calls = { open: 0, stat: 0, read: [], allocate: [], close: 0 };
  const stat = { dev: 7, ino: 11, size: hugeSize, isFile: () => true };
  const result = readBoundedDiagnosticTail("/bounded/performance.jsonl", {
    openFile: (_path, flags) => {
      calls.open += 1;
      assert.equal(flags & constants.O_RDONLY, constants.O_RDONLY);
      if (constants.O_NOFOLLOW !== undefined)
        assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
      return 17;
    },
    statFile: () => {
      calls.stat += 1;
      return stat;
    },
    allocate: (length) => {
      calls.allocate.push(length);
      return Buffer.alloc(length);
    },
    readFile: (_descriptor, buffer, offset, length, position) => {
      calls.read.push({ length, position });
      buffer.fill(0x61, offset, offset + length);
      return length;
    },
    closeFile: () => {
      calls.close += 1;
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.bytesRead, DIAGNOSTIC_TAIL_MAX_BYTES);
  assert.equal(result.truncated, true);
  assert.deepEqual(calls.allocate, [DIAGNOSTIC_TAIL_MAX_BYTES]);
  assert.deepEqual(calls.read, [
    {
      length: DIAGNOSTIC_TAIL_MAX_BYTES,
      position: hugeSize - DIAGNOSTIC_TAIL_MAX_BYTES,
    },
  ]);
  assert.deepEqual(
    { open: calls.open, stat: calls.stat, close: calls.close },
    {
      open: 1,
      stat: 2,
      close: 1,
    },
  );
});

test("rejects a changed file identity after the bounded read", () => {
  let statCalls = 0;
  const result = readBoundedDiagnosticTail("/bounded/performance.jsonl", {
    openFile: () => 17,
    statFile: () => ({
      dev: 7,
      ino: statCalls++ === 0 ? 11 : 12,
      size: 4,
      isFile: () => true,
    }),
    readFile: (_descriptor, buffer) => {
      buffer.fill(0x61);
      return 4;
    },
    closeFile: () => undefined,
  });
  assert.deepEqual(result, {
    available: false,
    reason: "file-changed",
    text: "",
    bytesRead: 0,
  });
});
