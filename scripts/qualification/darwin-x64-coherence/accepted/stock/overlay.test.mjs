import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, assertArtifact, sha } from "./admission.mjs";
import { createOwnedHarness } from "./owned-harness.mjs";
test("artifact admission rejects changed bytes and symlink substitution", () => {
  const root = mkdtempSync(join(tmpdir(), "coherence-admit-"));
  try {
    const p = join(root, "cli");
    writeFileSync(p, "original");
    const hash = sha(p);
    assertArtifact(p, hash);
    writeFileSync(p, "changed");
    assert.throws(() => assertArtifact(p, hash));
    symlinkSync(p, join(root, "link"));
    assert.throws(() => assertArtifact(join(root, "link"), sha(p)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture({ listFail = false } = {}) {
  const child = new EventEmitter();
  child.pid = 999;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let live = true,
    signals = [];
  child.kill = (s) => {
    signals.push(s);
    live = false;
    child.emit("close", 0);
  };
  const h = createOwnedHarness(
    { command: "unused", args: [] },
    async () => (live ? "original" : null),
    {
      spawn: () => child,
      list: async () => {
        if (listFail) throw Error("capture failure");
        return [{ pid: 999, ppid: 1 }];
      },
      signal: () => assert.fail("unexpected descendant signal"),
    },
  );
  return {
    h,
    child,
    signals,
    exit: () => {
      live = false;
      child.emit("close", 0);
    },
  };
}
test("early child close does not schedule any later escalation and stop is idempotent", async () => {
  const f = fixture();
  await f.h.capture();
  f.exit();
  await f.h.stop();
  await f.h.stop();
  assert.deepEqual(f.signals, []);
});
test("capture refusal still retires exact child and reports uncertain cleanup", async () => {
  const f = fixture({ listFail: true });
  await assert.rejects(f.h.capture());
  await assert.rejects(f.h.stop());
  assert.deepEqual(f.signals, ["SIGTERM"]);
});
test("owned output capture stays bounded while retirement remains available", async () => {
  const f = fixture();
  f.child.stdout.emit("data", Buffer.alloc(100000, 120));
  assert.equal(Buffer.byteLength(f.h.output()), 65536);
  await f.h.capture();
  await f.h.stop();
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("sealed admission rejects source generation drift and wrong CLI hash before fixture allocation", () => {
  const descriptor = JSON.parse(readFileSync(new URL("./admission.json", import.meta.url)));
  const root = mkdtempSync(join(tmpdir(), "coherence-generation-"));
  try {
    for (const change of [{ commit: "0".repeat(40) }, { cliSha256: "0".repeat(64) }]) {
      const path = join(root, "admission.json");
      writeFileSync(path, JSON.stringify({ ...descriptor, ...change }), { mode: 0o600 });
      assert.throws(() => admit(path));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "reused descendant incarnation refuses cleanup without signaling replacement",
  { timeout: 5000 },
  async () => {
    const child = new EventEmitter();
    child.pid = 900;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let live = true,
      descendant = "old";
    const sent = [];
    child.kill = () => {
      live = false;
      child.emit("close", 0);
    };
    const h = createOwnedHarness(
      { command: "unused", args: [] },
      async (pid) => (pid === 900 ? (live ? "root" : null) : descendant),
      {
        spawn: () => child,
        list: async () => [
          { pid: 900, ppid: 1 },
          { pid: 901, ppid: 900 },
        ],
        signal: (...args) => sent.push(args),
      },
    );
    await h.capture();
    descendant = "replacement";
    await assert.rejects(h.stop());
    assert.deepEqual(sent, []);
  },
);
